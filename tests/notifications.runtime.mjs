import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function testNotificationPolling() {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const workplaceId = "22222222-2222-4222-8222-222222222222";
  const status = {
    position: `np1.${accountId}.1`,
    unreadCount: 1,
    oldestUnreadAt: "2026-10-07T00:00:00.000Z",
  };
  const directory = await mkdtemp(join(tmpdir(), "awp-notification-runtime-"));
  let onRequest;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/notifications/status");
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status));
    onRequest?.();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = join(directory, "credentials.json");
  await writeFile(
    credentials,
    JSON.stringify({
      version: 1,
      kind: "account",
      origin,
      credential: { accountId, workplaceId, key: "fixture-key" },
    }),
    { mode: 0o600 },
  );
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const children = [];
  async function invoke(command, { after, signal, waitForOutput } = {}) {
    const child = spawn(
      process.execPath,
      [
        cli,
        "--credentials",
        credentials,
        "notifications",
        command,
        "--json",
        ...(after ? ["--after", after] : []),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
        killSignal: "SIGKILL",
      },
    );
    children.push(child);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
      if (signal && waitForOutput && stdout.includes("\n")) child.kill(signal);
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    if (signal && !waitForOutput)
      onRequest = () => {
        onRequest = undefined;
        child.kill(signal);
      };
    const [code, terminated] = await once(child, "close");
    assert.equal(terminated, null);
    return { code, stdout, stderr };
  }
  try {
    assert.deepEqual(await invoke("wait"), {
      code: 0,
      stdout: JSON.stringify(status) + "\n",
      stderr: "",
    });
    const watching = await invoke("watch", {
      signal: "SIGINT",
      waitForOutput: true,
    });
    assert.equal(watching.code, 130);
    assert.equal(watching.stdout, JSON.stringify(status) + "\n");
    assert.match(watching.stderr, /Notification wait canceled/);
    const idle = await invoke("wait", {
      after: status.position,
      signal: "SIGTERM",
    });
    assert.equal(idle.code, 143);
    assert.equal(idle.stdout, "");
    assert.match(idle.stderr, /Notification wait canceled/);
    console.log(
      `Built CLI notification wait/watch and cancellation passed on ${process.version}`,
    );
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

export async function testNotificationEndpoints() {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const workplaceId = "22222222-2222-4222-8222-222222222222";
  const directory = await mkdtemp(join(tmpdir(), "awp-endpoint-runtime-"));
  const secret = `whsec_${"A".repeat(43)}=`;
  const endpoint = {
    id: accountId,
    accountId,
    url: "https://receiver.example/private-hook",
    profile: { kind: "standard" },
    createdBy: accountId,
    createdAt: "2026-10-08T00:00:00.000Z",
    disabledAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  const status = {
    position: `np1.${accountId}.0`,
    unreadCount: 0,
    oldestUnreadAt: null,
  };
  const calls = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    const url = new URL(request.url, "http://localhost");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("X-Request-ID", request.headers["x-request-id"]);
    if (url.pathname === "/v1/access/account") {
      response.end(
        JSON.stringify({
          accountId,
          workplaceId,
          kind: "agent",
          role: "member",
          state: "active",
          workplaceState: "unconfirmed",
          cleanupAt: "2026-10-21T00:00:00.000Z",
          cleanupWarning: null,
          free: null,
          starter: {
            outboundLimit: 2,
            inboundLimit: 20,
            storageLimit: "100 MB",
            outboundUsed: 0,
            inboundUsed: 0,
            storageUsedBytes: 0,
          },
        }),
      );
      return;
    }
    calls.push({
      method: request.method,
      path: url.pathname,
      accountId: url.searchParams.get("accountId"),
    });
    if (request.method === "POST" && url.pathname.endsWith("/test")) {
      response.statusCode = 202;
      response.end(JSON.stringify({ accepted: true, testId: accountId }));
    } else if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          endpoint: { ...endpoint, profile: input.profile },
          ...(input.profile.kind === "standard" ? { secret } : {}),
        }),
      );
    } else if (request.method === "DELETE") {
      response.statusCode = 204;
      response.end();
    } else if (url.pathname.endsWith(accountId)) {
      response.end(JSON.stringify({ endpoint, status }));
    } else response.end(JSON.stringify({ endpoints: [endpoint], status }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = join(directory, "credentials.json");
  const registration = join(directory, "registration.json");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const children = [];
  async function invoke(args, input = "") {
    const child = spawn(
      process.execPath,
      [
        cli,
        "--credentials",
        credentials,
        "notifications",
        "endpoints",
        ...args,
        "--json",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        killSignal: "SIGKILL",
      },
    );
    children.push(child);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.stdin.end(input);
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null);
    return { code, stdout, stderr };
  }
  try {
    await writeFile(
      credentials,
      JSON.stringify({
        version: 1,
        kind: "account",
        origin,
        credential: { accountId, workplaceId, key: "fixture-key" },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      registration,
      JSON.stringify({ url: endpoint.url, profile: endpoint.profile }),
      { mode: 0o600 },
    );
    assert.deepEqual(await invoke(["register", "--file", registration]), {
      code: 0,
      stdout: JSON.stringify({ endpoint, secret }) + "\n",
      stderr: "",
    });
    const bearer = await invoke(
      ["register", "--file", "-"],
      JSON.stringify({
        url: endpoint.url,
        profile: { kind: "bearer" },
        token: "private-runtime-token",
      }),
    );
    assert.deepEqual(bearer, {
      code: 0,
      stdout:
        JSON.stringify({
          endpoint: { ...endpoint, profile: { kind: "bearer" } },
        }) + "\n",
      stderr: "",
    });
    assert.deepEqual(await invoke(["list", "--account", accountId]), {
      code: 0,
      stdout: JSON.stringify({ endpoints: [endpoint], status }) + "\n",
      stderr: "",
    });
    assert.deepEqual(
      await invoke(["inspect", "--id", accountId, "--account", accountId]),
      {
        code: 0,
        stdout: JSON.stringify({ endpoint, status }) + "\n",
        stderr: "",
      },
    );
    assert.deepEqual(
      await invoke(["test", "--id", accountId, "--account", accountId]),
      {
        code: 0,
        stdout: JSON.stringify({ accepted: true, testId: accountId }) + "\n",
        stderr: "",
      },
    );
    assert.deepEqual(
      await invoke(["remove", "--id", accountId, "--account", accountId]),
      {
        code: 0,
        stdout: JSON.stringify({ removed: true, endpointId: accountId }) + "\n",
        stderr: "",
      },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["POST", "POST", "GET", "GET", "POST", "DELETE"],
    );
    assert.ok(calls.slice(2).every((call) => call.accountId === accountId));
    const invalid = await invoke(
      ["register", "--file", "-"],
      "private-not-json",
    );
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, "");
    assert.ok(!invalid.stderr.includes("private-not-json"));
    assert.equal(calls.length, 6);
    console.log(
      `Built CLI endpoint management and private input passed on ${process.version}`,
    );
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
