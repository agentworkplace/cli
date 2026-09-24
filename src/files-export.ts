import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  AgentWorkplaceError,
  parseFileReference,
  type AgentWorkplace,
  type FilesTreeItem,
  type RetainedFilesItem,
} from "@agent-workplace/sdk";
import { accessOrigin } from "./credentials.js";
import { CliConfigurationError, presentError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";
import { downloadFileLocally } from "./files-download.js";

type Identity = { dev: string; ino: string };
type Context = { origin: string; accountId: string; workplaceId: string };
type Mode = "current" | "retained";
type Item =
  | FilesTreeItem
  | RetainedFilesItem
  | {
      kind: "local_issue";
      entryId: string | null;
      sourceKind: "file" | "folder";
      code: "unsafe_path";
      pathHash: string;
    };
interface Receipt extends Context {
  version: 1;
  mode: Mode;
  parentId: string | null;
  output: string;
  storage: string;
  outputIdentity: Identity | null;
  storageIdentity: Identity | null;
  inventoryIdentity: Identity | null;
  manifestIdentity: Identity | null;
  inventoryHash: string | null;
  checkpoint: string | null;
  plannedFiles: number;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const identity = (s: BigIntStats): Identity => ({
  dev: String(s.dev),
  ino: String(s.ino),
});
const same = (s: BigIntStats, id: Identity) =>
  String(s.dev) === id.dev && String(s.ino) === id.ino;
const fail = (
  message = "Export storage changed or is unavailable; existing work will not be overwritten",
) => new CliConfigurationError(message);
function privateStat(s: BigIntStats, directory: boolean) {
  if (
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.uid !== BigInt(process.getuid!()) ||
    (s.mode & 0o077n) !== 0n ||
    (!directory && s.nlink !== 1n)
  )
    throw fail();
}
function validIdentity(value: Identity | null) {
  return (
    value === null ||
    (typeof value === "object" &&
      Object.keys(value).sort().join() === "dev,ino" &&
      /^\d{1,24}$/.test(value.dev) &&
      /^\d{1,24}$/.test(value.ino))
  );
}
function parse(value: unknown): Receipt {
  try {
    if (!value || typeof value !== "object") throw fail();
    const r = value as Receipt;
    if (
      Object.keys(r).sort().join() !==
        "accountId,checkpoint,inventoryHash,inventoryIdentity,manifestIdentity,mode,origin,output,outputIdentity,parentId,plannedFiles,storage,storageIdentity,version,workplaceId" ||
      r.version !== 1 ||
      !["current", "retained"].includes(r.mode) ||
      !uuid.test(r.accountId) ||
      !uuid.test(r.workplaceId) ||
      (r.parentId !== null && !uuid.test(r.parentId)) ||
      accessOrigin(r.origin) !== r.origin ||
      typeof r.output !== "string" ||
      resolve(r.output) !== r.output ||
      typeof r.storage !== "string" ||
      resolve(r.storage) !== r.storage ||
      !/^\.awp-export-[0-9a-f-]{36}$/.test(basename(r.storage)) ||
      !Number.isSafeInteger(r.plannedFiles) ||
      r.plannedFiles < 0 ||
      ![
        r.outputIdentity,
        r.storageIdentity,
        r.inventoryIdentity,
        r.manifestIdentity,
      ].every(validIdentity) ||
      (r.inventoryHash !== null && !/^[a-f0-9]{64}$/.test(r.inventoryHash)) ||
      (r.checkpoint !== null &&
        (typeof r.checkpoint !== "string" || r.checkpoint.length > 512)) ||
      (r.inventoryHash !== null && (!r.inventoryIdentity || !r.checkpoint))
    )
      throw fail();
    return r;
  } catch {
    throw fail("Invalid private export operation file");
  }
}
async function exists(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function named(path: string, id: Identity, directory: boolean) {
  const s = await lstat(path, { bigint: true });
  privateStat(s, directory);
  if (!same(s, id)) throw fail();
}
async function canonicalOperation(path: string) {
  const absolute = resolve(path),
    missing: string[] = [];
  let parent = dirname(absolute);
  for (;;) {
    try {
      return join(await realpath(parent), ...missing, basename(absolute));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        parent === dirname(parent)
      )
        throw error;
      missing.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}
async function syncDirectory(path: string) {
  const h = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
const lineLimit = 32768;
function encode(value: unknown) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > lineLimit)
    throw fail("Export metadata record is too large");
  return text;
}
function safeSegment(value: unknown): value is string {
  if (typeof value !== "string" || !value || value === "." || value === "..")
    return false;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point < 32 || point === 127 || char === "/" || char === "\\")
      return false;
  }
  return true;
}
function safePath(parts: unknown): parts is string[] {
  return (
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every(safeSegment) &&
    Buffer.byteLength(JSON.stringify(parts)) < 8192
  );
}
function item(value: unknown): Item {
  if (!value || typeof value !== "object")
    throw fail("Invalid export inventory");
  const r = value as Item;
  if (
    ![
      "start",
      "entry",
      "folder",
      "file",
      "revision",
      "issue",
      "local_issue",
      "complete",
    ].includes(r.kind)
  )
    throw fail("Invalid export inventory");
  if ((r.kind === "file" || r.kind === "folder") && !safePath(r.path))
    throw fail("Invalid export path");
  if (r.kind === "file" || r.kind === "revision") {
    const f = r.file;
    parseFileReference(
      `awp:file:${f.workplaceId}:${f.fileId}:revision:${f.revisionId}`,
    );
    if (
      !Number.isSafeInteger(f.byteLength) ||
      f.byteLength < 0 ||
      f.byteLength > 2_000_000_000 ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw fail("Invalid export file metadata");
  }
  return r;
}
async function* records(
  handle: FileHandle,
  unchanged: () => Promise<void>,
): AsyncGenerator<Item> {
  const buffer = Buffer.alloc(lineLimit);
  let pending = Buffer.alloc(0),
    position = 0;
  for (;;) {
    await unchanged();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end + 1 > lineLimit) throw fail("Invalid export inventory");
      await unchanged();
      yield item(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            pending.subarray(0, end),
          ),
        ),
      );
      pending = pending.subarray(end + 1);
    }
    if (pending.length >= lineLimit) throw fail("Invalid export inventory");
  }
  if (pending.length) throw fail("Interrupted export inventory");
}
const digestPath = (parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Private operation state stays small; inventory/results and visited IDs are
 * disk backed. Every payload uses the existing pinned, verified download path. */
export async function exportFilesLocally(
  client: AgentWorkplace,
  key: string,
  context: Context,
  input: {
    mode: Mode;
    parentId?: string | null;
    output: string;
    operation: string;
  },
) {
  if (process.platform === "win32")
    throw fail("Secure export recovery currently requires a POSIX filesystem");
  const output = join(
      await realpath(dirname(resolve(input.output))),
      basename(resolve(input.output)),
    ),
    operation = await canonicalOperation(input.operation);
  const relation = relative(output, operation);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !relation.startsWith(sep))
  )
    throw fail("Export operation must be outside the destination directory");
  const parentId = input.parentId ?? null;
  if (parentId !== null && !uuid.test(parentId))
    throw fail("Specify a folder UUID or root");
  if (input.mode === "retained" && parentId !== null)
    throw fail("Retained export covers the entire workplace");
  return withPrivateJsonFile(
    operation,
    { label: "Export operation", maximumBytes: 16384, validate: parse },
    async (store) => {
      let r = await store.read();
      if (
        r &&
        (r.origin !== context.origin ||
          r.accountId !== context.accountId ||
          r.workplaceId !== context.workplaceId ||
          r.mode !== input.mode ||
          r.parentId !== parentId ||
          r.output !== output ||
          dirname(r.storage) !== dirname(operation))
      )
        throw fail(
          "Export operation belongs to another server, account, scope or destination",
        );
      if (!r) {
        if (await exists(output))
          throw fail(
            "Export destination already exists; choose a new directory",
          );
        r = {
          version: 1,
          ...context,
          mode: input.mode,
          parentId,
          output,
          storage: join(dirname(operation), `.awp-export-${randomUUID()}`),
          outputIdentity: null,
          storageIdentity: null,
          inventoryIdentity: null,
          manifestIdentity: null,
          inventoryHash: null,
          checkpoint: null,
          plannedFiles: 0,
        };
        await store.write(r);
      }
      const save = async (next: Receipt) => {
        await store.write(next);
        r = next;
      };
      for (const [path, field] of [
        [r.storage, "storageIdentity"],
        [output, "outputIdentity"],
      ] as const) {
        const stat = await exists(path);
        if (stat && !r[field])
          throw fail(
            "Directory ownership was not recorded; preserve it and choose a new operation",
          );
        if (!stat) {
          if (r[field]) throw fail();
          await mkdir(path, { mode: 0o700 });
          await syncDirectory(dirname(path));
          const created = await lstat(path, { bigint: true });
          privateStat(created, true);
          await save({ ...r, [field]: identity(created) });
        }
        await named(path, r[field]!, true);
      }
      const check = async () => {
        store.assertOwned();
        await named(output, r!.outputIdentity!, true);
        await named(r!.storage, r!.storageIdentity!, true);
      };
      const inventoryPath = join(r.storage, "inventory.ndjson"),
        manifestPath =
          input.mode === "retained"
            ? join(output, "manifest.ndjson")
            : join(r.storage, "manifest.ndjson");
      async function ownedFile(
        path: string,
        field: "inventoryIdentity" | "manifestIdentity",
      ) {
        await check();
        let h: FileHandle;
        if (!r![field]) {
          try {
            h = await open(
              path,
              constants.O_RDWR |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              0o600,
            );
          } catch {
            throw fail(
              "Unrecorded export file exists; preserve it and use a new operation",
            );
          }
          try {
            const s = await h.stat({ bigint: true });
            privateStat(s, false);
            await h.sync();
            await syncDirectory(dirname(path));
            await save({ ...r!, [field]: identity(s) });
          } catch (error) {
            await h.close();
            throw error;
          }
        } else
          h = await open(
            path,
            constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        try {
          const s = await h.stat({ bigint: true });
          privateStat(s, false);
          if (!same(s, r![field]!)) throw fail();
          await named(path, r![field]!, false);
          return h;
        } catch (error) {
          await h.close();
          throw error;
        }
      }
      const inventory = await ownedFile(inventoryPath, "inventoryIdentity");
      try {
        if (!r.inventoryHash) {
          await check();
          await inventory.truncate(0);
          const visitsPath = await mkdtemp(join(r.storage, "visits-")),
            visitsIdentity = identity(
              await lstat(visitsPath, { bigint: true }),
            );
          const visits = {
            async addIfNew(id: string) {
              if (!uuid.test(id)) throw fail();
              await check();
              await named(visitsPath, visitsIdentity, true);
              const path = join(visitsPath, id);
              try {
                const h = await open(
                  path,
                  constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                  0o600,
                );
                await h.close();
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                  throw error;
                const s = await lstat(path, { bigint: true });
                privateStat(s, false);
                if (s.size !== 0n) throw fail();
                return false;
              }
            },
          };
          const walk =
            input.mode === "current"
              ? client.walkFilesTree(
                  { apiKey: key },
                  { workplaceId: context.workplaceId, parentId },
                  { visits },
                )
              : client.walkRetainedFiles(
                  { apiKey: key },
                  { workplaceId: context.workplaceId },
                );
          const hash = createHash("sha256");
          let checkpoint: string | null = null,
            plannedFiles = 0,
            finished = false;
          for await (const event of walk) {
            await check();
            let record: Item = event;
            if (
              (event.kind === "file" || event.kind === "folder") &&
              !safePath(event.path)
            )
              record = {
                kind: "local_issue",
                entryId: event.entry.entryId,
                sourceKind: event.kind,
                code: "unsafe_path",
                pathHash: digestPath(event.path),
              };
            if (event.kind === "start") checkpoint = event.checkpoint;
            if (event.kind === "file" || event.kind === "revision")
              plannedFiles++;
            if (event.kind === "complete") finished = true;
            const line = encode(record);
            hash.update(line);
            await inventory.writeFile(line);
          }
          if (!finished || !checkpoint)
            throw fail("Export inventory did not complete");
          await inventory.sync();
          await save({
            ...r,
            inventoryHash: hash.digest("hex"),
            checkpoint,
            plannedFiles,
          });
        }
        // Verify the whole frozen plan before trusting it for filesystem/content IO.
        await check();
        await named(inventoryPath, r.inventoryIdentity!, false);
        const frozen = await inventory.stat({ bigint: true });
        const unchanged = async () => {
          await check();
          await named(inventoryPath, r!.inventoryIdentity!, false);
          const current = await inventory.stat({ bigint: true });
          if (
            current.size !== frozen.size ||
            current.mtimeNs !== frozen.mtimeNs ||
            current.ctimeNs !== frozen.ctimeNs
          )
            throw fail("Export inventory changed");
        };
        const hash = createHash("sha256");
        for await (const record of records(inventory, unchanged))
          hash.update(encode(record));
        if (hash.digest("hex") !== r.inventoryHash)
          throw fail("Export inventory changed; no content was copied");
        const manifest = await ownedFile(manifestPath, "manifestIdentity");
        let manifestPosition = Number((await manifest.stat()).size);
        // A killed append can leave an incomplete final line. Preserve complete
        // records and discard only that tail in the already-owned manifest.
        if (manifestPosition) {
          const length = Math.min(lineLimit, manifestPosition);
          const tail = Buffer.alloc(length);
          const read = await manifest.read(
            tail,
            0,
            length,
            manifestPosition - length,
          );
          if (read.bytesRead !== length) throw fail();
          if (tail[length - 1] !== 10) {
            const newline = tail.lastIndexOf(10);
            if (newline < 0 && manifestPosition > lineLimit) throw fail();
            manifestPosition = manifestPosition - length + newline + 1;
            await manifest.truncate(manifestPosition);
            await manifest.sync();
          }
        }
        const attempt = randomUUID();
        async function report(value: unknown) {
          await check();
          await named(manifestPath, r!.manifestIdentity!, false);
          const data = Buffer.from(encode({ attempt, ...(value as object) }));
          let n = 0;
          while (n < data.length) {
            const written = await manifest.write(
              data,
              n,
              data.length - n,
              manifestPosition + n,
            );
            if (!written.bytesWritten) throw fail();
            n += written.bytesWritten;
          }
          manifestPosition += n;
          await manifest.sync();
        }
        async function directory(
          parts: string[],
          create: boolean,
          entryId?: string,
          parentEntryId?: string | null,
        ) {
          await check();
          let path = output;
          for (let i = 0; i < parts.length; i++) {
            const prefix = parts.slice(0, i + 1);
            if (!safePath(prefix)) throw fail("Unsafe export destination name");
            path = join(path, parts[i]!);
            const expectedEntryId =
              i === parts.length - 1
                ? entryId
                : i === parts.length - 2
                  ? (parentEntryId ?? undefined)
                  : undefined;
            const receipt = join(
              r!.storage,
              `directory-${digestPath(prefix)}.json`,
            );
            await withPrivateJsonFile(
              receipt,
              {
                label: "Export directory",
                maximumBytes: 16384,
                validate(value) {
                  const v = value as {
                    path: string;
                    identity: Identity;
                    entryId: string | null;
                  };
                  if (
                    !v ||
                    Object.keys(v).sort().join() !== "entryId,identity,path" ||
                    (v.entryId !== null && !uuid.test(v.entryId)) ||
                    (expectedEntryId !== undefined &&
                      v.entryId !== expectedEntryId) ||
                    v.path !== path ||
                    !v.identity ||
                    !validIdentity(v.identity)
                  )
                    throw fail();
                  return v;
                },
              },
              async (control) => {
                const prior = await control.read();
                if (prior) {
                  await named(path, prior.identity, true);
                  return;
                }
                if (!create)
                  throw fail("Export parent directory is unavailable");
                if (await exists(path))
                  throw fail(
                    "Local directory collision; nothing was overwritten",
                  );
                await mkdir(path, { mode: 0o700 });
                await syncDirectory(dirname(path));
                const stat = await lstat(path, { bigint: true });
                privateStat(stat, true);
                await control.write({
                  path,
                  identity: identity(stat),
                  entryId: i === parts.length - 1 ? (entryId ?? null) : null,
                });
              },
            );
          }
          return path;
        }
        let copied = 0,
          failed = 0,
          folders = 0,
          attemptedFiles = 0,
          unsafeFiles = 0,
          stopped = false,
          changes: "observed" | "none_observed" | "unknown" = "unknown";
        try {
          await report({
            kind: "start",
            mode: r.mode,
            coverage: "non_snapshot",
            checkpoint: r.checkpoint,
            plannedFiles: r.plannedFiles,
          });
          for await (const record of records(inventory, unchanged)) {
            await check();
            await report({ kind: "inventory", item: record });
            if (record.kind === "issue" || record.kind === "local_issue") {
              failed++;
              if (record.kind === "local_issue" && record.sourceKind === "file")
                unsafeFiles++;
              continue;
            }
            if (record.kind === "folder") {
              try {
                await directory(
                  record.path,
                  true,
                  record.entry.entryId,
                  record.entry.parentId,
                );
                folders++;
              } catch (error) {
                failed++;
                await report({
                  kind: "failure",
                  path: record.path,
                  error: presentError(error),
                });
              }
              continue;
            }
            if (record.kind !== "file" && record.kind !== "revision") continue;
            attemptedFiles++;
            const file = record.file,
              parts =
                record.kind === "file"
                  ? record.path
                  : ["files", file.fileId, file.revisionId];
            try {
              if (file.workplaceId !== context.workplaceId || !safePath(parts))
                throw fail("Invalid export destination");
              const parent = await directory(
                parts.slice(0, -1),
                record.kind === "revision",
                record.kind === "file"
                  ? (record.entry.parentId ?? undefined)
                  : undefined,
              );
              const result = await downloadFileLocally(client, key, context, {
                ref: {
                  workplaceId: context.workplaceId,
                  fileId: file.fileId,
                  revisionId: file.revisionId,
                },
                output: join(parent, parts.at(-1)!),
                operation: join(
                  r.storage,
                  `download-${file.fileId}-${file.revisionId}.json`,
                ),
                expected: { sha256: file.sha256, byteLength: file.byteLength },
              });
              if (
                result.sha256 !== file.sha256 ||
                result.byteLength !== file.byteLength
              )
                throw fail("Pinned export metadata changed");
              copied++;
              await report({
                kind: "downloaded",
                fileId: file.fileId,
                revisionId: file.revisionId,
                path: parts,
                sha256: result.sha256,
                byteLength: result.byteLength,
              });
            } catch (error) {
              failed++;
              await report({
                kind: "failure",
                fileId: file.fileId,
                revisionId: file.revisionId,
                path: parts,
                error: presentError(error),
              });
              if (
                error instanceof AgentWorkplaceError &&
                [401, 403].includes(error.status)
              ) {
                stopped = true;
                break;
              }
            }
          }
          if (!stopped) {
            try {
              const result = await client.listFilesChanges(
                { apiKey: key },
                {
                  workplaceId: context.workplaceId,
                  cursor: r.checkpoint!,
                  limit: 1,
                },
              );
              changes =
                result.state === "gap"
                  ? "unknown"
                  : result.items.length
                    ? "observed"
                    : "none_observed";
            } catch (error) {
              failed++;
              await report({
                kind: "change_coverage_error",
                error: presentError(error),
              });
            }
          }
          const result = {
            state: failed || changes === "unknown" ? "partial" : "complete",
            coverage: "non_snapshot",
            workplaceChanges: changes,
            output,
            manifest: manifestPath,
            inventory: inventoryPath,
            plannedFiles: r.plannedFiles,
            copied,
            failed,
            folders,
            stopped,
            unattempted: Math.max(
              0,
              r.plannedFiles - attemptedFiles - unsafeFiles,
            ),
          };
          await report({ kind: "result", ...result });
          return result;
        } finally {
          await manifest.close();
        }
      } finally {
        await inventory.close();
      }
    },
  );
}
