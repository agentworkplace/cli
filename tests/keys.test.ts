import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const current = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const metadata = (id: string) => ({
  id,
  name: null,
  enabled: true,
  createdAt: "2026-11-06T00:00:00.000Z",
  expiresAt: null,
});

async function fixture(currentKeyId: string | null = current) {
  const directory = await mkdtemp(join(tmpdir(), "awp-keys-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://fixture.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
    ...(currentKeyId ? { currentKeyId } : {}),
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const list = vi
    .spyOn(AgentWorkplace.prototype, "listAgentKeys")
    .mockResolvedValue({ keys: [metadata(current), metadata(other)] });
  const revoke = vi
    .spyOn(AgentWorkplace.prototype, "revokeAgentKey")
    .mockResolvedValue({ revoked: true } as never);
  const run = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(["--credentials", credentials, ...args], {
      version: "0.0.0",
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    });
    return { code, stdout, stderr };
  };
  return { accountId, list, revoke, run };
}

describe("keys", () => {
  test("marks the key in use on your own account", async () => {
    const f = await fixture();
    const result = await f.run(["keys", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).keys).toEqual([
      { ...metadata(current), current: true },
      metadata(other),
    ]);
  });

  test("marks nothing on another account", async () => {
    const f = await fixture();
    const result = await f.run(["keys", "--account", randomUUID(), "--json"]);
    expect(JSON.parse(result.stdout).keys).toEqual([
      metadata(current),
      metadata(other),
    ]);
  });

  test("marks nothing when the API doesn't report the key", async () => {
    const f = await fixture(null);
    const result = await f.run(["keys", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).keys).toEqual([
      metadata(current),
      metadata(other),
    ]);
  });
});

describe("revoke-key", () => {
  const revoke = (key: string, ...more: string[]) => [
    "revoke-key",
    "--key-id",
    key,
    ...more,
    "--json",
  ];

  test("refuses the key in use before any request", async () => {
    const f = await fixture();
    const result = await f.run(revoke(current));
    expect(result.code).toBe(1);
    const { error } = JSON.parse(result.stderr);
    expect(error.code).toBe("current_key");
    expect(error.message).toContain("--allow-current");
    expect(f.revoke).not.toHaveBeenCalled();
  });

  test("matches the key ID in any letter case", async () => {
    const f = await fixture("abcdefab-1111-4111-8111-111111111111");
    const result = await f.run(revoke("ABCDEFAB-1111-4111-8111-111111111111"));
    expect(result.code).toBe(1);
    expect(f.revoke).not.toHaveBeenCalled();
  });

  test("revokes it with --allow-current", async () => {
    const f = await fixture();
    expect((await f.run(revoke(current, "--allow-current"))).code).toBe(0);
    expect(f.revoke).toHaveBeenCalledOnce();
  });

  test("revokes another key without the flag", async () => {
    const f = await fixture();
    expect((await f.run(revoke(other))).code).toBe(0);
    expect(f.revoke).toHaveBeenCalledOnce();
  });

  test("applies no guard when the API doesn't report the key", async () => {
    const f = await fixture(null);
    expect((await f.run(revoke(current))).code).toBe(0);
    expect(f.revoke).toHaveBeenCalledOnce();
  });
});
