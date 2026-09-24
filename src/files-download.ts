import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  type AgentWorkplace,
  type FileRef,
  parseFileReference,
} from "@agent-workplace/sdk";
import { accessOrigin } from "./credentials.js";
import { CliConfigurationError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";

type Identity = { dev: string; ino: string };
interface Receipt {
  version: 1;
  origin: string;
  accountId: string;
  workplaceId: string;
  fileId: string;
  revisionId: string;
  byteLength: number;
  sha256: string;
  output: string;
  directory: string;
  directoryIdentity: Identity | null;
  fileIdentity: Identity | null;
  offset: number;
  state: "planned" | "partial" | "verified" | "complete";
}
const identity = (stat: BigIntStats): Identity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
});
const same = (stat: BigIntStats, expected: Identity) =>
  String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
const failure = (
  message = "Download storage changed or is unavailable; no existing destination will be overwritten",
) => new CliConfigurationError(message);
function privateStat(stat: BigIntStats, directory: boolean) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o077n) !== 0n
  )
    throw failure();
}
function parse(value: unknown): Receipt {
  try {
    if (!value || typeof value !== "object") throw failure();
    const r = value as Receipt;
    if (
      Object.keys(r).sort().join() !==
        "accountId,byteLength,directory,directoryIdentity,fileId,fileIdentity,offset,origin,output,revisionId,sha256,state,version,workplaceId" ||
      r.version !== 1 ||
      accessOrigin(r.origin) !== r.origin ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.accountId) ||
      !/^[0-9a-f]{64}$/.test(r.sha256) ||
      !Number.isSafeInteger(r.byteLength) ||
      r.byteLength < 0 ||
      r.byteLength > 2_000_000_000 ||
      !Number.isSafeInteger(r.offset) ||
      r.offset < 0 ||
      r.offset > r.byteLength ||
      !["planned", "partial", "verified", "complete"].includes(r.state) ||
      typeof r.output !== "string" ||
      resolve(r.output) !== r.output ||
      typeof r.directory !== "string" ||
      dirname(r.directory) !== dirname(r.output) ||
      !/^\.awp-download-[0-9a-f-]{36}$/.test(basename(r.directory))
    )
      throw failure();
    parseFileReference(
      `awp:file:${r.workplaceId}:${r.fileId}:revision:${r.revisionId}`,
    );
    for (const id of [r.directoryIdentity, r.fileIdentity])
      if (
        id !== null &&
        (typeof id !== "object" ||
          Object.keys(id).sort().join() !== "dev,ino" ||
          !/^\d{1,24}$/.test(id.dev) ||
          !/^\d{1,24}$/.test(id.ino))
      )
        throw failure();
    if (
      (r.state !== "planned" && (!r.fileIdentity || !r.directoryIdentity)) ||
      (r.state === "planned" && r.offset !== 0) ||
      (["verified", "complete"].includes(r.state) && r.offset !== r.byteLength)
    )
      throw failure();
    return r;
  } catch {
    throw failure("Invalid private download operation file");
  }
}
async function namedIdentity(
  path: string,
  expected: Identity,
  directory = false,
) {
  const stat = await lstat(path, { bigint: true });
  privateStat(stat, directory);
  if (!same(stat, expected)) throw failure();
  return stat;
}
async function exists(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function boundedRead(
  handle: FileHandle,
  offset: number,
  length: number,
  bytes: Buffer,
) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024)
    throw failure();
  if (bytes.length < length) throw failure();
  let received = 0;
  while (received < length) {
    const result = await handle.read(
      bytes,
      received,
      length - received,
      offset + received,
    );
    if (!result.bytesRead) break;
    received += result.bytesRead;
  }
  return bytes.subarray(0, received);
}
async function cleanPartial(r: Receipt) {
  if (!r.directoryIdentity || !(await exists(r.directory))) return;
  const directory = await open(
    r.directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await directory.stat({ bigint: true });
    privateStat(stat, true);
    if (!same(stat, r.directoryIdentity)) throw failure();
    await namedIdentity(r.directory, r.directoryIdentity, true);
    const part = join(r.directory, "content");
    if (await exists(part)) {
      if (!r.fileIdentity) throw failure();
      const content = await open(
        part,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const file = await content.stat({ bigint: true });
        privateStat(file, false);
        if (!same(file, r.fileIdentity)) throw failure();
        await namedIdentity(r.directory, r.directoryIdentity, true);
        await namedIdentity(part, r.fileIdentity);
        await unlink(part);
        await directory.sync();
      } finally {
        await content.close();
      }
    }
    // Never recursively remove unexpected files, even from a private directory.
    await namedIdentity(r.directory, r.directoryIdentity, true);
    await rmdir(r.directory);
    await syncDirectory(dirname(r.directory));
  } finally {
    await directory.close();
  }
}

