import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "awp-files-cli-"));
  directories.push(dir);
  const credentials = join(dir, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(credentials, (s) =>
    s.write({
      version: 1,
      kind: "account",
      origin: "https://fixture.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const run = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      ["--credentials", credentials, "files", ...args, "--json"],
      {
        version: "0.0.0",
        writeOut: (v) => {
          stdout += v;
        },
        writeErr: (v) => {
          stderr += v;
        },
      },
    );
    return { code, stdout, stderr };
  };
  return { dir, run, accountId, workplaceId };
}
test("persists an immutable private upload before dispatch and hides bytes/grants", async () => {
  const f = await fixture(),
    source = join(f.dir, "source.txt"),
    operation = join(f.dir, "upload.json");
  await writeFile(source, "private content");
  const result = {
    state: "published" as const,
    uploadId: randomUUID(),
    fileId: randomUUID(),
    revisionId: randomUUID(),
    version: randomUUID(),
  };
  const send = vi
    .spyOn(AgentWorkplace.prototype, "uploadFileFromSource")
    .mockImplementation(async (_auth, request, source) => {
      expect(JSON.parse(await readFile(operation, "utf8")).request).toEqual(
        request,
      );
      expect(
        new TextDecoder().decode(await source.read(0, source.byteLength)),
      ).toBe("private content");
      return result;
    });
  expect(
    await f.run([
      "text",
      "--source-file",
      source,
      "--operation",
      operation,
      "--name",
      "shared.txt",
    ]),
  ).toEqual({ code: 0, stdout: JSON.stringify(result) + "\n", stderr: "" });
  expect((await stat(operation)).mode & 0o777).toBe(0o600);
  const saved = await readFile(operation, "utf8");
  expect(saved).not.toContain("private content");
  expect(saved).not.toContain('"private"');
  const repeat = await f.run([
    "text",
    "--source-file",
    source,
    "--operation",
    operation,
  ]);
  expect(repeat.code).toBe(0);
  expect(send.mock.calls[0]![1]).toEqual(send.mock.calls[1]![1]);
  const changed = await f.run([
    "text",
    "--source-file",
    source,
    "--operation",
    operation,
    "--name",
    "changed",
  ]);
  expect(changed.code).not.toBe(0);
  expect(changed.stdout).toBe("");
});
test("downloads only to a new private file and returns metadata without content", async () => {
  const f = await fixture(),
    fileId = randomUUID(),
    revisionId = randomUUID(),
    output = join(f.dir, "download.txt");
  const file = {
    workplaceId: f.workplaceId,
    fileId,
    revisionId,
    version: randomUUID(),
    name: "shared.txt",
    reference: `awp:file:${f.workplaceId}:${fileId}`,
    revisionReference: `awp:file:${f.workplaceId}:${fileId}:revision:${revisionId}`,
    byteLength: 6,
    contentType: "text/plain",
    sha256: "a".repeat(64),
    actorId: f.accountId,
    createdAt: new Date().toISOString(),
  };
  vi.spyOn(AgentWorkplace.prototype, "getFile").mockResolvedValue(file);
  vi.spyOn(AgentWorkplace.prototype, "downloadFileTo").mockImplementation(
    async (_auth, _ref, sink) => {
      await sink.write(new TextEncoder().encode("secret"), 0);
      await sink.checkpoint?.(6);
      return { file };
    },
  );
  const result = await f.run(["get", file.reference, "--output", output]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("secret");
  expect(await readFile(output, "utf8")).toBe("secret");
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  const repeated = await f.run(["get", file.reference, "--output", output]);
  expect(repeated.code).not.toBe(0);
  expect(repeated.stdout).toBe("");
  expect(await readFile(output, "utf8")).toBe("secret");
});

test("update version option dispatches instead of invoking the global version flag", async () => {
  const f = await fixture(),
    source = join(f.dir, "source.txt"),
    operation = join(f.dir, "update.json");
  await writeFile(source, "updated");
  const fileId = randomUUID(),
    version = randomUUID();
  const send = vi
    .spyOn(AgentWorkplace.prototype, "uploadFileFromSource")
    .mockResolvedValue({
      state: "conflict",
      uploadId: randomUUID(),
      fileId,
      revisionId: null,
      version: null,
    });
  const result = await f.run([
    "text",
    "--source-file",
    source,
    "--operation",
    operation,
    "--file",
    fileId,
    "--expected-version",
    version,
  ]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).state).toBe("conflict");
  expect(send.mock.calls[0]![1].target).toEqual({ fileId, version });
});

test("saves organization requests before dispatch and binds the original target", async () => {
  const f = await fixture(),
    operation = join(f.dir, "folder.json");
  const entryId = randomUUID(),
    version = randomUUID();
  const organize = vi
    .spyOn(AgentWorkplace.prototype, "organizeFiles")
    .mockImplementation(async (_auth, request) => {
      expect(JSON.parse(await readFile(operation, "utf8")).request).toEqual(
        request,
      );
      return {
        state: "applied",
        operationId: request.operationId,
        deleted: false,
        entry: {
          workplaceId: f.workplaceId,
          entryId,
          kind: "folder",
          parentId: null,
          name: "notes",
          version,
          actorId: f.accountId,
          changedAt: new Date().toISOString(),
          reference: `awp:folder:${f.workplaceId}:${entryId}`,
        },
      };
    });
  const args = [
    "folders",
    "create",
    "--name",
    "notes",
    "--operation",
    operation,
  ];
  expect((await f.run(args)).code).toBe(0);
  expect((await f.run(args)).code).toBe(0);
  expect(organize.mock.calls[0]![1]).toEqual(organize.mock.calls[1]![1]);
  expect((await stat(operation)).mode & 0o777).toBe(0o600);
  expect(
    (
      await f.run([
        "folders",
        "create",
        "--name",
        "changed",
        "--operation",
        operation,
      ])
    ).code,
  ).not.toBe(0);
  expect(organize).toHaveBeenCalledTimes(2);
});

test("persists and reuses a private restoration receipt and rejects changed input", async () => {
  const f = await fixture(),
    operation = join(f.dir, "restore.json"),
    file = randomUUID(),
    revision = randomUUID(),
    version = randomUUID();
  const restore = vi
    .spyOn(AgentWorkplace.prototype, "restoreFileRevision")
    .mockImplementation(async (_auth, request) => {
      expect(JSON.parse(await readFile(operation, "utf8")).request).toEqual(
        request,
      );
      return {
        state: "restored",
        operationId: request.operationId,
        fileId: file,
        restoredFromRevisionId: revision,
        revisionId: randomUUID(),
        version: randomUUID(),
        occurredAt: new Date().toISOString(),
      };
    });
  const args = [
    "restore",
    file,
    "--revision",
    revision,
    "--expected-version",
    version,
    "--operation",
    operation,
  ];
  expect((await f.run(args)).code).toBe(0);
  expect((await stat(operation)).mode & 0o777).toBe(0o600);
  expect((await f.run(args)).code).toBe(0);
  expect(restore.mock.calls[0]![1]).toEqual(restore.mock.calls[1]![1]);
  const changed = await f.run([
    "restore",
    file,
    "--revision",
    randomUUID(),
    "--expected-version",
    version,
    "--operation",
    operation,
  ]);
  expect(changed.code).not.toBe(0);
  expect(changed.stdout).toBe("");
  expect(restore).toHaveBeenCalledTimes(2);
  const request = restore.mock.calls[0]![1];
  const status = vi
    .spyOn(AgentWorkplace.prototype, "getFileRestoration")
    .mockResolvedValue({
      state: "evidence_expired",
      operationId: request.operationId,
    });
  expect(await f.run(["restore-status", "--operation", operation])).toEqual({
    code: 0,
    stderr: "",
    stdout:
      JSON.stringify({
        state: "evidence_expired",
        operationId: request.operationId,
      }) + "\n",
  });
  expect(status).toHaveBeenCalledTimes(1);
  const history = vi
    .spyOn(AgentWorkplace.prototype, "listFileRevisions")
    .mockResolvedValue({ revisions: [], nextCursor: null });
  expect((await f.run(["history", file, "--limit", "2"])).code).toBe(0);
  expect(history).toHaveBeenCalledWith(
    { apiKey: "private" },
    { workplaceId: f.workplaceId, fileId: file, after: undefined, limit: 2 },
  );
});

test("persists trash intent before dispatch and forbids changed replay destinations", async () => {
  const f = await fixture(),
    fileId = randomUUID(),
    version = randomUUID(),
    operation = join(f.dir, "trash.json");
  const result = {
    state: "restored" as const,
    operationId: randomUUID(),
    fileId,
    version: randomUUID(),
    occurredAt: "2026-09-17T00:00:00.000Z",
    trashExpiresAt: null,
  };
  const call = vi
    .spyOn(AgentWorkplace.prototype, "changeFileTrash")
    .mockImplementation(async (_auth, request) => {
      expect(JSON.parse(await readFile(operation, "utf8")).request).toEqual(
        request,
      );
      return result;
    });
  const args = [
    "restore-trash",
    fileId,
    "--expected-version",
    version,
    "--operation",
    operation,
    "--parent",
    "root",
    "--name",
    "recovered.txt",
  ];
  expect((await f.run(args)).code).toBe(0);
  expect((await stat(operation)).mode & 0o777).toBe(0o600);
  expect((await f.run(args)).code).toBe(0);
  expect(call.mock.calls[0]![1]).toEqual(call.mock.calls[1]![1]);
  expect((await f.run([...args.slice(0, -1), "changed.txt"])).code).not.toBe(0);
  expect(call).toHaveBeenCalledTimes(2);
  vi.spyOn(AgentWorkplace.prototype, "getFileTrashOperation").mockResolvedValue(
    result,
  );
  expect((await f.run(["trash-status", "--operation", operation])).code).toBe(
    0,
  );
  vi.spyOn(AgentWorkplace.prototype, "listTrashedFiles").mockResolvedValue({
    files: [],
    nextCursor: null,
  });
  expect((await f.run(["trashed"])).stdout).toBe(
    JSON.stringify({ files: [], nextCursor: null }) + "\n",
  );
});

test("saves immutable administrator intent before a lost response and preserves exact status streams", async () => {
  const f = await fixture(),
    fileId = randomUUID(),
    version = randomUUID(),
    operation = join(f.dir, "deletion.json");
  const result = {
    state: "pending" as const,
    phase: "collecting" as const,
    operationId: randomUUID(),
    fileId,
    version: randomUUID(),
    action: "clear_history" as const,
    admittedAt: "2026-09-17T00:00:00.000Z",
    targetCount: 0,
    processedCount: 0,
  };
  let lost = true;
  const call = vi
    .spyOn(AgentWorkplace.prototype, "beginFileDeletion")
    .mockImplementation(async (_auth, request) => {
      expect(JSON.parse(await readFile(operation, "utf8")).request).toEqual(
        request,
      );
      if (lost) {
        lost = false;
        throw new Error("simulated lost response");
      }
      return { ...result, operationId: request.operationId };
    });
  const args = [
    "clear-history",
    fileId,
    "--expected-version",
    version,
    "--operation",
    operation,
  ];
  expect((await f.run(args)).code).not.toBe(0);
  expect((await stat(operation)).mode & 0o777).toBe(0o600);
  const retried = await f.run(args);
  expect(retried.code).toBe(0);
  expect(retried.stderr).toBe("");
  expect(call.mock.calls[0]![1]).toEqual(call.mock.calls[1]![1]);
  const receipt = {
    ...result,
    operationId: call.mock.calls[1]![1].operationId,
  };
  expect(retried.stdout).toBe(JSON.stringify(receipt) + "\n");
  expect((await f.run(["purge", ...args.slice(1)])).code).not.toBe(0);
  expect(call).toHaveBeenCalledTimes(2);
  vi.spyOn(
    AgentWorkplace.prototype,
    "getFileDeletionOperation",
  ).mockResolvedValue(receipt);
  expect(await f.run(["deletion-status", "--operation", operation])).toEqual({
    code: 0,
    stdout: JSON.stringify(receipt) + "\n",
    stderr: "",
  });
  const saved = JSON.parse(await readFile(operation, "utf8"));
  saved.accountId = randomUUID();
  await writeFile(operation, JSON.stringify(saved));
  expect((await f.run(args)).code).not.toBe(0);
  expect(call).toHaveBeenCalledTimes(2);
});

test("prints explicit catch-up gaps and passes independent cursors through the SDK", async () => {
  const f = await fixture();
  vi.spyOn(AgentWorkplace.prototype, "getFilesCheckpoint").mockResolvedValue({
    checkpoint: "opaque.signature",
  });
  const baseline = vi
    .spyOn(AgentWorkplace.prototype, "listFilesBaseline")
    .mockResolvedValue({ entries: [], nextCursor: null });
  const changes = vi
    .spyOn(AgentWorkplace.prototype, "listFilesChanges")
    .mockResolvedValue({
      state: "gap",
      reason: "history_expired",
      baselineRequired: true,
    });
  expect(await f.run(["checkpoint"])).toEqual({
    code: 0,
    stdout: JSON.stringify({ checkpoint: "opaque.signature" }) + "\n",
    stderr: "",
  });
  expect((await f.run(["baseline", "--limit", "1"])).code).toBe(0);
  expect(baseline).toHaveBeenCalledWith(
    { apiKey: "private" },
    { workplaceId: f.workplaceId, after: undefined, limit: 1 },
  );
  const result = await f.run([
    "changes",
    "--cursor",
    "opaque.signature",
    "--limit",
    "2",
  ]);
  expect(result).toEqual({
    code: 0,
    stdout:
      JSON.stringify({
        state: "gap",
        reason: "history_expired",
        baselineRequired: true,
      }) + "\n",
    stderr: "",
  });
  expect(changes).toHaveBeenCalledWith(
    { apiKey: "private" },
    { workplaceId: f.workplaceId, cursor: "opaque.signature", limit: 2 },
  );
});

test("explicit finalization uses current access and prints the pending operation without claiming publication", async () => {
  const f = await fixture(),
    uploadId = randomUUID();
  const result = {
    state: "pending" as const,
    uploadId,
    fileId: randomUUID(),
    revisionId: null,
    version: null,
  };
  const finalize = vi
    .spyOn(AgentWorkplace.prototype, "finalizeFileUpload")
    .mockResolvedValue(result);
  expect(await f.run(["finalize", uploadId])).toEqual({
    code: 0,
    stdout: JSON.stringify(result) + "\n",
    stderr: "",
  });
  expect(finalize).toHaveBeenCalledWith(
    { apiKey: "private" },
    { workplaceId: f.workplaceId, uploadId },
  );
});

test("persists and rereads a full-size upload manifest within the private receipt bound", async () => {
  const { withFilesOperation } = await import("../src/files-operation.js");
  const f = await fixture(),
    path = join(f.dir, "fullsize.json");
  const part = 8 * 1024 * 1024,
    byteLength = 2_000_000_000;
  const saved = {
    version: 1 as const,
    origin: "https://fixture.test",
    accountId: f.accountId,
    request: {
      workplaceId: f.workplaceId,
      operationId: randomUUID(),
      target: { name: '"'.repeat(255) },
      byteLength,
      contentType: "application/octet-stream",
      sha256: "f".repeat(64),
      contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      multipartParts: Array.from({ length: 239 }, (_, i) => ({
        partNumber: i + 1,
        byteLength: Math.min(part, byteLength - i * part),
        contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
      })),
    },
  };
  await withFilesOperation(path, (store) => store.write(saved));
  expect((await stat(path)).size).toBeGreaterThan(16384);
  expect((await stat(path)).size).toBeLessThan(65536);
  await withFilesOperation(path, async (store) =>
    expect(await store.read()).toEqual(saved),
  );
});

test("files parts preserves exact presence-only JSON through the SDK", async () => {
  const f = await fixture(),
    uploadId = randomUUID();
  const result = {
    upload: {
      state: "pending" as const,
      transferState: "open" as const,
      uploadId,
      fileId: randomUUID(),
      revisionId: null,
      version: null,
    },
    presentPartNumbers: [1, 3],
  };
  const inspect = vi
    .spyOn(AgentWorkplace.prototype, "getFileUploadedParts")
    .mockResolvedValue(result);
  expect(await f.run(["parts", uploadId])).toEqual({
    code: 0,
    stdout: JSON.stringify(result) + "\n",
    stderr: "",
  });
  expect(inspect).toHaveBeenCalledExactlyOnceWith(
    { apiKey: "private" },
    { workplaceId: f.workplaceId, uploadId },
  );
});
