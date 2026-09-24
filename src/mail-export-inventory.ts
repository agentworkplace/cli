import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
  MailExportItem,
  MailExportVisitStore,
} from "@agent-workplace/sdk";
import { CliConfigurationError } from "./errors.js";

export type MailExportIdentity = { dev: string; ino: string };
export const mailExportIdentity = (s: BigIntStats): MailExportIdentity => ({
  dev: String(s.dev),
  ino: String(s.ino),
});
export const sameMailExportIdentity = (
  s: BigIntStats,
  id: MailExportIdentity,
) => String(s.dev) === id.dev && String(s.ino) === id.ino;
export const invalidMailExport = () =>
  new CliConfigurationError(
    "Mail export inventory or storage changed; preserve existing files and choose a new operation if recovery is unavailable",
  );
export function mailExportPrivateStat(s: BigIntStats, directory: boolean) {
  if (
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.uid !== BigInt(process.getuid!()) ||
    (s.mode & 0o077n) !== 0n ||
    (!directory && s.nlink !== 1n)
  )
    throw invalidMailExport();
}
export async function checkMailExportDirectory(
  path: string,
  id: MailExportIdentity,
) {
  const s = await lstat(path, { bigint: true });
  mailExportPrivateStat(s, true);
  if (!sameMailExportIdentity(s, id)) throw invalidMailExport();
}
export async function syncMailExportDirectory(path: string) {
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
export interface MailInventory {
  name: string;
  identity: MailExportIdentity;
  indexIdentity: MailExportIdentity;
  count: number;
  hash: string;
  checkpoint: string;
}
const maximumRecordBytes = 16 * 1024 * 1024;

// Avoid a second whole-body JSON string and UTF-8 buffer surviving asynchronous
// disk writes. Metadata stays bounded by API pages; retained bodies are escaped
// in small chunks without changing the decoded representation.
function* recordChunks(item: MailExportItem): Generator<string> {
  if (item.kind !== "message") {
    yield JSON.stringify(item);
    return;
  }
  const { text, html, ...metadata } = item.message;
  yield `{"kind":"message","message":${JSON.stringify(metadata).slice(0, -1)},"text":`;
  function* body(value: typeof text): Generator<string> {
    if (value.state !== "present") {
      yield JSON.stringify(value);
      return;
    }
    yield '{"state":"present","content":"';
    for (let offset = 0; offset < value.content.length;) {
      let end = Math.min(offset + 16384, value.content.length);
      const last = value.content.charCodeAt(end - 1);
      if (end < value.content.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield JSON.stringify(value.content.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"}';
  }
  yield* body(text);
  yield ',"html":';
  yield* body(html);
  yield "}}";
}

/** Incomplete inventories are never replayed. A retry creates a new private
 * generation and fresh visit index, leaving interrupted material untouched. */
export async function createMailInventory(
  storage: string,
  check: () => Promise<void>,
  walk: (visits: MailExportVisitStore) => AsyncIterable<MailExportItem>,
): Promise<MailInventory> {
  await check();
  const path = await mkdtemp(join(storage, "inventory-"));
  const directory = mailExportIdentity(await lstat(path, { bigint: true }));
  const owned = async () => {
    await check();
    await checkMailExportDirectory(path, directory);
  };
  await mkdir(join(path, "visits"), { mode: 0o700 });
  const visitsId = mailExportIdentity(
    await lstat(join(path, "visits"), { bigint: true }),
  );
  const index = await open(join(path, "index"), "wx", 0o600);
  try {
    const hash = createHash("sha256");
    let count = 0,
      checkpoint = "",
      finished = false;
    for await (const item of walk({
      async addIfNew(key) {
        await owned();
        await checkMailExportDirectory(join(path, "visits"), visitsId);
        const target = join(
          path,
          "visits",
          createHash("sha256").update(key).digest("hex"),
        );
        try {
          const h = await open(
            target,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          await h.close();
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const s = await lstat(target, { bigint: true });
          mailExportPrivateStat(s, false);
          if (s.size !== 0n) throw invalidMailExport();
          return false;
        }
      },
    })) {
      await owned();
      if (finished) throw invalidMailExport();
      if (item.kind === "start") checkpoint = item.checkpoint;
      if (item.kind === "complete") finished = true;
      const h = await open(join(path, `${count}.json`), "wx", 0o600);
      const recordHash = createHash("sha256");
      let recordBytes = 0;
      try {
        for (const chunk of recordChunks(item)) {
          recordBytes += Buffer.byteLength(chunk);
          if (recordBytes > maximumRecordBytes) throw invalidMailExport();
          recordHash.update(chunk);
          await h.writeFile(chunk);
        }
        await h.sync();
      } finally {
        await h.close();
      }
      const line = recordHash.digest("hex") + "\n";
      await index.writeFile(line);
      hash.update(line);
      count++;
      if (!Number.isSafeInteger(count)) throw invalidMailExport();
    }
    if (!finished || !checkpoint)
      throw new CliConfigurationError(
        "Mail inventory is incomplete; retry the same operation to restart discovery (thread indexing may still be in progress)",
      );
    await owned();
    await index.sync();
    await syncMailExportDirectory(path);
    await syncMailExportDirectory(storage);
    return {
      name: path.slice(storage.length + 1),
      identity: directory,
      indexIdentity: mailExportIdentity(await index.stat({ bigint: true })),
      count,
      checkpoint,
      hash: hash.digest("hex"),
    };
  } finally {
    await index.close();
  }
}

async function* hashes(
  index: FileHandle,
  count: number,
  check: () => Promise<void>,
) {
  const buffer = Buffer.alloc(65 * 256);
  let position = 0,
    records = 0;
  while (records < count) {
    await check();
    const wanted = Math.min(buffer.length, (count - records) * 65);
    let n = 0;
    while (n < wanted) {
      const result = await index.read(buffer, n, wanted - n, position + n);
      if (!result.bytesRead) throw invalidMailExport();
      n += result.bytesRead;
    }
    position += n;
    for (let i = 0; i < n; i += 65) {
      const value = buffer.toString("ascii", i, i + 65);
      if (!/^[a-f0-9]{64}\n$/.test(value)) throw invalidMailExport();
      records++;
      yield value;
    }
  }
}

/** Verify the complete index before returning any source record, then validate
 * each bounded record against its frozen hash before it can drive local IO. */
export async function* readMailInventory(
  storage: string,
  plan: MailInventory,
  check: () => Promise<void>,
): AsyncGenerator<MailExportItem> {
  const directory = join(storage, plan.name),
    path = join(directory, "index");
  await check();
  await checkMailExportDirectory(directory, plan.identity);
  const index = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const frozen = await index.stat({ bigint: true });
    mailExportPrivateStat(frozen, false);
    if (
      !sameMailExportIdentity(frozen, plan.indexIdentity) ||
      frozen.size !== BigInt(plan.count) * 65n
    )
      throw invalidMailExport();
    const unchanged = async () => {
      await check();
      await checkMailExportDirectory(directory, plan.identity);
      const current = await index.stat({ bigint: true }),
        named = await lstat(path, { bigint: true });
      mailExportPrivateStat(named, false);
      if (
        !sameMailExportIdentity(named, plan.indexIdentity) ||
        current.size !== frozen.size ||
        current.mtimeNs !== frozen.mtimeNs ||
        current.ctimeNs !== frozen.ctimeNs
      )
        throw invalidMailExport();
    };
    const hash = createHash("sha256");
    for await (const value of hashes(index, plan.count, unchanged))
      hash.update(value);
    if (hash.digest("hex") !== plan.hash) throw invalidMailExport();
    let i = 0;
    let recordBuffer = Buffer.alloc(0);
    for await (const value of hashes(index, plan.count, unchanged)) {
      await unchanged();
      const h = await open(
        join(directory, `${i++}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let data: Buffer;
      try {
        const s = await h.stat({ bigint: true });
        mailExportPrivateStat(s, false);
        if (s.size > BigInt(maximumRecordBytes)) throw invalidMailExport();
        // Read exactly the inspected bounded length, never an unbounded readFile.
        if (recordBuffer.length < Number(s.size))
          recordBuffer = Buffer.alloc(Number(s.size));
        data = recordBuffer.subarray(0, Number(s.size));
        let n = 0;
        while (n < data.length) {
          const r = await h.read(data, n, data.length - n, n);
          if (!r.bytesRead) throw invalidMailExport();
          n += r.bytesRead;
        }
        const after = await h.stat({ bigint: true });
        if (
          s.size !== after.size ||
          s.mtimeNs !== after.mtimeNs ||
          s.ctimeNs !== after.ctimeNs
        )
          throw invalidMailExport();
      } finally {
        await h.close();
      }
      if (createHash("sha256").update(data).digest("hex") !== value.trim())
        throw invalidMailExport();
      await unchanged();
      yield JSON.parse(data.toString("utf8")) as MailExportItem;
    }
  } finally {
    await index.close();
  }
}
