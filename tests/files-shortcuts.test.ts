import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace, AgentWorkplaceError } from "@agent-workplace/sdk";
import { setUploadPollInterval } from "../src/commands/files.js";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  setUploadPollInterval(2000);
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-files-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(credentials, (store) =>
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
  const run = async (arguments_: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(["--credentials", credentials, ...arguments_], {
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
  return { directory, workplaceId, run };
}

const lost = () =>
  new AgentWorkplaceError("Request failed", {
    status: 0,
    code: "network_error",
  });

test("files get accepts a bare file ID in the saved workplace", async () => {
  const f = await fixture();
  const fileId = randomUUID();
  const get = vi
    .spyOn(AgentWorkplace.prototype, "getFile")
    .mockRejectedValue(lost());
  const result = await f.run([
    ...["files", "get", fileId, "--output", join(f.directory, "out.txt")],
  ]);
  expect(result.code).toBe(1);
  expect(get).toHaveBeenCalledWith(
    { apiKey: "private" },
    expect.objectContaining({ workplaceId: f.workplaceId, fileId }),
  );
});

function pendingUpload(uploadId: string) {
  return {
    state: "pending",
    transferState: "open",
    uploadId,
    fileId: randomUUID(),
    revisionId: null,
    version: null,
  } as unknown as Awaited<ReturnType<AgentWorkplace["getFileUpload"]>>;
}

test("a pending upload explains how to follow it, and --wait follows it", async () => {
  const f = await fixture();
  const source = join(f.directory, "note.md");
  await writeFile(source, "# Note\n");
  const uploadId = randomUUID();
  vi.spyOn(AgentWorkplace.prototype, "uploadFileFromSource").mockResolvedValue(
    pendingUpload(uploadId) as never,
  );
  const upload = (name: string, ...extra: string[]) =>
    f.run([
      ...["files", "text", "--source-file", source, "--name", "note.md"],
      ...["--operation", join(f.directory, "ops", `${name}.json`), ...extra],
    ]);

  const hinted = await upload("hint");
  expect(hinted.code).toBe(0);
  expect(JSON.parse(hinted.stdout)).toMatchObject({ state: "pending" });
  expect(hinted.stderr).toBe(
    `Upload ${uploadId} is still being processed; check it with files status ${uploadId}, or rerun with --wait\n`,
  );
  // JSON output stays free of the hint.
  expect((await upload("json", "--json")).stderr).toBe("");

  setUploadPollInterval(5);
  const published = {
    ...pendingUpload(uploadId),
    state: "published",
  } as ReturnType<typeof pendingUpload>;
  const status = vi
    .spyOn(AgentWorkplace.prototype, "getFileUpload")
    .mockResolvedValueOnce(pendingUpload(uploadId))
    .mockResolvedValueOnce(published);
  expect(await upload("wait", "--wait", "--json")).toEqual({
    code: 0,
    stdout: `${JSON.stringify(published)}\n`,
    stderr: "",
  });
  expect(status).toHaveBeenCalledTimes(2);

  status.mockReset().mockResolvedValue(pendingUpload(uploadId));
  expect(await upload("timeout", "--wait", "1")).toEqual({
    code: 1,
    stdout: "",
    stderr: `Error: Upload ${uploadId} is still pending after 1 seconds; check it with files status ${uploadId}\n`,
  });
});

test("Files mutations retry with only --operation", async () => {
  const f = await fixture();
  const fileId = randomUUID(),
    version = randomUUID();
  const trash = vi
    .spyOn(AgentWorkplace.prototype, "changeFileTrash")
    .mockRejectedValueOnce(lost())
    .mockResolvedValueOnce({ state: "trashed" } as unknown as Awaited<
      ReturnType<AgentWorkplace["changeFileTrash"]>
    >);
  const operation = join(f.directory, "ops", "trash.json");
  expect(
    (
      await f.run([
        ...["files", "trash", fileId, "--expected-version", version],
        ...["--operation", operation],
      ])
    ).code,
  ).toBe(1);
  expect(
    await f.run(["files", "trash", "--operation", operation, "--json"]),
  ).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ state: "trashed" })}\n`,
    stderr: "",
  });
  expect(trash.mock.calls[1]?.[1]).toEqual(trash.mock.calls[0]?.[1]);
  // The saved intent belongs to trash, not to the other command.
  expect(
    await f.run(["files", "restore-trash", "--operation", operation]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: "Error: Use the original Files command to retry this operation\n",
  });

  const copy = vi
    .spyOn(AgentWorkplace.prototype, "beginFileCopy")
    .mockRejectedValueOnce(lost())
    .mockResolvedValueOnce({ state: "published" } as unknown as Awaited<
      ReturnType<AgentWorkplace["beginFileCopy"]>
    >);
  const copyOperation = join(f.directory, "ops", "copy.json");
  await f.run([
    ...["files", "copy", fileId, "--name", "copy.md"],
    ...["--revision", randomUUID(), "--operation", copyOperation],
  ]);
  expect(
    await f.run(["files", "copy", "--operation", copyOperation, "--json"]),
  ).toMatchObject({ code: 0, stderr: "" });
  expect(copy.mock.calls[1]?.[1]).toEqual(copy.mock.calls[0]?.[1]);

  expect(
    await f.run([
      ...["files", "purge", "--operation", join(f.directory, "ops", "new")],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "Error: A new Files deletion requires the file and --expected-version\n",
  });
});