/** The private receipt is progress, never authorization. Product IO stays in SDK. */
export async function downloadFileLocally(
  client: AgentWorkplace,
  key: string,
  context: { origin: string; accountId: string; workplaceId: string },
  input: {
    ref: FileRef;
    output: string;
    operation?: string;
    expected?: { sha256: string; byteLength: number };
  },
) {
  if (process.platform === "win32")
    throw failure(
      "Secure download recovery currently requires a POSIX filesystem",
    );
  const output = join(
    await realpath(dirname(resolve(input.output))),
    basename(resolve(input.output)),
  );
  if (
    input.ref.workplaceId !== context.workplaceId ||
    (input.operation && resolve(input.operation) === output)
  )
    throw failure(
      "Download belongs to another workplace or conflicts with its receipt path",
    );
  const ephemeral = input.operation
    ? undefined
    : await mkdtemp(join(tmpdir(), "awp-download-operation-"));
  const operation = input.operation ?? join(ephemeral!, "operation.json");
  // Prefix verification consumes each read before requesting another. Reuse
  // one window for both partial and completed retries, allocated only on read.
  let readBuffer: Buffer | undefined;
  const readPrefix = (handle: FileHandle, offset: number, length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024)
      throw failure();
    if (!readBuffer || readBuffer.length < length)
      readBuffer = Buffer.alloc(length);
    return boundedRead(handle, offset, length, readBuffer);
  };
  let last: Receipt | undefined;
  let receiptIdentity: Identity | undefined;
  const ephemeralIdentity = ephemeral
    ? identity(await lstat(ephemeral, { bigint: true }))
    : undefined;
  try {
    return await withPrivateJsonFile(
      operation,
      { label: "Download operation", maximumBytes: 16384, validate: parse },
      async (store) => {
        const parent = await open(
          dirname(output),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const parentIdentity = identity(await parent.stat({ bigint: true }));
        const checkParent = async () => {
          store.assertOwned();
          const named = await lstat(dirname(output), { bigint: true });
          if (!named.isDirectory() || !same(named, parentIdentity))
            throw failure();
        };
        try {
          let saved = await store.read();
          if (
            saved &&
            (saved.origin !== context.origin ||
              saved.accountId !== context.accountId ||
              saved.workplaceId !== context.workplaceId ||
              saved.fileId !== input.ref.fileId ||
              (input.ref.revisionId &&
                saved.revisionId !== input.ref.revisionId) ||
              saved.output !== output)
          )
            throw failure(
              "Download operation belongs to another server, account, revision or destination",
            );
          const file = await client.getFile(
            { apiKey: key },
            saved
              ? {
                  workplaceId: saved.workplaceId,
                  fileId: saved.fileId,
                  revisionId: saved.revisionId,
                }
              : input.ref,
          );
          if (
            file.workplaceId !== context.workplaceId ||
            file.fileId !== input.ref.fileId ||
            (input.ref.revisionId && file.revisionId !== input.ref.revisionId)
          )
            throw failure(
              "Download metadata does not match the requested file",
            );
          if (
            input.expected &&
            (file.sha256 !== input.expected.sha256 ||
              file.byteLength !== input.expected.byteLength)
          )
            throw failure(
              "Pinned export metadata no longer matches the inventory",
            );
          if (
            saved &&
            (file.revisionId !== saved.revisionId ||
              file.byteLength !== saved.byteLength ||
              file.sha256 !== saved.sha256)
          )
            throw failure(
              "Pinned download metadata no longer matches its receipt",
            );
          if (!saved) {
            if (await exists(output))
              throw failure(
                "Destination already exists; choose a new output path",
              );
            saved = {
              version: 1,
              ...context,
              fileId: file.fileId,
              revisionId: file.revisionId,
              byteLength: file.byteLength,
              sha256: file.sha256,
              output,
              directory: join(dirname(output), `.awp-download-${randomUUID()}`),
              directoryIdentity: null,
              fileIdentity: null,
              offset: 0,
              state: "planned",
            };
            await store.write(saved);
            if (ephemeral)
              receiptIdentity = identity(
                await lstat(operation, { bigint: true }),
              );
          }
          let r: Receipt = saved;
          last = r;
          const save = async (next: Receipt) => {
            await store.write(next);
            if (ephemeral)
              receiptIdentity = identity(
                await lstat(operation, { bigint: true }),
              );
            r = next;
            last = next;
          };
          const pinned = {
            workplaceId: r.workplaceId,
            fileId: r.fileId,
            revisionId: r.revisionId,
          };
          const resume = () => ({
            revisionId: r.revisionId,
            byteLength: r.byteLength,
            sha256: r.sha256,
            offset: r.offset,
          });
          const destination = await exists(output);
          if (
            destination &&
            (r.state === "planned" ||
              r.state === "partial" ||
              !r.fileIdentity ||
              !same(destination, r.fileIdentity))
          )
            throw failure(
              "Destination already exists and is not this completed download",
            );
          if (r.state === "complete") {
            if (!destination || !r.fileIdentity)
              throw failure(
                "Completed destination is missing; use a new download operation",
              );
            const complete = await open(
              output,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const stat = await complete.stat({ bigint: true });
              privateStat(stat, false);
              if (
                !same(stat, r.fileIdentity) ||
                stat.size !== BigInt(r.byteLength)
              )
                throw failure();
              await client.downloadFileTo(
                { apiKey: key },
                pinned,
                {
                  read: (offset, length) =>
                    readPrefix(complete, offset, length),
                  write: async () => {
                    throw failure();
                  },
                },
                { resume: resume() },
              );
              await namedIdentity(output, r.fileIdentity);
            } finally {
              await complete.close();
            }
            await cleanPartial(r);
            return { ...file, output: input.output };
          }
          if (r.state === "planned") {
            await checkParent();
            if ((await exists(r.directory)) && !r.directoryIdentity)
              throw failure(
                "Partial directory ownership was not recorded; preserve it and use a new operation",
              );
            if (!(await exists(r.directory))) {
              await mkdir(r.directory, { mode: 0o700 });
              await syncDirectory(dirname(r.directory));
            }
          }
          const directory = await open(
            r.directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          let handle: FileHandle | undefined;
          try {
            const dirStat = await directory.stat({ bigint: true });
            privateStat(dirStat, true);
            if (r.directoryIdentity && !same(dirStat, r.directoryIdentity))
              throw failure();
            if (!r.directoryIdentity)
              await save({ ...r, directoryIdentity: identity(dirStat) });
            await namedIdentity(r.directory, r.directoryIdentity!, true);
            const part = join(r.directory, "content");
            if (r.state === "planned") {
              try {
                handle = await open(
                  part,
                  constants.O_RDWR |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                  0o600,
                );
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                  throw error;
                throw failure(
                  "Partial file ownership was not recorded; preserve it and use a new operation",
                );
              }
              const stat = await handle.stat({ bigint: true });
              privateStat(stat, false);
              // No content is written until its empty-file identity is durable.
              // A crash before that point preserves the unknown artifact.
              if (stat.size !== 0n || stat.nlink !== 1n) throw failure();
              await handle.sync();
              await directory.sync();
              await save({
                ...r,
                fileIdentity: identity(stat),
                state: "partial",
              });
            } else
              handle = await open(
                part,
                constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
            const opened = handle;
            const check = async () => {
              await checkParent();
              if (
                !same(
                  await directory.stat({ bigint: true }),
                  r.directoryIdentity!,
                )
              )
                throw failure();
              await namedIdentity(r.directory, r.directoryIdentity!, true);
              const stat = await opened.stat({ bigint: true });
              privateStat(stat, false);
              if (
                !same(stat, r.fileIdentity!) ||
                stat.size < BigInt(r.offset) ||
                stat.size > BigInt(r.byteLength)
              )
                throw failure();
              await namedIdentity(part, r.fileIdentity!);
              return stat;
            };
            const stat = await check();
            if (r.state === "partial") {
              if (stat.nlink !== 1n) throw failure();
              // Truncate only this validated open inode, never a newly resolved path.
              await opened.truncate(r.offset);
              await opened.sync();
            }
            const result = await client.downloadFileTo(
              { apiKey: key },
              pinned,
              {
                read: async (offset, length) => {
                  await check();
                  return readPrefix(opened, offset, length);
                },
                write: async (bytes, offset) => {
                  if (r.state !== "partial") throw failure();
                  const current = await check();
                  if (current.nlink !== 1n) throw failure();
                  let written = 0;
                  while (written < bytes.length) {
                    const result = await opened.write(
                      bytes,
                      written,
                      bytes.length - written,
                      offset + written,
                    );
                    if (!result.bytesWritten) throw failure();
                    written += result.bytesWritten;
                  }
                },
                checkpoint: async (offset) => {
                  await check();
                  await opened.sync();
                  await save({ ...r, offset });
                },
              },
              { resume: resume() },
            );
            await check();
            await opened.sync();
            await save({ ...r, state: "verified", offset: r.byteLength });
            await checkParent();
            const existing = await exists(output);
            if (existing) {
              privateStat(existing, false);
              if (!same(existing, r.fileIdentity!))
                throw failure(
                  "Destination already exists; it will not be overwritten",
                );
            } else {
              await namedIdentity(part, r.fileIdentity!);
              await link(part, output); // Atomic no-overwrite creation, same filesystem.
            }
            await namedIdentity(output, r.fileIdentity!);
            await checkParent();
            await parent.sync();
            await save({ ...r, state: "complete" });
            await handle.close();
            handle = undefined;
            await cleanPartial(r);
            return { ...result.file, output: input.output };
          } finally {
            await handle?.close();
            await directory.close();
          }
        } finally {
          await parent.close();
        }
      },
    );
  } finally {
    if (ephemeral) {
      // Explicit ephemeral mode owns only these names. Unknown/replaced artifacts
      // are preserved, and an existing destination is never removed on failure.
      if (last) await cleanPartial(last).catch(() => {});
      await (async () => {
        await namedIdentity(ephemeral, ephemeralIdentity!, true);
        if (receiptIdentity) {
          await namedIdentity(operation, receiptIdentity);
          await unlink(operation);
        }
        await namedIdentity(ephemeral, ephemeralIdentity!, true);
        await rmdir(ephemeral);
      })().catch(() => {});
    }
  }
}
