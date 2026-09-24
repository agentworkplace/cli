import { AgentWorkplaceError } from "@agent-workplace/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/program.js";
import type { RunCliOptions } from "../src/program.js";

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent-workplace CLI", () => {
  it.each(["12345", "1234567", "123456\n654321", "x".repeat(65)])(
    "rejects malformed confirmation stdin without exposing it",
    async (input) => {
      const result = await invoke(
        [
          "confirm-ownership",
          "--nomination-id",
          "1c9c6078-c31d-40a0-8452-43038dc056e9",
          "--json",
        ],
        {
          input: (async function* () {
            yield input;
          })(),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        '{"error":{"message":"Expected one six-digit ownership code on standard input"}}\n',
      );
    },
  );
  it("prints help", async () => {
    const result = await invoke(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Usage: agent-workplace [options] [command]",
    );
    expect(result.stdout).toContain("health");
    expect(result.stderr).toBe("");
  });

  it("prints the package version", async () => {
    await expect(invoke(["--version"])).resolves.toEqual({
      exitCode: 0,
      stdout: "0.0.0\n",
      stderr: "",
    });
  });

  it("requires explicit API configuration", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_URL", undefined);

    await expect(invoke(["health"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "Error: API base URL is required. Pass --base-url or set AGENT_WORKPLACE_API_URL.\n",
    });
  });

  it("reports missing API configuration as JSON when requested", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_URL", undefined);

    await expect(invoke(["health", "--json"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        '{"error":{"message":"API base URL is required. Pass --base-url or set AGENT_WORKPLACE_API_URL."}}\n',
    });
  });

  it("uses the environment URL", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_URL", "https://environment.example.com");
    const createClient = vi.fn(() => ({
      health: vi.fn(async () => ({ status: "ok" as const })),
    }));

    const result = await invoke(["health"], { createClient });

    expect(createClient).toHaveBeenCalledWith(
      "https://environment.example.com",
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "Status: ok\n",
      stderr: "",
    });
  });

  it("prefers the CLI URL over the environment", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_URL", "https://environment.example.com");
    const createClient = vi.fn(() => ({
      health: vi.fn(async () => ({ status: "ok" as const })),
    }));

    await invoke(["health", "--base-url", "https://option.example.com"], {
      createClient,
    });

    expect(createClient).toHaveBeenCalledWith("https://option.example.com");
  });

  it("presents invalid base URLs safely", async () => {
    const result = await invoke(["health", "--base-url", "relative/path"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Error: Agent Workplace base URL must be an absolute URL\n",
    });
  });

  it("writes only human-readable output on success", async () => {
    const result = await invoke(
      ["health", "--base-url", "https://api.example.com"],
      {
        createClient: () => ({
          health: vi.fn(async () => ({ status: "ok" as const })),
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Status: ok\n",
      stderr: "",
    });
  });

  it("writes only valid JSON on success", async () => {
    const result = await invoke(
      ["health", "--json", "--base-url", "https://api.example.com"],
      {
        createClient: () => ({
          health: vi.fn(async () => ({ status: "ok" as const })),
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: '{"status":"ok"}\n',
      stderr: "",
    });
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok" });
  });

  it("presents SDK errors with established fields", async () => {
    const result = await invoke(
      ["health", "--base-url", "https://api.example.com"],
      {
        createClient: () => ({
          health: vi.fn(async () => {
            throw new AgentWorkplaceError("Try again", {
              status: 503,
              code: "service_unavailable",
            });
          }),
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Error: Try again (HTTP 503, code: service_unavailable)\n",
    });
  });

  it("writes deterministic SDK errors as JSON", async () => {
    const result = await invoke(
      ["health", "--json", "--base-url", "https://api.example.com"],
      {
        createClient: () => ({
          health: vi.fn(async () => {
            throw new AgentWorkplaceError("Invalid response", {
              status: 200,
              code: "invalid_response",
            });
          }),
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        '{"error":{"message":"Invalid response","status":200,"code":"invalid_response"}}\n',
    });
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        message: "Invalid response",
        status: 200,
        code: "invalid_response",
      },
    });
  });

  it("does not expose unknown failure details", async () => {
    const result = await invoke(
      ["health", "--json", "--base-url", "https://api.example.com"],
      {
        createClient: () => ({
          health: vi.fn(async () => {
            throw new TypeError("fetch failed with provider secret");
          }),
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":{"message":"Unable to complete the request"}}\n',
    });
    expect(result.stderr).not.toContain("provider secret");
  });

  it("uses Commander syntax errors", async () => {
    const result = await invoke(["unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'unknown'");
  });
});
