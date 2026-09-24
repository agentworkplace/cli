import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  link,
  unlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace, type FileMetadata } from "@agent-workplace/sdk";
import { downloadFileLocally } from "../src/files-download.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "awp-download-test-"));
  directories.push(dir);
  const context = {
    origin: "https://api.test",
    accountId: randomUUID(),
    workplaceId: randomUUID(),
  };
  const ref = { workplaceId: context.workplaceId, fileId: randomUUID() };
  const revisionId = randomUUID();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 71);
  const file: FileMetadata = {
    ...ref,
    revisionId,
    version: randomUUID(),
    name: "bytes.bin",
    reference: `awp:file:${ref.workplaceId}:${ref.fileId}`,
    revisionReference: `awp:file:${ref.workplaceId}:${ref.fileId}:revision:${revisionId}`,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "application/octet-stream",
    actorId: context.accountId,
    createdAt: "2026-09-17T00:00:00.000Z",
  };
  const state = {
    interrupt: true,
    denied: false,
    ranges: [] as string[],
    pins: [] as (string | null)[],
  };
  const client = new AgentWorkplace({
    baseUrl: context.origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      state.pins.push(url.searchParams.get("revisionId"));
      if (state.denied)
        return Response.json(
          { error: { code: "access_denied", message: "Denied" } },
          { status: 403 },
        );
      return Response.json(
        url.pathname.endsWith("/download")
          ? {
              file,
              url: "https://bytes.test/content",
              expiresAt: "2026-09-17T00:01:00.000Z",
            }
          : file,
      );
    },
    transferFetch: async (input, init) => {
      const range = new Request(input, init).headers.get("range")!;
      state.ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]),
        end = Number(match[2]);
      if (state.interrupt && start > 0) throw new Error("fixture interruption");
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    },
  });
  const output = join(dir, "result"),
    operation = join(dir, "operation.json");
  const run = () =>
    downloadFileLocally(client, "key", context, { ref, output, operation });
  const receipt = async () => JSON.parse(await readFile(operation, "utf8"));
  return {
    dir,
    context,
    ref,
    file,
    bytes,
    state,
    client,
    output,
    operation,
    run,
    receipt,
  };
}
test("resumes durable progress, discards uncheckpointed suffix and verifies the completed output on retry", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toThrow();
  const r = await f.receipt();
  expect(r.offset).toBe(8 * 1024 * 1024);
  expect(r.state).toBe("partial");
  expect((await stat(f.operation)).mode & 0o777).toBe(0o600);
  expect((await stat(r.directory)).mode & 0o777).toBe(0o700);
  await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  // Simulate bytes written after the durable checkpoint, then process loss.
  await writeFile(
    join(r.directory, "content"),
    Buffer.concat([
      f.bytes.subarray(0, r.offset),
      Buffer.from("untrusted suffix"),
    ]),
  );
  f.state.interrupt = false;
  f.state.ranges = [];
  await f.run();
  expect(f.state.ranges).toEqual([`bytes=${r.offset}-${f.bytes.length - 1}`]);
  expect(
    createHash("sha256")
      .update(await readFile(f.output))
      .digest("hex"),
  ).toBe(f.file.sha256);
  expect((await stat(f.output)).mode & 0o777).toBe(0o600);
  expect((await f.receipt()).state).toBe("complete");
  await expect(stat(r.directory)).rejects.toMatchObject({ code: "ENOENT" });
  f.state.ranges = [];
  await f.run();
  expect(f.state.ranges).toEqual([]);
  await writeFile(f.output, Buffer.alloc(f.bytes.length, 2));
  await expect(f.run()).rejects.toThrow("integrity");
});
test.each(["verified", "complete"])(
  "recovers %s promotion crash state without replacing output",
  async (state) => {
    const f = await fixture();
    await expect(f.run()).rejects.toThrow();
    const r = await f.receipt();
    const part = join(r.directory, "content");
    await writeFile(part, f.bytes);
    await link(part, f.output);
    await writeFile(
      f.operation,
      JSON.stringify({ ...r, offset: f.bytes.length, state }),
    );
    const inode = (await stat(f.output)).ino;
    f.state.interrupt = false;
    f.state.ranges = [];
    await f.run();
    expect((await stat(f.output)).ino).toBe(inode);
    expect(f.state.ranges).toEqual([]);
    await expect(stat(r.directory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
test.each(["symlink", "inode"])(
  "rejects replaced partial %s without modifying the replacement",
  async (kind) => {
    const f = await fixture();
    await expect(f.run()).rejects.toThrow();
    const r = await f.receipt();
    const part = join(r.directory, "content");
    const unrelated = join(f.dir, "unrelated");
    await writeFile(unrelated, "preserve", { mode: 0o600 });
    await unlink(part);
    if (kind === "symlink") await symlink(unrelated, part);
    else await link(unrelated, part);
    f.state.interrupt = false;
    await expect(f.run()).rejects.toThrow();
    expect(await readFile(unrelated, "utf8")).toBe("preserve");
  },
);
test("restart checks current authority and account binding before modifying a partial", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toThrow();
  const r = await f.receipt();
  const part = join(r.directory, "content");
  f.state.denied = true;
  f.state.ranges = [];
  await expect(f.run()).rejects.toThrow("Denied");
  expect((await stat(part)).size).toBe(r.offset);
  expect(f.state.ranges).toEqual([]);
  f.state.denied = false;
  await expect(
    downloadFileLocally(
      f.client,
      "key",
      { ...f.context, accountId: randomUUID() },
      { ref: f.ref, output: f.output, operation: f.operation },
    ),
  ).rejects.toThrow("another");
  expect((await stat(part)).size).toBe(r.offset);
});

test("unrecorded creation ownership fails closed and preserves unknown content", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toThrow();
  const r = await f.receipt();
  const part = join(r.directory, "content");
  await writeFile(part, "");
  await writeFile(
    f.operation,
    JSON.stringify({ ...r, offset: 0, state: "planned", fileIdentity: null }),
  );
  await expect(f.run()).rejects.toThrow("ownership was not recorded");
  expect(await readFile(part, "utf8")).toBe("");
  await writeFile(
    f.operation,
    JSON.stringify({
      ...r,
      offset: 0,
      state: "planned",
      fileIdentity: null,
      directoryIdentity: null,
    }),
  );
  await expect(f.run()).rejects.toThrow("ownership was not recorded");
  expect((await stat(r.directory)).isDirectory()).toBe(true);
});

test("refuses a preexisting destination and does not change its bytes", async () => {
  const f = await fixture();
  await writeFile(f.output, "unrelated");
  await expect(f.run()).rejects.toThrow("already exists");
  expect(await readFile(f.output, "utf8")).toBe("unrelated");
  expect(f.state.ranges).toEqual([]);
});

test("write failure preserves the checkpoint and does not publish a partial destination", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toThrow();
  const before = await f.receipt();
  // Fail only the opened content descriptor, after an actual successful write.
  const fs = (await import("node:fs")).default.promises;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.open;
  let injectedWrites = 0;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) === join(before.directory, "content")) {
      const write = handle.write.bind(handle);
      handle.write = (async (...args: Parameters<typeof write>) => {
        await write(...args);
        injectedWrites++;
        throw Object.assign(new Error("fixture full disk"), { code: "ENOSPC" });
      }) as typeof handle.write;
    }
    return handle;
  });
  syncBuiltinESMExports();
  f.state.interrupt = false;
  try {
    await expect(f.run()).rejects.toThrow();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  expect(injectedWrites).toBe(1);
  expect((await f.receipt()).offset).toBe(before.offset);
  await expect(stat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  await f.run();
  expect(
    createHash("sha256")
      .update(await readFile(f.output))
      .digest("hex"),
  ).toBe(f.file.sha256);
});
