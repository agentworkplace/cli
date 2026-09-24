import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  readdir,
  rename,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  AgentWorkplace,
  type FilesEntry,
  type FileMetadata,
} from "@agent-workplace/sdk";
import { exportFilesLocally } from "../src/files-export.js";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
async function fixture(large = false) {
  const dir = await mkdtemp(join(tmpdir(), "awp-export-test-"));
  dirs.push(dir);
  const context = {
      origin: "https://api.test",
      accountId: id(1),
      workplaceId: id(2),
    },
    version = id(3),
    checkpoint = "cursor.signature";
  const bytes = Buffer.alloc(large ? 8 * 1024 * 1024 + 17 : 3, 71),
    hash = createHash("sha256").update(bytes).digest("hex");
  const entry = (
    n: number,
    name = `file-${n}`,
    kind: "file" | "folder" = "file",
    parentId: string | null = null,
  ): FilesEntry => ({
    workplaceId: context.workplaceId,
    entryId: id(n),
    name,
    kind,
    parentId,
    version,
    actorId: context.accountId,
    changedAt: "2026-09-17T00:00:00.000Z",
    reference: `awp:${kind}:${context.workplaceId}:${id(n)}`,
  });
  const file = (n: number, revision = 100 + n): FileMetadata => ({
    workplaceId: context.workplaceId,
    fileId: id(n),
    revisionId: id(revision),
    name: state.entries.find((e) => e.entryId === id(n))?.name ?? `file-${n}`,
    version,
    reference: `awp:file:${context.workplaceId}:${id(n)}`,
    revisionReference: `awp:file:${context.workplaceId}:${id(n)}:revision:${id(revision)}`,
    byteLength: bytes.length,
    sha256: state.wrongHash ? "f".repeat(64) : hash,
    contentType: "application/octet-stream",
    actorId: context.accountId,
    createdAt: "2026-09-17T00:00:00.000Z",
  });
  const state = {
    entries: [] as FilesEntry[],
    denied: false,
    planningFail: false,
    interrupt: false,
    gap: false,
    wrongHash: false,
    ranges: [] as string[],
    listCalls: 0,
    changesCalls: 0,
    grantHook: undefined as undefined | (() => Promise<void>),
    afterInventory: undefined as undefined | (() => Promise<void>),
  };
  state.entries = [entry(10)];
  const client = new AgentWorkplace({
    baseUrl: context.origin,
    fetch: async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      if (state.denied)
        return Response.json(
          { error: { code: "access_denied", message: "Denied" } },
          { status: 403 },
        );
      if (url.pathname === "/v1/access/account")
        return Response.json({
          accountId: context.accountId,
          workplaceId: context.workplaceId,
          kind: "agent",
          role: "member",
          state: "active",
          workplaceState: "confirmed",
          cleanupAt: null,
          cleanupWarning: null,
          starter: null,
          free: {
            confirmedAt: "2026-09-17T00:00:00.000Z",
            periodStart: "2026-09-17T00:00:00.000Z",
            periodEnd: "2026-10-17T00:00:00.000Z",
            outboundUsed: 0,
            inboundUsed: 0,
            storageUsedBytes: 0,
            outboundLimit: 200,
            inboundLimit: 1000,
            storageLimit: "5 GB",
          },
        });
      if (url.pathname.endsWith("/checkpoint"))
        return Response.json({ checkpoint });
      if (url.pathname.endsWith("/changes")) {
        state.changesCalls++;
        if (state.changesCalls === 1) await state.afterInventory?.();
        return Response.json(
          state.gap
            ? {
                state: "gap",
                reason: "history_expired",
                baselineRequired: true,
              }
            : { state: "changes", items: [], nextCursor: null, checkpoint },
        );
      }
      if (url.pathname === "/v1/files/entries") {
        state.listCalls++;
        if (state.planningFail) throw new Error("Lost inventory");
        return Response.json({
          entries: state.entries
            .filter(
              (e) =>
                e.parentId === (url.searchParams.get("parentId") ?? null) &&
                e.entryId > (url.searchParams.get("after") ?? ""),
            )
            .slice(0, 100),
          nextCursor:
            state.entries.filter(
              (e) =>
                e.parentId === (url.searchParams.get("parentId") ?? null) &&
                e.entryId > (url.searchParams.get("after") ?? ""),
            ).length > 100
              ? state.entries.filter(
                  (e) =>
                    e.parentId === (url.searchParams.get("parentId") ?? null) &&
                    e.entryId > (url.searchParams.get("after") ?? ""),
                )[99]!.entryId
              : null,
        });
      }
      if (url.pathname === "/v1/files/baseline")
        return Response.json({
          entries: state.entries.map((e) => ({
            ...e,
            trashedAt: e.entryId === id(20) ? "2026-09-17T00:00:00.000Z" : null,
            trashExpiresAt:
              e.entryId === id(20) ? "2026-09-24T00:00:00.000Z" : null,
            clearingHistory: false,
          })),
          nextCursor: null,
        });
      if (url.pathname.startsWith("/v1/files/entries/"))
        return Response.json(
          state.entries.find(
            (e) => e.entryId === url.pathname.split("/").at(-1),
          ),
        );
      const n = parseInt(url.pathname.split("/")[3]!, 16);
      if (url.pathname.endsWith("/revisions"))
        return Response.json({
          revisions: [
            {
              ...file(n, 200 + n),
              isCurrent: false,
              expiresAt: "2026-09-18T00:00:00.000Z",
              restoredFromRevisionId: null,
            },
            {
              ...file(n, 300 + n),
              isCurrent: true,
              expiresAt: null,
              restoredFromRevisionId: id(200 + n),
            },
          ],
          nextCursor: null,
        });
      const revision = url.searchParams.get("revisionId");
      const metadata = file(n, revision ? parseInt(revision, 16) : 100 + n);
      if (url.pathname.endsWith("/download")) {
        await state.grantHook?.();
        return Response.json({
          file: metadata,
          url: "https://bytes.test/content",
          expiresAt: "2026-09-17T00:01:00.000Z",
        });
      }
      return Response.json(metadata);
    },
    transferFetch: async (input, init) => {
      const range = new Request(input, init).headers.get("range")!;
      state.ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]),
        end = Number(match[2]);
      if (state.interrupt && start > 0) throw new Error("Lost bytes");
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    },
  });
  const output = join(dir, "output"),
    operation = join(dir, "operation.json");
  const run = (mode: "current" | "retained" = "current") =>
    exportFilesLocally(client, "fixture-export-secret", context, {
      mode,
      output,
      operation,
    });
  const receipt = async () => JSON.parse(await readFile(operation, "utf8"));
  return {
    dir,
    context,
    entry,
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
test("freezes a current tree, creates empty folders and verifies completed retries", async () => {
  const f = await fixture();
  f.state.entries = [
    f.entry(10, "folder", "folder"),
    f.entry(20, "empty", "folder"),
    f.entry(30, "data", "file", id(10)),
  ];
  const result = await f.run();
  expect(result).toMatchObject({
    state: "complete",
    copied: 1,
    folders: 2,
    plannedFiles: 1,
  });
  expect(await readFile(join(f.output, "folder", "data"))).toEqual(f.bytes);
  expect(await readdir(join(f.output, "empty"))).toEqual([]);
  const calls = f.state.listCalls;
  expect(await f.run()).toMatchObject({ state: "complete", copied: 1 });
  expect(f.state.listCalls).toBe(calls);
  expect((await stat(f.operation)).size).toBeLessThan(16384);
  expect(await readFile(result.manifest, "utf8")).not.toContain(
    "fixture-export-secret",
  );
});
test("retained export copies history and trash with relationships in the manifest", async () => {
  const f = await fixture();
  f.state.entries = [
    f.entry(10),
    f.entry(20, "trashed"),
    f.entry(30, "empty", "folder"),
  ];
  const result = await f.run("retained");
  expect(result).toMatchObject({
    state: "complete",
    copied: 4,
    plannedFiles: 4,
  });
  expect(await readFile(join(f.output, "files", id(20), id(220)))).toEqual(
    f.bytes,
  );
  const manifest = await readFile(result.manifest, "utf8");
  expect(manifest).toContain('"trashedAt":"2026-09-17T00:00:00.000Z"');
  expect(manifest).toContain('"isCurrent":false');
  expect(manifest).toContain('"name":"empty"');
});
test("reports unsafe names and local collisions without overwriting", async () => {
  const f = await fixture();
  f.state.entries = [
    f.entry(10, "same"),
    f.entry(20, "same"),
    f.entry(30, ".."),
  ];
  const result = await f.run();
  expect(result).toMatchObject({
    state: "partial",
    copied: 1,
    failed: 2,
    plannedFiles: 3,
  });
  expect(await readFile(join(f.output, "same"))).toEqual(f.bytes);
  const manifest = await readFile(result.manifest, "utf8");
  expect(manifest).toContain("unsafe_path");
  expect(manifest).toContain('"kind":"failure"');
});
test("restarts interrupted inventory without fetching content or trusting a partial plan", async () => {
  const f = await fixture();
  f.state.planningFail = true;
  await expect(f.run()).rejects.toThrow();
  expect(f.state.ranges).toEqual([]);
  expect((await f.receipt()).inventoryHash).toBeNull();
  f.state.planningFail = false;
  expect(await f.run()).toMatchObject({ state: "complete", copied: 1 });
});
test("resumes a failed per-file download with its pinned revision", async () => {
  const f = await fixture(true);
  f.state.interrupt = true;
  expect(await f.run()).toMatchObject({ state: "partial", copied: 0 });
  const r = await f.receipt();
  const download = JSON.parse(
    await readFile(
      join(r.storage, `download-${id(10)}-${id(110)}.json`),
      "utf8",
    ),
  );
  expect(download.offset).toBe(8 * 1024 * 1024);
  f.state.interrupt = false;
  f.state.ranges = [];
  expect(await f.run()).toMatchObject({ state: "complete", copied: 1 });
  expect(f.state.ranges[0]).toBe(
    `bytes=${8 * 1024 * 1024}-${f.bytes.length - 1}`,
  );
  // A generic deep matcher expands every Buffer index. Compare every byte
  // directly instead, and prove that corruption of the final byte is detected.
  const output = await readFile(join(f.output, "file-10"));
  expect(output.equals(f.bytes)).toBe(true);
  output[output.length - 1] = output[output.length - 1]! ^ 1;
  expect(output.equals(f.bytes)).toBe(false);
}, 30000);
test("rechecks authority on completed retry and reports incomplete change coverage", async () => {
  const f = await fixture();
  expect(await f.run()).toMatchObject({ state: "complete" });
  f.state.denied = true;
  expect(await f.run()).toMatchObject({
    state: "partial",
    stopped: true,
    copied: 0,
  });
  expect(await readFile(join(f.output, "file-10"))).toEqual(f.bytes);
  f.state.denied = false;
  f.state.gap = true;
  expect(await f.run()).toMatchObject({
    state: "partial",
    workplaceChanges: "unknown",
  });
});
test("rejects substituted roots and altered inventory without content IO", async () => {
  const f = await fixture();
  await f.run();
  const moved = join(f.dir, "moved");
  await rename(f.output, moved);
  await symlink(moved, f.output);
  f.state.ranges = [];
  await expect(f.run()).rejects.toThrow();
  expect(f.state.ranges).toEqual([]);
  const g = await fixture();
  await g.run();
  const r = await g.receipt();
  await writeFile(join(r.storage, "inventory.ndjson"), "{}\n");
  g.state.ranges = [];
  await expect(g.run()).rejects.toThrow();
  expect(g.state.ranges).toEqual([]);
});
test("rejects changed pinned metadata before requesting bytes", async () => {
  const f = await fixture();
  f.state.afterInventory = async () => {
    f.state.wrongHash = true;
  };
  expect(await f.run()).toMatchObject({ state: "partial", copied: 0 });
  expect(f.state.ranges).toEqual([]);
  await expect(stat(join(f.output, "file-10"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("CLI partial results are structured on stdout and fail with safe stderr", async () => {
  const f = await fixture();
  f.state.entries = [f.entry(10, "..")];
  const credentials = join(f.dir, "credentials.json");
  await withCredentials(credentials, (s) =>
    s.write({
      version: 1,
      kind: "account",
      origin: f.context.origin,
      credential: {
        accountId: f.context.accountId,
        workplaceId: f.context.workplaceId,
        key: "fixture-export-secret",
      },
    }),
  );
  let stdout = "",
    stderr = "";
  const code = await runCli(
    [
      "--credentials",
      credentials,
      "files",
      "get-folder",
      "root",
      "--output",
      f.output,
      "--operation",
      f.operation,
      "--json",
    ],
    {
      version: "0.0.0",
      createProductClient: () => f.client,
      writeOut: (v) => {
        stdout += v;
      },
      writeErr: (v) => {
        stderr += v;
      },
    },
  );
  expect(code).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ state: "partial", failed: 1 });
  expect(JSON.parse(stderr).error.message).toContain("Export is partial");
  expect(stdout + stderr).not.toContain("fixture-export-secret");
});

test.each(["symlink", "inode"])(
  "refuses nested %s substitution during download",
  async (kind) => {
    const f = await fixture();
    f.state.entries = [
      f.entry(10, "nested", "folder"),
      f.entry(20, "data", "file", id(10)),
    ];
    const outside = join(f.dir, "outside");
    await mkdir(outside, { mode: 0o700 });
    f.state.grantHook = async () => {
      f.state.grantHook = undefined;
      await rename(join(f.output, "nested"), join(f.dir, "old-nested"));
      if (kind === "symlink") await symlink(outside, join(f.output, "nested"));
      else await mkdir(join(f.output, "nested"), { mode: 0o700 });
    };
    expect(await f.run()).toMatchObject({ state: "partial", copied: 0 });
    expect(await readdir(outside)).toEqual([]);
    await expect(stat(join(f.output, "nested", "data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
test("never adopts an existing destination and rejects receipts nested through path aliases", async () => {
  const f = await fixture();
  await mkdir(f.output, { mode: 0o700 });
  await writeFile(join(f.output, "owned"), "preserve");
  await expect(f.run()).rejects.toThrow("already exists");
  expect(await readFile(join(f.output, "owned"), "utf8")).toBe("preserve");
  expect(f.state.listCalls).toBe(0);
  const g = await fixture();
  await expect(
    exportFilesLocally(g.client, "fixture-export-secret", g.context, {
      mode: "current",
      output: g.output,
      operation: join(g.output, "operation.json"),
    }),
  ).rejects.toThrow("outside");
  await expect(stat(g.output)).rejects.toMatchObject({ code: "ENOENT" });
});
test("detects same-inode plan mutation during content transfer before trusting another record", async () => {
  const f = await fixture();
  f.state.entries = [f.entry(10), f.entry(20)];
  f.state.grantHook = async () => {
    f.state.grantHook = undefined;
    const r = await f.receipt();
    await writeFile(join(r.storage, "inventory.ndjson"), "{}\n");
  };
  await expect(f.run()).rejects.toThrow("inventory changed");
  await expect(stat(join(f.output, "file-20"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("keeps the receipt small with a paged disk-backed inventory and reports unattempted files", async () => {
  const f = await fixture();
  f.state.entries = Array.from({ length: 1000 }, (_, i) => f.entry(i + 10));
  f.state.afterInventory = async () => {
    f.state.denied = true;
  };
  const result = await f.run();
  expect(result).toMatchObject({
    state: "partial",
    plannedFiles: 1000,
    copied: 0,
    stopped: true,
    unattempted: 999,
  });
  expect(f.state.listCalls).toBe(10);
  expect((await stat(f.operation)).size).toBeLessThan(16384);
  expect((await stat(result.inventory)).size).toBeGreaterThan(500000);
}, 30000);

test("does not merge distinct observed folders that have the same destination", async () => {
  const f = await fixture();
  f.state.entries = [
    f.entry(10, "same", "folder"),
    f.entry(20, "same", "folder"),
    f.entry(30, "child", "file", id(20)),
  ];
  expect(await f.run()).toMatchObject({
    state: "partial",
    folders: 1,
    copied: 0,
    failed: 2,
  });
});

test("preserves complete manifest records and removes an interrupted final append", async () => {
  const f = await fixture();
  const result = await f.run();
  const original = await readFile(result.manifest, "utf8");
  await writeFile(result.manifest, original + '{"attempt":"interrupted');
  expect(await f.run()).toMatchObject({ state: "complete", copied: 1 });
  const resumed = await readFile(result.manifest, "utf8");
  expect(resumed.startsWith(original)).toBe(true);
  expect(resumed).not.toContain('"interrupted');
  for (const line of resumed.trim().split("\n"))
    expect(JSON.parse(line)).toHaveProperty("attempt");
});
