import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const accountId = "11111111-1111-4111-8111-111111111111";
const workplaceId = "22222222-2222-4222-8222-222222222222";
const position = `np1.${accountId}.1`;
const endpoint = {
  id: accountId,
  accountId,
  url: "https://receiver.example/private-hook",
  profile: { kind: "standard" },
  createdBy: accountId,
  createdAt: "2026-10-08T00:00:00.000Z",
  disabledAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
};
const endpointStatus = { position, unreadCount: 0, oldestUnreadAt: null };
const secret = `whsec_${"A".repeat(43)}=`;
async function run(args: string[], input?: AsyncIterable<string | Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), "awp-notifications-cli-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "fixture-key" },
    }),
  );
  let stdout = "",
    stderr = "";
  const calls: {
    path: string;
    body: unknown;
    method: string;
    query: Record<string, string>;
  }[] = [];
  const code = await runCli(
    ["--credentials", credentials, "notifications", ...args],
    {
      version: "0.0.0",
      input,
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
      createProductClient: (baseUrl) =>
        new AgentWorkplace({
          baseUrl,
          fetch: async (url, init) => {
            const path = new URL(String(url)).pathname;
            calls.push({
              path,
              body: init?.body ? JSON.parse(String(init.body)) : undefined,
              method: init?.method ?? "GET",
              query: Object.fromEntries(new URL(String(url)).searchParams),
            });
            if (path === "/v1/access/account")
              return Response.json({
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
              });
            if (path === "/v1/notifications/status")
              return Response.json({
                position,
                unreadCount: 1,
                oldestUnreadAt: "2026-10-07T00:00:00.000Z",
              });
            if (path === "/v1/notifications")
              return Response.json({ notifications: [], nextCursor: null });
            if (path === "/v1/notifications/read")
              return Response.json({ acknowledged: true });
            if (path === "/v1/notifications/endpoints") {
              if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                return Response.json(
                  {
                    endpoint: { ...endpoint, profile: body.profile },
                    ...(body.profile.kind === "standard" ? { secret } : {}),
                  },
                  { status: 201 },
                );
              }
              return Response.json({
                endpoints: [endpoint],
                status: endpointStatus,
              });
            }
            if (path === `/v1/notifications/endpoints/${accountId}`) {
              if (init?.method === "DELETE")
                return new Response(null, { status: 204 });
              return Response.json({ endpoint, status: endpointStatus });
            }
            if (path === `/v1/notifications/endpoints/${accountId}/test`)
              return Response.json(
                { accepted: true, testId: accountId },
                { status: 202 },
              );
            throw new Error("Unexpected fixture path");
          },
        }),
    },
  );
  return { stdout, stderr, code, calls };
}

