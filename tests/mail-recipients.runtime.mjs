// Installed/built clients against deterministic loopback HTTP. This proves wire
// and private-request compatibility, not provider delivery or backend accounting.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function testMailRecipients({
  cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url)),
  sdkUrl = "@agent-workplace/sdk",
} = {}) {
  const { AgentWorkplace, parseMailSendRequest, parseMailComposeRequest } =
    await import(sdkUrl);
  const dir = await mkdtemp(join(tmpdir(), "awp-mail-recipients-"));
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    mailboxId = randomUUID();
  let operation = join(dir, "operation.json");
  const credentials = join(dir, "credentials.json"),
    body = join(dir, "body.txt");
  const attachmentsFile = join(dir, "attachments.json");
  const attachments = [
    {
      kind: "files",
      workplaceId,
      fileId: randomUUID(),
      revisionId: randomUUID(),
    },
    {
      kind: "mail",
      workplaceId,
      mailboxId,
      messageId: randomUUID(),
      attachmentId: randomUUID(),
    },
  ];
  const requests = [];
  const compositions = [];
  let dropComposition = false;
  let senderBlocked = false;
  let threadPrepared = false;
  const threadGroup = randomUUID();
  let lost = false,
    failure;
  const result = (operationId) => ({
    operationId,
    mailboxId,
    state: "queued",
    contentRetained: true,
    recipientCount: 4,
    receipt: {
      available: true,
      createdAt: "2026-09-17T00:00:00.000Z",
      firstClaimAt: null,
      acceptanceObservedAt: null,
      stoppedAt: null,
      submissions: 0,
    },
  });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer synthetic-mail-key");
      response.setHeader("content-type", "application/json");
      response.setHeader("x-request-id", request.headers["x-request-id"]);
      if (request.url === "/v1/access/account") {
        response.end(
          JSON.stringify({
            accountId,
            workplaceId,
            kind: "agent",
            role: "owner",
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
            mailbox: {
              accountId,
              mailboxId,
              address: "fixture@mail.agentworkplace.dev",
            },
          }),
        );
      } else if (
        request.url === "/v1/mail/sender-blocks/block" ||
        request.url === "/v1/mail/sender-blocks/unblock"
      ) {
        assert.equal(request.method, "POST");
        let text = "";
        for await (const chunk of request) text += chunk;
        const value = JSON.parse(text);
        assert.equal(value.sender, "Exact@example.test");
        senderBlocked = request.url.endsWith("/block");
        response.end(
          JSON.stringify({
            mailboxId,
            sender: value.sender,
            blocked: senderBlocked,
          }),
        );
      } else if (request.url.startsWith("/v1/mail/sender-blocks")) {
        assert.equal(request.method, "GET");
        response.end(
          JSON.stringify({
            blocks: senderBlocked
              ? [
                  {
                    sender: "Exact@example.test",
                    createdAt: "2026-09-18T00:00:00.000Z",
                  },
                ]
              : [],
            nextCursor: null,
          }),
        );
      } else if (request.url.includes("/thread")) {
        assert.equal(request.method, "GET");
        const url = new URL(request.url, "http://fixture.test");
        assert.equal(url.searchParams.get("limit"), "1");
        const next = url.searchParams.get("after");
        const seedMessageId = url.pathname.split("/")[4];
        if (next === "stale") {
          response.statusCode = 409;
          response.end(
            JSON.stringify({
              error: { code: "conflict", message: "Mail conflict" },
            }),
          );
        } else if (!threadPrepared) {
          threadPrepared = true;
          response.end(
            JSON.stringify({ state: "indexing", mailboxId, seedMessageId }),
          );
        } else {
          assert.ok(next === null || next === "thread2");
          response.end(
            JSON.stringify({
              state: "ready",
              mailboxId,
              seedMessageId,
              groupId: threadGroup,
              revision: "1",
              association: "historical_hints",
              messages: [],
              nextCursor: next ? null : "thread2",
            }),
          );
        }
      } else if (request.url === "/v1/mail/send") {
        let text = "";
        for await (const chunk of request) text += chunk;
        const value = parseMailSendRequest(JSON.parse(text));
        requests.push(value);
        if (!lost) {
          assert.deepEqual(
            JSON.parse(await readFile(operation, "utf8")).request,
            value,
          );
          lost = true;
          response.destroy();
          return;
        }
        response.end(JSON.stringify(result(value.operationId)));
      } else if (request.url === "/v1/mail/compose") {
        let text = "";
        for await (const chunk of request) text += chunk;
        const value = parseMailComposeRequest(JSON.parse(text));
        compositions.push(value);
        if (dropComposition) {
          const saved = JSON.parse(await readFile(operation, "utf8"));
          assert.equal(saved.version, 2);
          assert.deepEqual(saved.request, value);
          dropComposition = false;
          response.destroy();
          return;
        }
        response.end(JSON.stringify(result(value.operationId)));
      } else if (
        /^\/v1\/mail\/messages\/[^/]+\/(unarchive|archive)$/.test(request.url)
      ) {
        assert.equal(request.method, "POST");
        response.end(JSON.stringify({ acknowledged: true }));
      } else if (request.url.startsWith("/v1/mail/messages?")) {
        const url = new URL(request.url, "http://fixture.test");
        assert.equal(url.searchParams.get("view"), "archive");
        assert.equal(url.searchParams.get("subject"), "Runtime");
        const next = url.searchParams.get("after");
        assert.ok(next === null || next === "scan2");
        response.end(
          JSON.stringify({
            messages: next
              ? [
                  {
                    messageId: requests[0].operationId,
                    mailboxId,
                    direction: "outgoing",
                    operationId: requests[0].operationId,
                    createdAt: "2026-09-17T00:00:00.000Z",
                    trashedAt: null,
                    archivedAt: "2026-09-17T00:01:00.000Z",
                    retainedBytes: Buffer.byteLength(requests[0].text),
                    display: { subject: "Runtime" },
                    metadataOmissions: [],
                    attachmentOmissions: 0,
                  },
                ]
              : [],
            nextCursor: next ? null : "scan2",
          }),
        );
      } else if (request.url.startsWith("/v1/mail/operations/")) {
        response.end(JSON.stringify(result(request.url.split("/").at(-1))));
      } else throw new Error("Unexpected fixture route");
    } catch (error) {
      failure = error;
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function invoke(args, savedOperation = true) {
    const child = spawn(
      process.execPath,
      [
        cliEntry,
        "--credentials",
        credentials,
        "mail",
        ...args,
        ...(savedOperation ? ["--operation", operation] : []),
        "--json",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        killSignal: "SIGKILL",
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null);
    if (failure) throw failure;
    return { code, stdout, stderr };
  }
  try {
    await writeFile(
      credentials,
      JSON.stringify({
        version: 1,
        kind: "account",
        origin,
        credential: { accountId, workplaceId, key: "synthetic-mail-key" },
      }),
      { mode: 0o600 },
    );
    await writeFile(body, "Requested runtime fixture", { mode: 0o600 });
    await writeFile(attachmentsFile, JSON.stringify(attachments), {
      mode: 0o600,
    });
    const initial = await invoke([
      "send",
      "--to",
      "one@example.test",
      "--to",
      "two@example.test",
      "--cc",
      "copy@example.test",
      "--bcc",
      "hidden@example.test",
      "--subject",
      "Runtime",
      "--body-file",
      body,
      "--attachments-file",
      attachmentsFile,
    ]);
    assert.notEqual(initial.code, 0);
    assert.equal(initial.stdout, "");
    assert.ok(!initial.stderr.includes("hidden@example.test"));
    const saved = await readFile(operation, "utf8");
    assert.deepEqual(JSON.parse(saved).request.attachments, attachments);
    await rm(attachmentsFile);
    const retry = await invoke(["send"]);
    assert.equal(retry.code, 0);
    assert.equal(retry.stderr, "");
    assert.equal(JSON.parse(retry.stdout).recipientCount, 4);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[1].to, ["one@example.test", "two@example.test"]);
    assert.deepEqual(requests[1].cc, ["copy@example.test"]);
    assert.deepEqual(requests[1].bcc, ["hidden@example.test"]);
    const status = await invoke(["status"]);
    assert.equal(status.code, 0);
    assert.equal(status.stderr, "");
    assert.equal(requests.length, 2);
    const changed = await invoke(["send", "--bcc", "other@example.test"]);
    assert.notEqual(changed.code, 0);
    assert.equal(requests.length, 2);
    await writeFile(
      attachmentsFile,
      JSON.stringify([...attachments].reverse()),
    );
    assert.notEqual(
      (await invoke(["send", "--attachments-file", attachmentsFile])).code,
      0,
    );
    assert.equal(requests.length, 2);
    assert.equal(await readFile(operation, "utf8"), saved);
    const client = new AgentWorkplace({ baseUrl: origin });
    const sdkRequest = parseMailSendRequest({
      ...requests[0],
      operationId: randomUUID(),
    });
    assert.equal(
      (await client.sendMail({ apiKey: "synthetic-mail-key" }, sdkRequest))
        .recipientCount,
      4,
    );
    assert.deepEqual(requests[2], sdkRequest);
    const blocked = await invoke(["block-sender", "Exact@example.test"], false);
    assert.equal(blocked.code, 0);
    assert.equal(blocked.stderr, "");
    assert.equal(JSON.parse(blocked.stdout).blocked, true);
    const blocks = await invoke(["blocked-senders", "--limit", "1"], false);
    assert.equal(blocks.code, 0);
    assert.equal(
      JSON.parse(blocks.stdout).blocks[0].sender,
      "Exact@example.test",
    );
    assert.equal(
      (await client.listMailSenderBlocks({ apiKey: "synthetic-mail-key" }))
        .blocks.length,
      1,
    );
    const unblocked = await invoke(
      ["unblock-sender", "Exact@example.test"],
      false,
    );
    assert.equal(unblocked.code, 0);
    assert.equal(JSON.parse(unblocked.stdout).blocked, false);
    await client.blockMailSender(
      { apiKey: "synthetic-mail-key" },
      { sender: "Exact@example.test" },
    );
    await client.unblockMailSender(
      { apiKey: "synthetic-mail-key" },
      { sender: "Exact@example.test" },
    );
    assert.equal(
      (await client.listMailSenderBlocks({ apiKey: "synthetic-mail-key" }))
        .blocks.length,
      0,
    );
    const threadAuth = { apiKey: "synthetic-mail-key" };
    const indexing = await client.getMailThread(
      threadAuth,
      requests[0].operationId,
      { limit: 1 },
    );
    assert.equal(indexing.state, "indexing");
    const thread = await client.getMailThread(
      threadAuth,
      requests[0].operationId,
      { limit: 1 },
    );
    assert.equal(thread.state, "ready");
    assert.deepEqual(thread.messages, []);
    assert.equal(thread.nextCursor, "thread2");
    const completedThread = await invoke(
      [
        "thread",
        requests[0].operationId,
        "--limit",
        "1",
        "--after",
        thread.nextCursor,
      ],
      false,
    );
    assert.equal(completedThread.code, 0);
    assert.equal(completedThread.stderr, "");
    assert.equal(JSON.parse(completedThread.stdout).nextCursor, null);
    const changedThread = await invoke(
      ["thread", requests[0].operationId, "--limit", "1", "--after", "stale"],
      false,
    );
    assert.notEqual(changedThread.code, 0);
    assert.equal(changedThread.stdout, "");
    const archived = await invoke(["archive", requests[0].operationId], false);
    assert.equal(archived.code, 0);
    assert.equal(archived.stderr, "");
    assert.deepEqual(JSON.parse(archived.stdout), { acknowledged: true });
    const empty = await invoke(
      ["list", "--view", "archive", "--subject", "Runtime"],
      false,
    );
    assert.equal(empty.code, 0);
    assert.equal(empty.stderr, "");
    assert.deepEqual(JSON.parse(empty.stdout), {
      messages: [],
      nextCursor: "scan2",
    });
    const later = await invoke(
      [
        "list",
        "--view",
        "archive",
        "--subject",
        "Runtime",
        "--after",
        JSON.parse(empty.stdout).nextCursor,
      ],
      false,
    );
    assert.equal(later.code, 0);
    assert.equal(later.stderr, "");
    assert.equal(
      JSON.parse(later.stdout).messages[0].messageId,
      requests[0].operationId,
    );
    const sdkEmpty = await client.listMailMessages(
      { apiKey: "synthetic-mail-key" },
      { view: "archive", subject: "Runtime" },
    );
    assert.equal(sdkEmpty.messages.length, 0);
    assert.equal(sdkEmpty.nextCursor, "scan2");
    const sdkLater = await client.listMailMessages(
      { apiKey: "synthetic-mail-key" },
      { view: "archive", subject: "Runtime", after: sdkEmpty.nextCursor },
    );
    assert.equal(sdkLater.messages.length, 1);
    assert.equal(sdkLater.nextCursor, null);
    await client.unarchiveMailMessage(
      { apiKey: "synthetic-mail-key" },
      requests[0].operationId,
    );
    for (const command of ["reply", "reply-all", "forward"]) {
      operation = join(dir, `${command}.json`);
      dropComposition = true;
      const before = compositions.length;
      const destinations =
        command === "forward"
          ? ["--to", "forward@example.test", "--bcc", "private@example.test"]
          : [];
      await writeFile(attachmentsFile, JSON.stringify(attachments));
      const initial = await invoke([
        command,
        "--message",
        randomUUID(),
        "--subject",
        "Correspondence",
        "--body-file",
        body,
        ...destinations,
        "--attachments-file",
        attachmentsFile,
      ]);
      assert.notEqual(initial.code, 0);
      assert.equal(initial.stdout, "");
      assert.ok(!initial.stderr.includes("private@example.test"));
      assert.deepEqual(compositions[before].attachments, attachments);
      await rm(attachmentsFile);
      const retry = await invoke([command]);
      assert.equal(retry.code, 0);
      assert.equal(retry.stderr, "");
      assert.deepEqual(compositions[before], compositions[before + 1]);
      assert.equal(compositions[before].kind, command.replace("-", "_"));
      const count = compositions.length;
      assert.notEqual(
        (await invoke([command, "--subject", "changed"])).code,
        0,
      );
      assert.equal((await invoke(["status"])).code, 0);
      assert.equal(compositions.length, count);
      const sdkRequest = parseMailComposeRequest({
        ...compositions[before],
        operationId: randomUUID(),
      });
      assert.equal(
        (await client.composeMail({ apiKey: "synthetic-mail-key" }, sdkRequest))
          .operationId,
        sdkRequest.operationId,
      );
      assert.deepEqual(compositions.at(-1), sdkRequest);
    }
    console.log(
      `Mail immutable attachments and recipient/composition recovery, sender blocks, threads, archive and empty-page continuation passed on ${process.version}`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
