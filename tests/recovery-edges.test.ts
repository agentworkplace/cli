import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentWorkplace, type FileUploadStatus } from "@agent-workplace/sdk";
import { setUploadPollInterval } from "../src/commands/files.js";
import { readCredentials, withCredentials } from "../src/credentials.js";
import { canonicalFilePath } from "../src/private-file.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await chmod(path, 0o700).catch(() => {});
      await rm(path, { recursive: true, force: true });
    }),
  );
});

const mailboxId = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-edges-"));
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
    mailbox: { mailboxId, accountId, address: "agent@example.test" },
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const run = async (args: string[], credentialFile = credentials) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      ["--credentials", credentialFile, ...args, "--json"],
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
  return { directory, credentials, run };
}

function upload(state: string, transferState: string) {
  return {
    state,
    transferState,
    uploadId: randomUUID(),
    fileId: randomUUID(),
    revisionId: null,
    version: null,
  } as FileUploadStatus;
}

test.each(["planned", "creating"])(
  "--wait sends the bytes of a %s upload instead of only polling",
  async (transferState) => {
    const f = await fixture();
    setUploadPollInterval(1);
    const send = vi
      .spyOn(AgentWorkplace.prototype, "uploadFileFromSource")
      .mockResolvedValueOnce(upload("pending", transferState))
      .mockResolvedValueOnce(upload("published", "closed"));
    vi.spyOn(AgentWorkplace.prototype, "getFileUpload").mockResolvedValue(
      upload("pending", transferState),
    );
    const result = await f.run([
      "files",
      "text",
      "--source-file",
      join(f.directory, "body.txt"),
      "--operation",
      join(f.directory, "private", "upload.json"),
      "--name",
      "note.txt",
      "--wait",
    ]);
    expect(result.code).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.stdout).state).toBe("published");
  },
);

test("--wait leaves a transfer the service is finishing alone", async () => {
  const f = await fixture();
  setUploadPollInterval(1);
  const send = vi
    .spyOn(AgentWorkplace.prototype, "uploadFileFromSource")
    .mockResolvedValueOnce(upload("pending", "completing"));
  vi.spyOn(AgentWorkplace.prototype, "getFileUpload").mockResolvedValue(
    upload("published", "closed"),
  );
  const result = await f.run([
    "files",
    "text",
    "--source-file",
    join(f.directory, "body.txt"),
    "--operation",
    join(f.directory, "private", "upload.json"),
    "--name",
    "note.txt",
    "--wait",
  ]);
  expect(result.code).toBe(0);
  expect(send).toHaveBeenCalledOnce();
});

describe("Mailbox selection", () => {
  test.each([
    ["operations", ["mail", "operations"], "listMailOperations"],
    ["checkpoint", ["mail", "checkpoint"], "getMailCheckpoint"],
    ["changes", ["mail", "changes", "--cursor", "c"], "listMailChanges"],
  ] as const)("%s defaults to your own", async (_name, args, method) => {
    const f = await fixture();
    const call = vi
      .spyOn(AgentWorkplace.prototype, method as "listMailOperations")
      .mockResolvedValue({ operations: [], nextCursor: null } as never);
    const result = await f.run([...args]);
    expect(result.code).toBe(0);
    expect(call.mock.calls[0]![1]).toMatchObject({ mailboxId });
  });

  test("an uppercase --mailbox is accepted and normalized", async () => {
    const f = await fixture();
    const upper = "ABCDEF00-1111-4111-8111-111111111111";
    const send = vi
      .spyOn(AgentWorkplace.prototype, "sendMail")
      .mockResolvedValue({
        state: "queued",
      } as never);
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
      "--mailbox",
      upper,
    ]);
    expect(result.code).toBe(0);
    expect(send.mock.calls[0]![1].mailboxId).toBe(upper.toLowerCase());
  });
});

test("a missing body file says so", async () => {
  const f = await fixture();
  const missing = join(f.directory, "nope.txt");
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
    missing,
  ]);
  expect(JSON.parse(result.stderr).error.message).toBe(
    `Unable to read the Mail body file: ${missing}`,
  );
});

test("a chosen credential path that holds nothing is named", async () => {
  const f = await fixture();
  const chosen = join(f.directory, "nope.json");
  const result = await f.run(["mail", "address"], chosen);
  expect(JSON.parse(result.stderr).error.message).toContain(chosen);
});

describe("read-only credential storage", () => {
  test("still reads at once, and names the problem on a write", async () => {
    const f = await fixture();
    await chmod(f.directory, 0o500);
    const started = Date.now();
    const state = await readCredentials(f.credentials);
    expect(state?.credential?.key).toBe("private");
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(
      withCredentials(f.credentials, (store) => store.write(state!)),
    ).rejects.toThrow("read-only");
  });
});

test("an operation path may name directories that don't exist yet", async () => {
  const f = await fixture();
  const resolved = await canonicalFilePath(
    join(f.directory, "new", "deeper", "op.json"),
  );
  expect(resolved).toBe(
    join(await realpath(f.directory), "new", "deeper", "op.json"),
  );
});
