import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../src/program.js";

const origin = "https://api.example.test";
const receipt = {
  version: 1,
  apiOrigin: origin,
  accountId: randomUUID(),
  workplaceId: randomUUID(),
  proof: randomBytes(32).toString("base64url"),
};
const status = {
  state: "deleted" as const,
  initiatedAt: "2026-09-12T00:00:00.000Z",
  receiptExpiresAt: "2026-10-12T00:00:00.000Z",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function invoke(
  path: string,
  text: string,
  baseUrl = origin,
  json = true,
  reject = false,
) {
  let stdout = "",
    stderr = "";
  const request = vi.fn(async () => {
    if (reject) throw new Error(receipt.proof);
    return status;
  });
  const exitCode = await runCli(
    [
      "--base-url",
      baseUrl,
      "deletion-status",
      "--receipt",
      path,
      ...(json ? ["--json"] : []),
    ],
    {
      version: "0.0.0",
      input: (async function* () {
        yield text;
      })(),
      createDeletionClient: () => ({ workplaceDeletionStatus: request }),
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    },
  );
  return { exitCode, stdout, stderr, request };
}
test("stdin status emits only exact public outcome and never private receipt fields", async () => {
  const result = await invoke("-", JSON.stringify(receipt));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`${JSON.stringify(status)}\n`);
  expect(result.request).toHaveBeenCalledWith(receipt.proof);
  const human = await invoke("-", JSON.stringify(receipt), origin, false);
  expect(human.stdout).toBe(
    `Deletion: deleted\nInitiated: ${status.initiatedAt}\nReceipt expires: ${status.receiptExpiresAt}\n`,
  );
});
test.each([
  "null",
  "not-json",
  " ".repeat(4097),
  JSON.stringify({ ...receipt, apiOrigin: "https://other.example.test" }),
  JSON.stringify({ ...receipt, key: "private" }),
])("invalid private input is rejected before transport", async (text) => {
  const result = await invoke("-", text);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.request).not.toHaveBeenCalled();
  expect(result.stderr).toBe(
    '{"error":{"message":"Expected a private deletion receipt for the selected API origin"}}\n',
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
  const failed = await invoke("-", JSON.stringify(receipt), origin, true, true);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toBe(
    '{"error":{"message":"Unable to complete the request"}}\n',
  );
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
