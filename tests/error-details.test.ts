import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace, AgentWorkplaceError } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function credentials() {
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-errors-"));
  directories.push(directory);
  const path = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(path, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  return path;
}

async function run(arguments_: string[]) {
  let stdout = "",
    stderr = "";
  const code = await runCli(arguments_, {
    version: "0.0.0",
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

const requestId = "0b9f6c1e-5d1a-4c7e-9f3b-2a8d4e6f1c3b";

test("API failures show the request ID, retry timing and missing scopes", async () => {
  const path = await credentials();
  vi.spyOn(AgentWorkplace.prototype, "listFiles").mockRejectedValue(
    new AgentWorkplaceError("Missing scope", {
      status: 403,
      code: "insufficient_scope",
      scopes: ["files:read"],
      retryAfterSeconds: 30,
      requestId,
    }),
  );
  expect(await run(["--credentials", path, "files", "list"])).toEqual({
    code: 1,
    stdout: "",
    stderr: [
      "Error: Missing scope (HTTP 403, code: insufficient_scope)",
      "Required scopes: files:read",
      "Retry after 30 seconds",
      `Request ID: ${requestId}`,
      "",
    ].join("\n"),
  });
  expect(
    JSON.parse(
      (await run(["--credentials", path, "files", "list", "--json"])).stderr,
    ),
  ).toEqual({
    error: {
      message: "Missing scope",
      status: 403,
      code: "insufficient_scope",
      requestId,
      retryAfterSeconds: 30,
      scopes: ["files:read"],
    },
  });
});

test("usage errors are JSON when --json is requested", async () => {
  expect(await run(["mail", "send", "--json"])).toEqual({
    code: 1,
    stdout: "",
    stderr: `${JSON.stringify({ error: { message: "required option '--operation <path>' not specified", code: "usage" } })}\n`,
  });
  expect(await run(["mail", "send"])).toEqual({
    code: 1,
    stdout: "",
    stderr: "error: required option '--operation <path>' not specified\n",
  });
  // A literal --json after the terminator is an argument, not the option.
  expect((await run(["role", "show", "--", "--json"])).stderr).not.toContain(
    '"code":"usage"',
  );
});
