import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentWorkplaceError } from "@agent-workplace/sdk";
import type { AgentWorkplace } from "@agent-workplace/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/program.js";
import type { RunCliOptions } from "../src/program.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const workplaceId = "22222222-2222-4222-8222-222222222222";

interface Invocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function invoke(
  arguments_: readonly string[],
  options: Partial<RunCliOptions> = {},
): Promise<Invocation> {
  let stdout = "";
  let stderr = "";

  const exitCode = await runCli(arguments_, {
    version: "0.0.0",
    ...options,
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  });

  return { exitCode, stdout, stderr };
}

beforeEach(() => {
  vi.stubEnv("AGENT_WORKPLACE_API_URL", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("agent-workplace CLI", () => {
  it.each([
    { args: [] },
    { args: ["--nomination-id", "1c9c6078-c31d-40a0-8452-43038dc056e9"] },
  ])(
    "retires ownership confirmation without touching stdin or a client (%j)",
    async ({ args }) => {
      const read = vi.fn(() => {
        throw new Error("stdin must not be opened");
      });
      const client = vi.fn(() => {
        throw new Error("client must not be created");
      });
      const result = await invoke(["confirm-ownership", ...args, "--json"], {
        input: { [Symbol.asyncIterator]: read },
        createProductClient: client,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        error: {
          message:
            "confirm-ownership is retired. Request a new ownership email with resend-nomination, then ask the nominated human to review and accept ownership using its private link. Do not ask them to share the link or a code. Check access status for completion.",
        },
      });
      expect(read).not.toHaveBeenCalled();
      expect(client).not.toHaveBeenCalled();
    },
  );
  it("prints help", async () => {
    const result = await invoke(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Usage: agent-workplace [options] [command]",
    );
    expect(result.stdout).toContain("account-status");
    expect(result.stdout).not.toMatch(/^\s+health\b/m);
    expect(result.stderr).toBe("");
  });

  it("prints the package version", async () => {
    await expect(invoke(["--version"])).resolves.toEqual({
      exitCode: 0,
      stdout: "0.0.0\n",
      stderr: "",
    });
  });

  describe("saved-credential presentation", () => {
    const origin = "https://staging-api.agentworkplace.dev";
    let directory: string;
    let credentials: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "awp-program-"));
      credentials = join(directory, "credentials.json");
      await writeFile(
        credentials,
        JSON.stringify({
          version: 1,
          kind: "account",
          origin,
          credential: { accountId, workplaceId, key: "fixture-key" },
        }),
        { mode: 0o600 },
      );
    });
    afterEach(() => rm(directory, { recursive: true, force: true }));

    function failingClient(failure: unknown) {
      const accountStatus = vi.fn(async () => {
        throw failure;
      });
      const createProductClient = vi.fn(
        () => ({ accountStatus }) as unknown as AgentWorkplace,
      );
      return { accountStatus, createProductClient };
    }
    const run = (
      createProductClient: RunCliOptions["createProductClient"],
      json: boolean,
    ) =>
      invoke(
        [
          "--credentials",
          credentials,
          "account-status",
          ...(json ? ["--json"] : []),
        ],
        { createProductClient },
      );

    it("does not retry production when the saved environment is unavailable", async () => {
      vi.stubEnv("AGENT_WORKPLACE_API_URL", origin);
      const client = failingClient(
        new AgentWorkplaceError("Unavailable", {
          status: 503,
          code: "service_unavailable",
        }),
      );
      await expect(run(client.createProductClient, true)).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr:
          '{"error":{"message":"Unavailable","status":503,"code":"service_unavailable"}}\n',
      });
      expect(client.createProductClient).toHaveBeenCalledExactlyOnceWith(
        origin,
      );
      expect(client.accountStatus).toHaveBeenCalledTimes(1);
    });

    it("presents SDK errors with established fields", async () => {
      const client = failingClient(
        new AgentWorkplaceError("Try again", {
          status: 503,
          code: "service_unavailable",
        }),
      );
      await expect(run(client.createProductClient, false)).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Error: Try again (HTTP 503, code: service_unavailable)\n",
      });
    });

    it("writes deterministic SDK errors as JSON", async () => {
      const client = failingClient(
        new AgentWorkplaceError("Invalid response", {
          status: 200,
          code: "invalid_response",
        }),
      );
      const result = await run(client.createProductClient, true);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        error: {
          message: "Invalid response",
          status: 200,
          code: "invalid_response",
        },
      });
    });

    it("does not expose unknown failure details", async () => {
      const client = failingClient(
        new TypeError("fetch failed with provider secret"),
      );
      await expect(run(client.createProductClient, true)).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: '{"error":{"message":"Unable to complete the request"}}\n',
      });
    });

    it.each(["relative/path", ""])(
      "rejects the environment URL %j before constructing a client",
      async (value) => {
        vi.stubEnv("AGENT_WORKPLACE_API_URL", value);
        const client = failingClient(new Error("Must not request"));
        await expect(run(client.createProductClient, true)).resolves.toEqual({
          exitCode: 1,
          stdout: "",
          stderr: '{"error":{"message":"Specify an absolute API origin"}}\n',
        });
        expect(client.createProductClient).not.toHaveBeenCalled();
      },
    );

    it("rejects the removed flag before constructing a client", async () => {
      const client = failingClient(new Error("Must not request"));
      const result = await invoke(
        ["--base-url", "https://option.example.com", "account-status"],
        { createProductClient: client.createProductClient },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown option '--base-url'");
      expect(client.createProductClient).not.toHaveBeenCalled();
    });
  });

  it("does not offer the internal health probe", async () => {
    const result = await invoke(["health", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'health'");
  });

  it("uses Commander syntax errors", async () => {
    const result = await invoke(["unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'unknown'");
  });
});
