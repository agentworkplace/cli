import { AgentWorkplace } from "@agent-workplace/sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../src/program.js";

const origin = "https://api.example.test";
const receipt = {
  version: 1,
  kind: "owner-email-change",
  operationId: randomUUID(),
  apiOrigin: origin,
  accountId: randomUUID(),
  workplaceId: randomUUID(),
  proof: randomBytes(32).toString("base64url"),
};
const status = {
  operation: {
    operationId: receipt.operationId,
    state: "completed" as const,
    generation: 2,
    createdAt: "2026-09-18T00:00:00.000Z",
    expiresAt: "2026-09-18T00:10:00.000Z",
    receiptExpiresAt: "2026-10-18T00:00:00.000Z",
    finishedAt: "2026-09-18T00:02:00.000Z",
  },
};
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function invoke(
  path: string,
  text: string,
  baseUrl: string | null = origin,
  json = true,
  reject = false,
  response: { operation: typeof status.operation | null } = status,
) {
  vi.stubEnv("AGENT_WORKPLACE_API_URL", baseUrl ?? undefined);
  let stdout = "",
    stderr = "";
  const request = vi.fn(async () => {
    if (reject) throw new Error(receipt.proof);
    return response;
  });
  const createProductClient = vi.fn((baseUrl: string) => {
    const client = new AgentWorkplace({ baseUrl });
    client.ownerEmailChangeStatus = request;
    return client;
  });
  const exitCode = await runCli(
    ["owner-email-status", "--receipt", path, ...(json ? ["--json"] : [])],
    {
      version: "0.0.0",
      input: (async function* () {
        yield text;
      })(),
      createProductClient,
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    },
  );
  return { exitCode, stdout, stderr, request, createProductClient };
}
test("stdin status emits only exact public outcome and never private receipt fields", async () => {
  const result = await invoke("-", JSON.stringify(receipt));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`${JSON.stringify(status)}\n`);
  expect(result.request).toHaveBeenCalledWith(receipt.proof);
  expect(result.createProductClient).toHaveBeenCalledWith(origin);
  const human = await invoke("-", JSON.stringify(receipt), origin, false);
  expect(human.stdout).toBe(
    `Owner email: completed\nOperation expires: ${status.operation.expiresAt}\nReceipt expires: ${status.operation.receiptExpiresAt}\n`,
  );
});
test.each([
  "null",
  "not-json",
  JSON.stringify({ ...receipt, kind: "workplace-deletion" }),
  JSON.stringify({ ...receipt, operationId: "invalid" }),
  " ".repeat(4097),
  JSON.stringify({ ...receipt, apiOrigin: "https://other.example.test" }),
  JSON.stringify({ ...receipt, key: "private" }),
])("invalid private input is rejected before transport", async (text) => {
  const result = await invoke("-", text);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.request).not.toHaveBeenCalled();
  expect(result.createProductClient).not.toHaveBeenCalled();
  expect(result.stderr).toBe(
    '{"error":{"message":"Expected a private owner email receipt for the selected API origin; set AGENT_WORKPLACE_API_URL for another environment"}}\n',
  );
});
test("receipt cannot select non-loopback HTTP and failures never echo its secret", async () => {
  const unsafe = await invoke(
    "-",
    JSON.stringify(receipt),
    "http://api.example.test",
  );
  expect(unsafe.exitCode).toBe(1);
  expect(unsafe.request).not.toHaveBeenCalled();
  expect(unsafe.createProductClient).not.toHaveBeenCalled();
  const failed = await invoke("-", JSON.stringify(receipt), origin, true, true);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toBe(
    '{"error":{"message":"Unable to complete the request"}}\n',
  );
});
test("production receipt uses the default and a staging receipt cannot redirect it", async () => {
  const productionReceipt = {
    ...receipt,
    apiOrigin: "https://api.agentworkplace.dev",
  };
  const production = await invoke("-", JSON.stringify(productionReceipt), null);
  expect(production.exitCode).toBe(0);
  expect(production.createProductClient).toHaveBeenCalledWith(
    productionReceipt.apiOrigin,
  );
  const staging = await invoke("-", JSON.stringify(receipt), null);
  expect(staging.exitCode).toBe(1);
  expect(staging.stderr).toContain("AGENT_WORKPLACE_API_URL");
  expect(staging.createProductClient).not.toHaveBeenCalled();
  expect(staging.request).not.toHaveBeenCalled();
});
test.skipIf(process.platform === "win32")(
  "files require restrictive permissions and reject links before transport",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "deletion-receipt-"));
    directories.push(directory);
    const path = join(directory, "receipt.json");
    await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
    expect((await invoke(path, "")).stdout).toBe(`${JSON.stringify(status)}\n`);
    await chmod(path, 0o644);
    const exposed = await invoke(path, "");
    expect(exposed.exitCode).toBe(1);
    expect(exposed.request).not.toHaveBeenCalled();
    await chmod(path, 0o600);
    const link = join(directory, "link");
    await symlink(path, link);
    expect((await invoke(link, "")).request).not.toHaveBeenCalled();
    await writeFile(path, "x".repeat(4097));
    expect((await invoke(path, "")).request).not.toHaveBeenCalled();
  },
);

test("unavailable receipts remain unknown and never trigger another operation", async () => {
  const result = await invoke(
    "-",
    JSON.stringify(receipt),
    origin,
    true,
    false,
    { operation: null },
  );
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: '{"operation":null}\n',
    stderr: "",
  });
  expect(result.request).toHaveBeenCalledTimes(1);
  const human = await invoke(
    "-",
    JSON.stringify(receipt),
    origin,
    false,
    false,
    { operation: null },
  );
  expect(human.stdout).toContain("does not mean the change never completed");
});
test("bound receipt rejects a different returned operation", async () => {
  const result = await invoke(
    "-",
    JSON.stringify(receipt),
    origin,
    true,
    false,
    { operation: { ...status.operation, operationId: randomUUID() } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    '{"error":{"message":"Owner email status does not match the saved operation"}}\n',
  );
});

test("browser handoff contains no credentials and needs no product transport", async () => {
  let stdout = "",
    stderr = "";
  const createProductClient = vi.fn();
  const exitCode = await runCli(
    [
      "--credentials",
      "/must-not-read",
      "owner-email-handoff",
      "--dashboard-url",
      "https://dashboard.example.test",
      "--json",
    ],
    {
      version: "0.0.0",
      createProductClient,
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    },
  );
  expect(exitCode).toBe(0);
  expect(stdout).toBe(
    '{"url":"https://dashboard.example.test/#owner-email"}\n',
  );
  expect(stderr).toBe("");
  expect(createProductClient).not.toHaveBeenCalled();
});
