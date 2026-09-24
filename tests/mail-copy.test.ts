import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace, prepareFileUpload } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "awp-mail-copy-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json"),
    operation = join(directory, "copy.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    mailboxId = randomUUID(),
    messageId = randomUUID(),
    attachmentId = randomUUID();
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  const status = {
    accountId,
    workplaceId,
    mailbox: { mailboxId, accountId, address: "example@mail.test" },
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>;
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue(status);
  const result = {
    state: "pending" as const,
    transferState: "open" as const,
    uploadId: randomUUID(),
    fileId: randomUUID(),
    revisionId: randomUUID(),
    version: null,
  };
  const start = vi
    .spyOn(AgentWorkplace.prototype, "copyMailAttachmentToFile")
    .mockImplementation(async (_auth, input, save) => {
      const { source, ...destination } = input;
      await save({
        version: 1,
        source,
        request: prepareFileUpload(
          { ...destination, contentType: "text/plain" },
          new TextEncoder().encode("abc"),
        ),
      });
      const saved = JSON.parse(await readFile(operation, "utf8"));
      expect(saved.origin).toBe("https://api.example.test");
      expect(saved.accountId).toBe(accountId);
      expect((await stat(operation)).mode & 0o777).toBe(0o600);
      return result;
    });
  const resume = vi
    .spyOn(AgentWorkplace.prototype, "resumeMailAttachmentFileCopy")
    .mockResolvedValue(result);
  const invoke = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      [
        "--credentials",
        credentials,
        "mail",
        "copy",
        "--operation",
        operation,
        "--json",
        ...args,
      ],
      {
        version: "0.0.0",
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      },
    );
    return { code, stdout, stderr };
  };
  return {
    invoke,
    operation,
    status,
    start,
    resume,
    result,
    messageId,
    attachmentId,
  };
}
test("saves private intent and retries without source arguments, preserving exact streams", async () => {
  const f = await setup();
  const expected = {
    code: 0,
    stdout: JSON.stringify(f.result) + "\n",
    stderr: "",
  };
  expect(
    await f.invoke([
      "--message",
      f.messageId,
      "--attachment",
      f.attachmentId,
      "--name",
      "chosen.txt",
    ]),
  ).toEqual(expected);
  const original = await readFile(f.operation, "utf8");
  expect(original).not.toContain("private");
  expect(await f.invoke([])).toEqual(expected);
  expect(await readFile(f.operation, "utf8")).toBe(original);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.resume.mock.calls[0]![1]).toEqual(JSON.parse(original).intent);
});
test("lost admission response leaves saved operation for a later invocation", async () => {
  const f = await setup();
  const save = f.start.getMockImplementation()!;
  f.start.mockImplementation(async (...args) => {
    await save(...args);
    throw new Error("lost response");
  });
  const first = await f.invoke([
    "--message",
    f.messageId,
    "--attachment",
    f.attachmentId,
    "--name",
    "chosen.txt",
  ]);
  expect(first.code).not.toBe(0);
  expect(first.stdout).toBe("");
  expect((await f.invoke([])).code).toBe(0);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledOnce();
});
test.each([
  "--message",
  "--attachment",
  "--mailbox",
  "--name",
  "--parent",
  "--file",
  "--expected-version",
])("rejects changed %s on saved operation", async (option) => {
  const f = await setup();
  await f.invoke([
    "--message",
    f.messageId,
    "--attachment",
    f.attachmentId,
    "--name",
    "chosen.txt",
  ]);
  const result = await f.invoke([option, randomUUID()]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("immutable");
  expect(f.resume).not.toHaveBeenCalled();
});
test("refuses a saved operation belonging to a different active account", async () => {
  const f = await setup();
  await f.invoke([
    "--message",
    f.messageId,
    "--attachment",
    f.attachmentId,
    "--name",
    "chosen.txt",
  ]);
  vi.mocked(AgentWorkplace.prototype.accountStatus).mockResolvedValue({
    ...f.status,
    accountId: randomUUID(),
  });
  const result = await f.invoke([]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(f.resume).not.toHaveBeenCalled();
});
test("requires explicit destination and source on first use", async () => {
  const f = await setup();
  const result = await f.invoke([]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("new copy requires");
  expect(f.start).not.toHaveBeenCalled();
});

test.each(["origin", "workplace"])(
  "rejects saved copy %s mismatch before recovery",
  async (field) => {
    const f = await setup();
    await f.invoke([
      "--message",
      f.messageId,
      "--attachment",
      f.attachmentId,
      "--name",
      "chosen.txt",
    ]);
    const saved = JSON.parse(await readFile(f.operation, "utf8"));
    if (field === "origin") saved.origin = "https://other.example.test";
    else saved.intent.request.workplaceId = randomUUID();
    await writeFile(f.operation, JSON.stringify(saved));
    const result = await f.invoke([]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("another server, workplace or account");
    expect(f.resume).not.toHaveBeenCalled();
  },
);

test("unsafe receipt appearing after source download prevents destination admission", async () => {
  const f = await setup();
  f.start.mockRestore();
  vi.spyOn(
    AgentWorkplace.prototype,
    "downloadMailAttachment",
  ).mockImplementation(async () => {
    await symlink("absent-target", f.operation);
    return {
      messageId: f.messageId,
      bytes: new TextEncoder().encode("abc"),
      attachment: {
        attachmentId: f.attachmentId,
        ordinal: 0,
        filename: null,
        contentType: "text/plain",
        disposition: null,
        contentId: null,
        state: "retained",
        bytes: 3,
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    };
  });
  const begin = vi
    .spyOn(AgentWorkplace.prototype, "beginFileUpload")
    .mockRejectedValue(new Error("Unexpected admission"));
  const result = await f.invoke([
    "--message",
    f.messageId,
    "--attachment",
    f.attachmentId,
    "--name",
    "chosen.txt",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(begin).not.toHaveBeenCalled();
});
