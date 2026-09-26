import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  AgentWorkplace,
  prepareFileUpload,
  parseFileReference,
} from "@agent-workplace/sdk";

const identity = "11111111-1111-4111-8111-111111111111";
const prepared = prepareFileUpload(
  {
    workplaceId: identity,
    operationId: identity,
    target: { name: "runtime.txt" },
    contentType: "text/plain",
    expiresAt: "2026-09-16T12:00:00.000Z",
  },
  new TextEncoder().encode("abc"),
);
assert.equal(prepared.contentMd5, "kAFQmDzST7DWlj99KOF/cg==");
assert.equal(
  prepared.sha256,
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);
assert.equal(
  parseFileReference(`awp:file:${identity}:${identity}`).fileId,
  identity,
);

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("X-Request-ID", request.headers["x-request-id"]);
  response.end(JSON.stringify({ status: "ok" }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AgentWorkplace({ baseUrl });
  assert.deepEqual(await client.health(), { status: "ok" });
  const child = spawn(
    process.execPath,
    [
      process.argv[2] ??
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "health",
      "--json",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_WORKPLACE_API_URL: baseUrl },
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { status: "ok" });
  console.log(`SDK and built CLI transport passed on ${process.version}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

const { testDownloadCrashRecovery } =
  await import("./files-download.runtime.mjs");
await testDownloadCrashRecovery();

const { testExportCrashRecovery } = await import("./files-export.runtime.mjs");
await testExportCrashRecovery();

const { testMailRecipients } = await import("./mail-recipients.runtime.mjs");
await testMailRecipients();
