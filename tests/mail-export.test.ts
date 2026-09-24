import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { AgentWorkplace, type MailMessage } from "@agent-workplace/sdk";
import { exportMailLocally } from "../src/mail-export.js";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
async function fixture(size = 3) {
  const dir = await mkdtemp(join(tmpdir(), "awp-mail-export-test-"));
  dirs.push(dir);
  const context = {
    origin: "https://api.test",
    accountId: id(1),
    workplaceId: id(2),
  };
  const bytes = Buffer.alloc(size, 71),
    digest = createHash("sha256").update(bytes).digest("hex");
  const message: MailMessage = {
    messageId: id(4),
    mailboxId: id(3),
    direction: "incoming",
    operationId: null,
    createdAt: "2026-09-18T00:00:00Z",
    trashedAt: null,
    retainedBytes: 5,
    display: {},
    metadataOmissions: [],
    attachmentOmissions: 0,
    text: { state: "present", content: "hello" },
    html: { state: "absent" },
  };
  const part = {
    attachmentId: id(5),
    ordinal: 0,
    filename: "../../unsafe.html",
    contentType: "text/html",
    disposition: "attachment",
    contentId: null,
    state: "retained",
    bytes: size,
    sha256: digest,
  };
  const state = {
    interrupted: false,
    denied: false,
    purged: false,
    wrongHash: false,
    gap: false,
    pending: false,
    unknown: false,
    largeBody: false,
    reads: 0,
    grants: 0,
    transfers: 0,
    afterInventory: undefined as (() => Promise<void>) | undefined,
  };
  const client = new AgentWorkplace({
    baseUrl: context.origin,
    fetch: async (input, init) => {
      const u = new URL(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-secret",
      );
      if (u.pathname === "/v1/access/account")
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
            confirmedAt: "2026-09-17T00:00:00Z",
            periodStart: "2026-09-17T00:00:00Z",
            periodEnd: "2026-10-17T00:00:00Z",
            outboundUsed: 0,
            inboundUsed: 0,
            storageUsedBytes: 0,
            outboundLimit: 200,
            inboundLimit: 1000,
            storageLimit: "5 GB",
          },
        });
      expect(u.searchParams.get("mailboxId")).toBe(id(3));
      if (u.pathname.endsWith("/checkpoint"))
        return Response.json({ checkpoint: "before" });
      if (u.pathname.endsWith("/changes")) {
        await state.afterInventory?.();
        state.afterInventory = undefined;
        return Response.json(
          state.gap
            ? {
                state: "gap",
                reason: "history_expired",
                baselineRequired: true,
              }
            : {
                state: "changes",
                items: [],
                nextCursor: null,
                checkpoint: "after",
              },
        );
      }
      if (u.pathname.endsWith("/download")) {
        state.grants++;
        if (state.denied || state.purged)
          return Response.json(
            {
              error: {
                code: state.denied ? "access_denied" : "not_found",
                message: "Unavailable",
              },
            },
            { status: state.denied ? 403 : 404 },
          );
        return Response.json({
          messageId: id(4),
          attachment: {
            ...part,
            sha256: state.wrongHash ? "f".repeat(64) : digest,
          },
          url: "https://blob.test/content",
          expiresAt: "2030-01-01T00:00:00Z",
        });
      }
      if (u.pathname.endsWith("/attachments"))
        return Response.json({
          messageId: id(4),
          attachments: [part],
          nextAfter: null,
          preparation: state.pending
            ? {
                state: "pending",
                expiresAt: "2026-09-19T00:00:00Z",
                registeredParts: 1,
                totalParts: 2,
              }
            : null,
        });
      if (u.pathname.endsWith(`/messages/${id(4)}`)) {
        state.reads++;
        return Response.json({
          ...message,
          ...(state.largeBody
            ? {
                retainedBytes: 1_048_576,
                text: { state: "present", content: "\u0000".repeat(1_048_576) },
              }
            : {}),
          html: state.unknown ? { state: "unknown" } : message.html,
        });
      }
      throw new Error(`Unexpected fixture path ${u.pathname}`);
    },
    transferFetch: async (_input, init) => {
      state.transfers++;
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      if (state.interrupted) throw new Error("Offline");
      return new Response(bytes);
    },
  });
  const input = {
    mailboxId: id(3),
    scope: { kind: "message" as const, messageId: id(4) },
    output: join(dir, "export"),
    operation: join(dir, "operation.json"),
  };
  return {
    message,
    dir,
    context,
    client,
    input,
    state,
    bytes,
    digest,
    run: () => exportMailLocally(client, "fixture-secret", context, input),
  };
}
test("Exports exact bodies and full10MB attachment using generated names and a truthful manifest", async () => {
  const f = await fixture(10_000_000);
  const result = await f.run();
  expect(result).toMatchObject({
    state: "complete",
    copied: 2,
    failed: 0,
    coverage: "non_snapshot",
  });
  expect(
    await readFile(join(f.input.output, `message-${id(4)}.text`), "utf8"),
  ).toBe("hello");
  const bytes = await readFile(join(f.input.output, `attachment-${id(5)}.bin`));
  expect(bytes.length).toBe(10_000_000);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.digest);
  expect((await stat(f.input.output)).mode & 0o777).toBe(0o700);
  const metadata = JSON.parse(
    await readFile(join(f.input.output, "record-2.json"), "utf8"),
  );
  expect(metadata.page.attachments[0].filename).toBe("../../unsafe.html");
  expect(metadata.paths[id(5)]).toBe(`attachment-${id(5)}.bin`);
  expect(JSON.parse(await readFile(result.manifest, "utf8"))).toEqual(result);
});
test("Retries interrupted byte transfer against the same inventory and skips completed local copies after purge", async () => {
  const f = await fixture();
  f.state.interrupted = true;
  const first = await f.run();
  expect(first).toMatchObject({ state: "partial", copied: 1, failed: 1 });
  f.state.interrupted = false;
  const second = await f.run();
  expect(second).toMatchObject({ state: "complete", copied: 2 });
  expect(second.inventory).toBe(first.inventory);
  expect(f.state.reads).toBe(1);
  expect(f.state.grants).toBe(2);
  f.state.purged = true;
  expect(await f.run()).toMatchObject({ state: "complete", copied: 2 });
  expect(f.state.grants).toBe(2);
});
test("Source purge and authority loss produce explicit partial results; denial stops later records", async () => {
  const f = await fixture();
  f.state.purged = true;
  expect(await f.run()).toMatchObject({
    state: "partial",
    failed: 1,
    stopped: false,
  });
  const g = await fixture();
  g.state.denied = true;
  expect(await g.run()).toMatchObject({
    state: "partial",
    failed: 1,
    stopped: true,
    unattemptedRecords: 1,
  });
  expect(g.state.transfers).toBe(0);
});
test("Recovery refuses inventory tampering before another source request", async () => {
  const f = await fixture();
  f.state.interrupted = true;
  const result = await f.run();
  await writeFile(join(result.inventory, "1.json"), "{}");
  const calls = f.state.grants;
  await expect(f.run()).rejects.toThrow("inventory");
  expect(f.state.grants).toBe(calls);
});
test("Local filename collision is preserved and reported instead of overwritten", async () => {
  const f = await fixture();
  f.state.afterInventory = async () => {
    await writeFile(
      join(f.input.output, `message-${id(4)}.text`),
      "private local work",
      { mode: 0o600 },
    );
  };
  expect(await f.run()).toMatchObject({
    state: "partial",
    failed: 1,
    copied: 1,
  });
  expect(
    await readFile(join(f.input.output, `message-${id(4)}.text`), "utf8"),
  ).toBe("private local work");
});
test("Pending preparations, unknown bodies and checkpoint gaps never claim complete coverage", async () => {
  const f = await fixture();
  f.state.pending = true;
  f.state.unknown = true;
  f.state.gap = true;
  expect(await f.run()).toMatchObject({
    state: "partial",
    pendingPreparation: true,
    unknownBodies: 1,
    mailboxChanges: "unknown",
  });
  expect(
    (await readdir(f.input.output)).some((name) => name.endsWith(".html")),
  ).toBe(false);
});
test("Changed immutable attachment metadata cannot publish substitute bytes", async () => {
  const f = await fixture();
  f.state.wrongHash = true;
  expect(await f.run()).toMatchObject({
    state: "partial",
    copied: 1,
    failed: 1,
  });
  await expect(
    stat(join(f.input.output, `attachment-${id(5)}.bin`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
test("CLI partial output remains structured and nonzero without exposing credentials", async () => {
  const f = await fixture();
  f.state.purged = true;
  const credentials = join(f.dir, "credentials.json");
  await withCredentials(credentials, (s) =>
    s.write({
      version: 1,
      kind: "account",
      origin: f.context.origin,
      credential: {
        accountId: f.context.accountId,
        workplaceId: f.context.workplaceId,
        key: "fixture-secret",
      },
    }),
  );
  let stdout = "",
    stderr = "";
  const code = await runCli(
    [
      "--credentials",
      credentials,
      "mail",
      "export",
      "--mailbox",
      id(3),
      "--scope",
      "message",
      "--message",
      id(4),
      "--output",
      f.input.output,
      "--operation",
      f.input.operation,
      "--json",
    ],
    {
      version: "0.0.0",
      createProductClient: () => f.client,
      writeOut: (s) => {
        stdout += s;
      },
      writeErr: (s) => {
        stderr += s;
      },
    },
  );
  expect(code).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ state: "partial", failed: 1 });
  expect(JSON.parse(stderr).error.message).toContain("Mail export is partial");
  expect(stdout + stderr).not.toContain("fixture-secret");
});

test("Interrupted discovery restarts with a fresh private inventory and publishes no unfinished plan", async () => {
  const f = await fixture();
  f.state.afterInventory = async () => {
    throw new Error("Interrupted discovery");
  };
  await expect(f.run()).rejects.toThrow();
  expect(await readdir(f.input.output)).toEqual([]);
  const receipt = JSON.parse(await readFile(f.input.operation, "utf8"));
  expect(receipt.inventory).toBeNull();
  f.state.afterInventory = undefined;
  expect(await f.run()).toMatchObject({ state: "complete" });
  expect(f.state.reads).toBe(2);
  expect(
    (await readdir(receipt.storage)).filter((name) =>
      name.startsWith("inventory-"),
    ),
  ).toHaveLength(2);
});

test("Maximum escaped retained representation is exported without a metadata line-size truncation", async () => {
  const f = await fixture();
  f.state.largeBody = true;
  expect(await f.run()).toMatchObject({ state: "complete" });
  const body = await readFile(join(f.input.output, `message-${id(4)}.text`));
  expect(body.length).toBe(1_048_576);
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    createHash("sha256").update(Buffer.alloc(1_048_576)).digest("hex"),
  );
  const metadata = JSON.parse(
    await readFile(join(f.input.output, "record-1.json"), "utf8"),
  );
  expect(metadata.message.text).toMatchObject({
    state: "present",
    bytes: 1_048_576,
  });
  expect(metadata.message.text).not.toHaveProperty("content");
});

test("Chunked inventory preserves surrogate pairs, quotes and control characters in both representations", async () => {
  const f = await fixture();
  const text = "a".repeat(16383) + '😀\\"\n\u0000' + "中".repeat(17000);
  const html = "<p>" + "b".repeat(16380) + '😀"\\\n</p>';
  f.message.text = { state: "present", content: text };
  f.message.html = { state: "present", content: html };
  f.message.retainedBytes = Buffer.byteLength(text) + Buffer.byteLength(html);
  expect(await f.run()).toMatchObject({ state: "complete", copied: 3 });
  expect(
    await readFile(join(f.input.output, `message-${id(4)}.text`), "utf8"),
  ).toBe(text);
  expect(
    await readFile(join(f.input.output, `message-${id(4)}.html`), "utf8"),
  ).toBe(html);
});
