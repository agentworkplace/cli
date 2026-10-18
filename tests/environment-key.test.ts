import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const key = "environment-secret-key";
const accountId = "11111111-1111-4111-8111-111111111111";
const workplaceId = "22222222-2222-4222-8222-222222222222";
const account = {
  accountId,
  workplaceId,
  kind: "agent",
  role: "member",
  state: "active",
  workplaceState: "unconfirmed",
  cleanupAt: "2026-10-21T00:00:00.000Z",
  cleanupWarning: null,
  free: null,
  starter: {
    outboundLimit: 2,
    inboundLimit: 20,
    storageLimit: "100 MB",
    outboundUsed: 0,
    inboundUsed: 0,
    storageUsedBytes: 0,
  },
};
function notificationStatus(owner: string) {
  return Response.json({
    position: `np1.${owner}.3`,
    unreadCount: 1,
    oldestUnreadAt: "2026-10-07T00:00:00.000Z",
  });
}
const directories: string[] = [];
let home: string;

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "awp-environment-key-"));
  directories.push(path);
  return path;
}

beforeEach(async () => {
  // The implicit default file lives under HOME; it must stay untouched.
  home = await directory();
  vi.stubEnv("HOME", home);
  vi.stubEnv("AGENT_WORKPLACE_API_URL", undefined);
  vi.stubEnv("AGENT_WORKPLACE_CREDENTIALS_FILE", undefined);
  vi.stubEnv("AGENT_WORKPLACE_API_KEY", key);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function run(
  args: string[],
  respond: (path: string) => Response = (path) =>
    path === "/v1/access/account"
      ? Response.json(account)
      : notificationStatus(accountId),
) {
  let stdout = "",
    stderr = "";
  const origins: string[] = [];
  const requests: { path: string; authorization: string | null }[] = [];
  const code = await runCli(args, {
    version: "0.0.0",
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
    createProductClient: (baseUrl) => {
      origins.push(baseUrl);
      return new AgentWorkplace({
        baseUrl,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          requests.push({
            path,
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return respond(path);
        },
      });
    },
  });
  expect(stdout + stderr).not.toContain(key);
  return { code, stdout, stderr, origins, requests };
}

describe("AGENT_WORKPLACE_API_KEY", () => {
  it("authorizes against production without reading or creating the default file", async () => {
    const result = await run(["account-status", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ accountId, workplaceId });
    expect(result.origins).toEqual(["https://api.agentworkplace.dev"]);
    expect(result.requests).toEqual([
      { path: "/v1/access/account", authorization: `Bearer ${key}` },
    ]);
    expect(await readdir(home)).toEqual([]);
  });

  it("selects the origin from AGENT_WORKPLACE_API_URL and rejects insecure origins", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_URL", "https://api.example.test");
    const staging = await run(["account-status", "--json"]);
    expect(staging.code).toBe(0);
    expect(staging.origins).toEqual(["https://api.example.test"]);

    vi.stubEnv("AGENT_WORKPLACE_API_URL", "http://api.example.test");
    const insecure = await run(["account-status", "--json"]);
    expect(insecure.code).toBe(1);
    expect(insecure.origins).toEqual([]);
    expect(insecure.stderr).toContain("HTTPS API origin");
  });

  it.each([
    ["the flag", (file: string) => ["--credentials", file]],
    [
      "the environment",
      (file: string) => {
        vi.stubEnv("AGENT_WORKPLACE_CREDENTIALS_FILE", file);
        return [];
      },
    ],
  ])(
    "fails instead of choosing between it and a file from %s",
    async (_source, select) => {
      const file = join(await directory(), "credentials.json");
      await withCredentials(file, (store) =>
        store.write({
          version: 1,
          kind: "account",
          origin: "https://api.agentworkplace.dev",
          credential: { accountId, workplaceId, key: "file-key" },
        }),
      );
      for (const command of [["account-status"], ["notifications", "wait"]]) {
        const result = await run([...select(file), ...command, "--json"]);
        expect(result.code).toBe(1);
        expect(result.origins).toEqual([]);
        expect(JSON.parse(result.stderr)).toEqual({
          error: {
            message:
              "Choose either AGENT_WORKPLACE_API_KEY or a credential file, not both",
          },
        });
      }
    },
  );

  it.each([
    ["signup", "--name", "Agent", "--owner-email", "owner@example.test"],
    ["invitations", "join", "--invitation-file", "/missing/invitation.json"],
    ["invitations", "join", "--link-file", "/missing/invite-link.txt"],
    ["rotate-key", "--name", "Next"],
    ["create-key", "--name", "Runtime", "--save-to", "/missing/runtime.json"],
    ["recover-keys", "--name", "Runtime", "--save-to", "/missing/runtime.json"],
  ])("refuses %s, which saves credential state", async (...command) => {
    const result = await run([...command, "--json"]);
    expect(result.code).toBe(1);
    expect(result.origins).toEqual([]);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        message:
          "This command saves credential state; unset AGENT_WORKPLACE_API_KEY and use a credential file",
      },
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("binds notifications wait to the account-status identity", async () => {
    const result = await run(["notifications", "wait", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      position: `np1.${accountId}.3`,
      unreadCount: 1,
    });
    expect(result.requests.map(({ path }) => path)).toEqual([
      "/v1/access/account",
      "/v1/notifications/status",
    ]);

    const other = "33333333-3333-4333-8333-333333333333";
    const mismatch = await run(["notifications", "wait", "--json"], (path) =>
      path === "/v1/access/account"
        ? Response.json(account)
        : notificationStatus(other),
    );
    expect(mismatch.code).toBe(1);
    expect(JSON.parse(mismatch.stderr)).toEqual({
      error: {
        message: "Credential account does not match the notification response",
      },
    });
  });

  it("keeps the key out of API failure output", async () => {
    const result = await run(["account-status"], () =>
      Response.json(
        { error: { code: "access_denied", message: "Access denied" } },
        { status: 401 },
      ),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Error: .*HTTP 401/);
  });

  it("treats an empty value as unset", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_KEY", "");
    const result = await run(["account-status", "--json"]);
    expect(result.code).toBe(1);
    expect(result.origins).toEqual([]);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        message:
          "No saved credentials; save an account key or complete signup first",
      },
    });
  });
});