test("wait emits exactly one status JSON line and exits without an account-status preflight", async () => {
  const result = await run(["wait", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    JSON.stringify({
      position,
      unreadCount: 1,
      oldestUnreadAt: "2026-10-07T00:00:00.000Z",
    }) + "\n",
  );
  expect(result.calls.map((call) => call.path)).toEqual([
    "/v1/notifications/status",
  ]);
});
test("read forwards the exact observed position and reports one acknowledgement", async () => {
  const result = await run(["read", "--all", "--through", position, "--json"]);
  expect(result).toMatchObject({
    code: 0,
    stdout: '{"acknowledged":true}\n',
    stderr: "",
  });
  expect(result.calls.at(-1)).toEqual({
    path: "/v1/notifications/read",
    body: { through: position },
    method: "POST",
    query: {},
  });
});

async function* stdin(value: string | Uint8Array) {
  yield value;
}
test("endpoint registration from stdin emits exactly one Standard secret response", async () => {
  const request = { url: endpoint.url, profile: { kind: "standard" } };
  const result = await run(
    ["endpoints", "register", "--file", "-", "--json"],
    stdin(JSON.stringify(request)),
  );
  expect(result).toMatchObject({
    code: 0,
    stdout: JSON.stringify({ endpoint, secret }) + "\n",
    stderr: "",
  });
  expect(result.calls.at(-1)).toMatchObject({
    path: "/v1/notifications/endpoints",
    method: "POST",
    body: request,
  });
});
test("endpoint registration reads a file without echoing the bearer token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awp-endpoint-input-"));
  directories.push(directory);
  const path = join(directory, "registration.json");
  const request = {
    url: endpoint.url,
    profile: { kind: "bearer" },
    token: "private-receiver-token",
    accountId,
  };
  await writeFile(path, JSON.stringify(request), { mode: 0o600 });
  const result = await run(["endpoints", "register", "--file", path, "--json"]);
  expect(result).toMatchObject({
    code: 0,
    stdout:
      JSON.stringify({ endpoint: { ...endpoint, profile: request.profile } }) +
      "\n",
    stderr: "",
  });
  expect(result.stdout).not.toContain(request.token);
  expect(result.calls.at(-1)?.body).toEqual(request);
});
test("endpoint list/inspect/remove preserve explicit account targets and exact JSON output", async () => {
  const listed = await run([
    "endpoints",
    "list",
    "--account",
    accountId,
    "--json",
  ]);
  expect(listed).toMatchObject({
    code: 0,
    stdout:
      JSON.stringify({ endpoints: [endpoint], status: endpointStatus }) + "\n",
    stderr: "",
  });
  const inspected = await run([
    "endpoints",
    "inspect",
    "--id",
    accountId,
    "--account",
    accountId,
    "--json",
  ]);
  expect(inspected).toMatchObject({
    code: 0,
    stdout: JSON.stringify({ endpoint, status: endpointStatus }) + "\n",
    stderr: "",
  });
  const removed = await run([
    "endpoints",
    "remove",
    "--id",
    accountId,
    "--account",
    accountId,
    "--json",
  ]);
  expect(removed).toMatchObject({
    code: 0,
    stdout: JSON.stringify({ removed: true, endpointId: accountId }) + "\n",
    stderr: "",
  });
  for (const result of [listed, inspected, removed])
    expect(result.calls.at(-1)?.query).toEqual({ accountId });
  expect(removed.calls.at(-1)?.method).toBe("DELETE");
});
test("registration input errors are bounded and do not disclose JSON fragments or file paths", async () => {
  for (const value of [
    "private-token-not-json",
    "x".repeat(8193),
    new Uint8Array([0xff]),
  ]) {
    const result = await run(
      ["endpoints", "register", "--file", "-", "--json"],
      stdin(value),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("valid UTF-8 JSON registration file");
    expect(result.stderr).not.toContain("private-token");
    expect(result.calls).toEqual([]);
  }
  const missing = await run([
    "endpoints",
    "register",
    "--file",
    "/nonexistent/private-token",
    "--json",
  ]);
  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).not.toContain("/nonexistent");
  const directory = await mkdtemp(join(tmpdir(), "awp-endpoint-invalid-file-"));
  directories.push(directory);
  const oversized = join(directory, "oversized.json");
  await writeFile(oversized, "x".repeat(8193));
  for (const path of [directory, oversized]) {
    const invalid = await run([
      "endpoints",
      "register",
      "--file",
      path,
      "--json",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).not.toContain(path);
    expect(invalid.calls).toEqual([]);
  }
});
test("read requires one explicit item or all target and prints no success on failure", async () => {
  const result = await run(["read", "--through", position, "--json"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Choose one notification ID or --all");
});

test("endpoint test prints only the acceptance receipt with an explicit target", async () => {
  const result = await run([
    "endpoints",
    "test",
    "--id",
    accountId,
    "--account",
    accountId,
    "--json",
  ]);
  expect(result).toMatchObject({
    code: 0,
    stdout: JSON.stringify({ accepted: true, testId: accountId }) + "\n",
    stderr: "",
  });
  expect(result.calls.at(-1)).toMatchObject({
    path: `/v1/notifications/endpoints/${accountId}/test`,
    method: "POST",
    query: { accountId },
  });
});
