// Explicit local qualification: generated HTTP Mailbox, installed CLI child,
// deterministic 1MiB representations, bounded records and process RSS. No provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
const exec = promisify(execFile);
const [cli, probe] = process.argv.slice(2);
assert.ok(isAbsolute(cli) && isAbsolute(probe));
const directory = await mkdtemp(join(tmpdir(), "awp-mail-export-memory-"));
const id = (n) =>
  `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const body = "x".repeat(1_048_576),
  digest = createHash("sha256").update(body).digest("hex");
let count = 0,
  messageReads = 0;
function summary(n) {
  return {
    messageId: id(n + 10),
    mailboxId: id(3),
    direction: "incoming",
    operationId: null,
    createdAt: "2026-09-18T00:00:00Z",
    trashedAt: null,
    retainedBytes: 1_048_576,
    display: {},
    metadataOmissions: [],
    attachmentOmissions: 0,
  };
}
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const send = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.headers.authorization !== "Bearer local-memory-fixture")
    return send({ error: { code: "access_denied", message: "Denied" } }, 401);
  if (url.pathname === "/v1/access/account")
    return send({
      accountId: id(1),
      workplaceId: id(2),
      kind: "agent",
      role: "member",
      state: "active",
      workplaceState: "confirmed",
      cleanupAt: null,
      cleanupWarning: null,
      starter: null,
      free: {
        confirmedAt: "2026-09-17T00:00:00Z",
        periodStart: "2026-09-17T00:00:00Z",
        periodEnd: "2026-10-17T00:00:00Z",
        outboundUsed: 0,
        inboundUsed: 0,
        storageUsedBytes: count * 1_048_576,
        outboundLimit: 200,
        inboundLimit: 1000,
        storageLimit: "5 GB",
      },
    });
  if (url.searchParams.get("mailboxId") !== id(3)) return send({}, 400);
  if (url.pathname.endsWith("/checkpoint"))
    return send({ checkpoint: "before" });
  if (url.pathname.endsWith("/changes"))
    return send({
      state: "changes",
      items: [],
      nextCursor: null,
      checkpoint: "after",
    });
  if (url.pathname.endsWith("/preparations"))
    return send({ preparations: [], nextCursor: null });
  if (url.pathname.endsWith("/omissions"))
    return send({ omissions: [], nextCursor: null });
  if (url.pathname === "/v1/mail/messages") {
    if (url.searchParams.get("view") === "trash")
      return send({ messages: [], nextCursor: null });
    const offset = Number(url.searchParams.get("after") ?? 0),
      end = Math.min(count, offset + 100);
    return send({
      messages: Array.from({ length: end - offset }, (_, i) =>
        summary(i + offset),
      ),
      nextCursor: end < count ? String(end) : null,
    });
  }
  const match = /^\/v1\/mail\/messages\/([a-f0-9-]+)(\/attachments)?$/.exec(
    url.pathname,
  );
  if (match) {
    const n = parseInt(match[1].slice(0, 8), 16) - 10;
    if (n < 0 || n >= count) return send({}, 404);
    if (match[2])
      return send({
        messageId: id(n + 10),
        attachments: [],
        nextAfter: null,
        preparation: null,
      });
    messageReads++;
    return send({
      ...summary(n),
      text: { state: "present", content: body },
      html: { state: "absent" },
    });
  }
  return send({}, 404);
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = join(directory, "credentials.json");
  await writeFile(
    credentials,
    JSON.stringify({
      version: 1,
      kind: "account",
      origin,
      credential: {
        accountId: id(1),
        workplaceId: id(2),
        key: "local-memory-fixture",
      },
    }),
    { mode: 0o600 },
  );
  const results = [];
  for (const total of [16, 256]) {
    count = total;
    messageReads = 0;
    const output = join(directory, `output-${total}`),
      memory = join(directory, `memory-${total}.json`);
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "--import",
        probe,
        cli,
        "--credentials",
        credentials,
        "mail",
        "export",
        "--mailbox",
        id(3),
        "--scope",
        "mailbox",
        "--output",
        output,
        "--operation",
        join(directory, `operation-${total}.json`),
        "--json",
      ],
      {
        env: { NODE_ENV: "test", AWP_MEMORY_REPORT: memory },
        timeout: 180000,
        maxBuffer: 65536,
      },
    );
    assert.equal(stderr, "");
    const manifest = JSON.parse(stdout),
      usage = JSON.parse(await readFile(memory, "utf8"));
    assert.equal(manifest.state, "complete");
    assert.equal(manifest.copied, total);
    assert.equal(messageReads, total);
    assert.equal(manifest.plannedRecords, total * 2 + 4);
    for (let i = 0; i < total; i++) {
      const data = await readFile(join(output, `message-${id(i + 10)}.text`));
      assert.equal(data.length, 1_048_576);
      assert.equal(createHash("sha256").update(data).digest("hex"), digest);
    }
    results.push({
      messages: total,
      retainedBytes: total * 1_048_576,
      maxRSSKiB: usage.maxRSSKiB,
      peakHeap: usage.peak.heapUsed,
      peakArrayBuffers: usage.peak.arrayBuffers,
      phases: usage.phases ?? [],
    });
  }
  // Source grows sixteen-fold and exceeds this RSS guard. These are qualification
  // thresholds, not product memory limits; do not silently relax on a regression.
  process.stdout.write(
    JSON.stringify({
      runtime: process.version,
      generatedHttpFixture: true,
      results,
    }) + "\n",
  );
  assert.ok(results[1].maxRSSKiB * 1024 < 256 * 1024 * 1024);
  assert.ok(
    (results[1].maxRSSKiB - results[0].maxRSSKiB) * 1024 < 96 * 1024 * 1024,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
