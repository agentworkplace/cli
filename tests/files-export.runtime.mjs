// Actual built CLI process kills against deterministic HTTP fixtures. This is
// process-crash recovery evidence, not power-loss, provider or operator evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export async function testExportCrashRecovery(
  cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url)),
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "awp-export-crash-")),
  );
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    fileId = randomUUID(),
    revisionId = randomUUID();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 37);
  const file = {
    workplaceId,
    fileId,
    revisionId,
    version: randomUUID(),
    name: "runtime.bin",
    reference: `awp:file:${workplaceId}:${fileId}`,
    revisionReference: `awp:file:${workplaceId}:${fileId}:revision:${revisionId}`,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "application/octet-stream",
    actorId: accountId,
    createdAt: "2026-09-17T00:00:00.000Z",
  };
  let origin;
  let ranges = [];
  let listings = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/bytes") {
      assert.equal(request.headers.authorization, undefined);
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
      assert.ok(match);
      ranges.push(request.headers.range);
      const start = Number(match[1]),
        end = Number(match[2]);
      response.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "content-length": end - start + 1,
      });
      response.end(bytes.subarray(start, end + 1));
      return;
    }
    assert.equal(request.headers.authorization, "Bearer fixture");
    let value = file;
    if (url.pathname === "/v1/access/account")
      value = {
        accountId,
        workplaceId,
        kind: "agent",
        role: "member",
        state: "active",
        workplaceState: "unconfirmed",
        cleanupAt: "2026-09-18T00:00:00.000Z",
        cleanupWarning: null,
        starter: {
          outboundUsed: 0,
          inboundUsed: 0,
          storageUsedBytes: bytes.length,
          outboundLimit: 2,
          inboundLimit: 20,
          storageLimit: "100 MB",
        },
        free: null,
      };
    else if (url.pathname === "/v1/files/checkpoint")
      value = { checkpoint: "cursor.signature" };
    else if (url.pathname === "/v1/files/changes")
      value = {
        state: "changes",
        items: [],
        nextCursor: null,
        checkpoint: "cursor.signature",
      };
    else if (url.pathname === "/v1/files/entries") {
      listings++;
      value = {
        entries: [
          {
            workplaceId,
            entryId: fileId,
            kind: "file",
            parentId: null,
            name: file.name,
            version: file.version,
            actorId: accountId,
            changedAt: file.createdAt,
            reference: file.reference,
          },
        ],
        nextCursor: null,
      };
    } else if (url.pathname.endsWith("/download")) {
      assert.equal(url.searchParams.get("revisionId"), revisionId);
      value = {
        file,
        url: `${origin}/bytes`,
        expiresAt: "2026-09-17T00:01:00.000Z",
      };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = join(directory, "credentials.json");
  await writeFile(
    credentials,
    JSON.stringify({
      version: 1,
      kind: "account",
      origin,
      credential: { accountId, workplaceId, key: "fixture" },
    }),
    { mode: 0o600 },
  );
  const children = new Set();
  try {
    for (const boundary of ["inventory", "content"]) {
      ranges = [];
      listings = 0;
      const operation = join(directory, `${boundary}.json`),
        output = join(directory, `${boundary}-output`);
      function start(crash) {
        const args = crash
          ? [
              "--import",
              fileURLToPath(
                new URL("./fixtures/export-crash.mjs", import.meta.url),
              ),
            ]
          : [];
        args.push(
          cliEntry,
          "--credentials",
          credentials,
          "files",
          "get-folder",
          "root",
          "--output",
          output,
          "--operation",
          operation,
          "--json",
        );
        const child = spawn(process.execPath, args, {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          timeout: 35000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            AWP_TEST_EXPORT_BOUNDARY: crash ? boundary : "",
          },
        });
        children.add(child);
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const closed = once(child, "close").then(([code, signal]) => {
          children.delete(child);
          return { code, signal, stdout, stderr };
        });
        return { child, closed };
      }
      const first = start(true);
      const event = await Promise.race([
        once(first.child, "message").then(([message]) => message),
        first.closed.then((result) => {
          throw new Error(
            `Crash barrier not reached: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      assert.equal(event.boundary, boundary);
      first.child.kill("SIGKILL");
      const stopped = await first.closed;
      assert.equal(stopped.signal, "SIGKILL");
      assert.equal(stopped.stdout, "");
      const saved = JSON.parse(await readFile(operation, "utf8"));
      if (boundary === "inventory") {
        assert.equal(saved.inventoryHash, null);
        assert.equal(ranges.length, 0);
        assert.equal(listings, 0);
      } else {
        assert.match(saved.inventoryHash, /^[a-f0-9]{64}$/);
        const download = JSON.parse(
          await readFile(
            join(saved.storage, `download-${fileId}-${revisionId}.json`),
            "utf8",
          ),
        );
        assert.equal(download.offset, 8 * 1024 * 1024);
        assert.equal(listings, 1);
        ranges = [];
      }
      // Let the production lock expire naturally. No test-only lock removal.
      const resumed = await start(false).closed;
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(resumed.stderr, "");
      assert.equal(JSON.parse(resumed.stdout).state, "complete");
      assert.equal(JSON.parse(resumed.stdout).copied, 1);
      assert.equal(listings, 1);
      if (boundary === "content")
        assert.equal(ranges[0], `bytes=8388608-${bytes.length - 1}`);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(output, file.name)))
          .digest("hex"),
        file.sha256,
      );
      const manifest = JSON.parse(resumed.stdout).manifest;
      const records = (await readFile(manifest, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(records.at(-1).state, "complete");
      const repeated = await start(false).closed;
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.equal(JSON.parse(repeated.stdout).copied, 1);
      console.log(
        `Built CLI export process recovery ${boundary} passed on ${process.version}`,
      );
    }
  } finally {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
