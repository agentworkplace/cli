import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, link, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliConfigurationError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";

type Identity = { dev: string; ino: string };
type Receipt = {
  version: 1;
  binding: string;
  output: string;
  candidate: string;
  directory: Identity;
  file: Identity | null;
  bytes: number;
  sha256: string;
  state: "planned" | "verified" | "complete";
};
const fail = () =>
  new CliConfigurationError(
    "Mail export content or storage changed; existing files were not overwritten",
  );
const identity = (s: BigIntStats): Identity => ({
  dev: String(s.dev),
  ino: String(s.ino),
});
const same = (s: BigIntStats, id: Identity) =>
  String(s.dev) === id.dev && String(s.ino) === id.ino;
const validId = (id: Identity | null) =>
  id === null ||
  (typeof id === "object" &&
    Object.keys(id).sort().join() === "dev,ino" &&
    /^\d{1,24}$/.test(id.dev) &&
    /^\d{1,24}$/.test(id.ino));
function privateStat(s: BigIntStats, directory: boolean) {
  if (
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.uid !== BigInt(process.getuid!()) ||
    (s.mode & 0o077n) !== 0n
  )
    throw fail();
}
async function exists(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
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
async function digest(h: FileHandle, bytes: number) {
  const buffer = Buffer.alloc(64 * 1024),
    hash = createHash("sha256");
  let position = 0;
  for (;;) {
    const { bytesRead } = await h.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > bytes) throw fail();
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (position !== bytes) throw fail();
  return hash.digest("hex");
}

/** One immutable retained Mail payload (at most 10 decimal MB). A killed write
 * retries the same owned candidate. Only verified bytes are linked into place;
 * recovery recognizes that exact inode after a lost publication receipt. */
export async function exportMailBytes(input: {
  operation: string;
  output: string;
  binding: string;
  bytes: number;
  sha256: string;
  load(): Promise<Uint8Array>;
  assertOwned(): Promise<void>;
}) {
  if (process.platform === "win32") throw fail();
  if (
    !/^[a-f0-9]{64}$/.test(input.binding) ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    input.bytes > 10_000_000
  )
    throw fail();
  const directory = await realpath(dirname(resolve(input.output))),
    output = join(directory, basename(resolve(input.output)));
  return withPrivateJsonFile(
    input.operation,
    {
      label: "Mail export content",
      maximumBytes: 8192,
      validate(value): Receipt {
        try {
          const r = value as Receipt;
          if (
            !r ||
            Object.keys(r).sort().join() !==
              "binding,bytes,candidate,directory,file,output,sha256,state,version" ||
            r.version !== 1 ||
            r.binding !== input.binding ||
            r.output !== output ||
            r.bytes !== input.bytes ||
            r.sha256 !== input.sha256 ||
            !r.directory ||
            !validId(r.directory) ||
            !validId(r.file) ||
            !["planned", "verified", "complete"].includes(r.state) ||
            (r.state !== "planned" && !r.file) ||
            dirname(r.candidate) !== directory ||
            !/^\.awp-mail-content-[0-9a-f-]{36}$/.test(basename(r.candidate))
          )
            throw fail();
          return r;
        } catch {
          throw fail();
        }
      },
    },
    async (store) => {
      await input.assertOwned();
      const ds = await lstat(directory, { bigint: true });
      privateStat(ds, true);
      let r = await store.read();
      if (!r) {
        if (await exists(output)) throw fail();
        r = {
          version: 1,
          binding: input.binding,
          output,
          candidate: join(directory, `.awp-mail-content-${randomUUID()}`),
          directory: identity(ds),
          file: null,
          bytes: input.bytes,
          sha256: input.sha256,
          state: "planned",
        };
        await store.write(r);
      }
      const check = async () => {
        store.assertOwned();
        await input.assertOwned();
        const stat = await lstat(directory, { bigint: true });
        privateStat(stat, true);
        if (!same(stat, r!.directory)) throw fail();
      };
      await check();
      const handle = await open(
        r.candidate,
        constants.O_RDWR |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (r.file ? 0 : constants.O_CREAT | constants.O_EXCL),
        0o600,
      );
      try {
        let stat = await handle.stat({ bigint: true });
        privateStat(stat, false);
        if (r.file && !same(stat, r.file)) throw fail();
        if (!r.file) {
          await handle.sync();
          await syncDirectory(directory);
          r = { ...r, file: identity(stat) };
          await store.write(r);
        }
        const checkFile = async () => {
          await check();
          const named = await lstat(r!.candidate, { bigint: true });
          privateStat(named, false);
          if (!same(named, r!.file!)) throw fail();
          const published = await exists(output);
          if (published && !same(published, r!.file!)) throw fail();
          if (named.nlink !== (published ? 2n : 1n)) throw fail();
          return published;
        };
        let published = await checkFile();
        if (r.state === "planned") {
          if (published) throw fail();
          const bytes = await input.load();
          if (
            bytes.byteLength !== r.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== r.sha256
          )
            throw fail();
          await checkFile();
          await handle.truncate(0);
          let offset = 0;
          while (offset < bytes.length) {
            await checkFile();
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              Math.min(64 * 1024, bytes.length - offset),
              offset,
            );
            if (!bytesWritten) throw fail();
            offset += bytesWritten;
          }
          await handle.sync();
          // Verify the candidate, including caller mutation during asynchronous IO.
          if ((await digest(handle, r.bytes)) !== r.sha256) throw fail();
          r = { ...r, state: "verified" };
          await store.write(r);
        }
        stat = await handle.stat({ bigint: true });
        if (
          stat.size !== BigInt(r.bytes) ||
          (await digest(handle, r.bytes)) !== r.sha256
        )
          throw fail();
        const verified = await handle.stat({ bigint: true });
        if (
          verified.mtimeNs !== stat.mtimeNs ||
          verified.ctimeNs !== stat.ctimeNs
        )
          throw fail();
        published = await checkFile();
        const beforePublication = await handle.stat({ bigint: true });
        if (
          beforePublication.size !== verified.size ||
          beforePublication.mtimeNs !== verified.mtimeNs ||
          beforePublication.ctimeNs !== verified.ctimeNs
        )
          throw fail();
        if (r.state === "complete" && !published) throw fail();
        if (!published) {
          await link(r.candidate, output);
          await syncDirectory(directory);
        }
        await checkFile();
        await store.write({ ...r, state: "complete" });
        return { output, bytes: r.bytes, sha256: r.sha256 };
      } finally {
        await handle.close();
      }
    },
  );
}
