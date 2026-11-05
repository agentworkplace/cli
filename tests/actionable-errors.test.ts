import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AgentWorkplace,
  AgentWorkplaceError,
  AgentWorkplaceNetworkError,
} from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const id = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-errors-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://fixture.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  await writeFile(join(directory, "body.txt"), "Hello");
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
    mailbox: { mailboxId: id, accountId, address: "agent@example.test" },
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const run = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(["--credentials", credentials, ...args], {
      version: "0.0.0",
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    });
    return { code, stdout, stderr };
  };
  return { directory, run };
}

describe("refused requests name the next step", () => {
  const refused = (status: number, code: string) =>
    new AgentWorkplaceError("Mail operation rejected", { status, code });

  test.each([
    [401, "access_denied", "invalid or revoked"],
    [404, "not_found", "Check the ID"],
    [409, "conflict", "changed since you read it"],
  ])("HTTP %i %s", async (status, code, hint) => {
    const f = await fixture();
    vi.spyOn(AgentWorkplace.prototype, "getMailMessage").mockRejectedValue(
      refused(status, code),
    );
    const result = await f.run(["mail", "read", id, "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.hint).toContain(hint);
  });

  test("a refused saved operation points to a new file", async () => {
    const f = await fixture();
    vi.spyOn(AgentWorkplace.prototype, "sendMail").mockRejectedValue(
      refused(400, "invalid_input"),
    );
    const result = await f.run([
      "mail",
      "send",
      "--operation",
      join(f.directory, "private", "send.json"),
      "--to",
      "someone@example.test",
      "--subject",
      "Hello",
      "--body-file",
      join(f.directory, "body.txt"),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("use a new --operation path");
  });

  test("a rate limit is not told to change anything", async () => {
    const f = await fixture();
    vi.spyOn(AgentWorkplace.prototype, "sendMail").mockRejectedValue(
      refused(429, "rate_limited"),
    );
    const result = await f.run([
      "mail",
      "send",
      "--operation",
      join(f.directory, "private", "send.json"),
      "--to",
      "someone@example.test",
      "--subject",
      "Hello",
      "--body-file",
      join(f.directory, "body.txt"),
      "--json",
    ]);
    expect(JSON.parse(result.stderr).error).not.toHaveProperty("hint");
  });

  test("Chat creation names what it needs", async () => {
    const f = await fixture();
    vi.spyOn(
      AgentWorkplace.prototype,
      "createChatConversation",
    ).mockRejectedValue(refused(400, "invalid_input"));
    const result = await f.run([
      "chat",
      "create",
      "--operation",
      join(f.directory, "private", "chat.json"),
      "--account",
      id,
      "--json",
    ]);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      message:
        "Chat participants must be active agent accounts in this workplace",
      code: "invalid_input",
      status: 400,
    });
  });
});

test("a lost connection says the outcome is unknown and how to retry", async () => {
  const f = await fixture();
  vi.spyOn(AgentWorkplace.prototype, "sendMail").mockRejectedValue(
    new AgentWorkplaceNetworkError(),
  );
  const result = await f.run([
    "mail",
    "send",
    "--operation",
    join(f.directory, "private", "send.json"),
    "--to",
    "someone@example.test",
    "--subject",
    "Hello",
    "--body-file",
    join(f.directory, "body.txt"),
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error).toEqual({
    message:
      "Unable to reach Agent Workplace; the request may or may not have been received",
    code: "network_error",
    hint: "Retry with the same --operation, which can't apply twice",
  });
});

test("a local path failure names the path", async () => {
  const f = await fixture();
  vi.spyOn(AgentWorkplace.prototype, "getFile").mockRejectedValue(
    Object.assign(new Error("ENOENT: internal"), {
      code: "ENOENT",
      path: "/missing/output.bin",
    }),
  );
  const result = await f.run([
    "files",
    "get",
    id,
    "--output",
    join(f.directory, "out.bin"),
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error).toEqual({
    message: "No such file or directory: /missing/output.bin",
    code: "local_file",
  });
});

test("an unknown failure still has a code", async () => {
  const f = await fixture();
  vi.spyOn(AgentWorkplace.prototype, "getMailMessage").mockRejectedValue(
    new Error("private detail"),
  );
  const result = await f.run(["mail", "read", id, "--json"]);
  expect(JSON.parse(result.stderr).error).toEqual({
    message: "Unable to complete the request",
    code: "unexpected",
  });
});

test.each([
  [["--name", "a/b.txt"], "Invalid file name or destination"],
  [
    ["--name", "ok.txt", "--content-type", "not a type"],
    "Invalid media type; use type/subtype",
  ],
])("files put names its bad input %j", async (extra, message) => {
  const f = await fixture();
  const operation = join(f.directory, "private", "upload.json");
  const result = await f.run([
    "files",
    "put",
    "--source-file",
    join(f.directory, "body.txt"),
    "--operation",
    operation,
    ...extra,
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error).toEqual({
    message,
    code: "invalid_input",
  });
  await expect(stat(operation)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  [["files", "get", id, "--output", "-"]],
  [["files", "get-folder", id, "--output", "-", "--operation", "op.json"]],
  [["files", "export", "--output", "-", "--operation", "op.json"]],
  [["mail", "download", id, id, "--output", "-"]],
])("--output - is a usage error %j", async (args) => {
  const f = await fixture();
  const result = await f.run([...args, "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error).toMatchObject({
    code: "usage",
    message: expect.stringContaining("Use a file path"),
  });
});
