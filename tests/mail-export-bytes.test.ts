import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  unlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { exportMailBytes } from "../src/mail-export-bytes.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(size = 131073) {
  const dir = await mkdtemp(join(tmpdir(), "awp-mail-export-content-"));
  directories.push(dir);
  const bytes = Buffer.alloc(size, 71);
  const input = {
    operation: join(dir, "operation.json"),
    output: join(dir, "content.bin"),
    binding: "a".repeat(64),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    load: vi.fn(async () => bytes),
    assertOwned: vi.fn(async () => {}),
  };
  const receipt = async () =>
    JSON.parse(await readFile(input.operation, "utf8")) as {
      state: string;
      candidate: string;
    };
  return { dir, bytes, input, receipt };
}
test("Publishes a full decimal 10 MB with private permissions and reuses only verified owned bytes", async () => {
  const f = await fixture(10_000_000);
  const first = await exportMailBytes(f.input);
  expect(first).toMatchObject({ bytes: 10_000_000, sha256: f.input.sha256 });
  const saved = await readFile(f.input.output);
  expect(saved.length).toBe(10_000_000);
  expect(createHash("sha256").update(saved).digest("hex")).toBe(f.input.sha256);
  expect((await stat(f.input.output)).mode & 0o777).toBe(0o600);
  f.input.load.mockRejectedValue(new Error("Source unavailable"));
  expect(await exportMailBytes(f.input)).toEqual(first);
  expect(f.input.load).toHaveBeenCalledTimes(1);
});
test("An interrupted candidate write retries its pinned identity without publishing partial bytes", async () => {
  const f = await fixture();
  let callsAfterLoad = 0,
    loaded = false;
  f.input.load.mockImplementation(async () => {
    loaded = true;
    return f.bytes;
  });
  f.input.assertOwned.mockImplementation(async () => {
    if (loaded && ++callsAfterLoad === 3) throw new Error("Interrupted");
  });
  await expect(exportMailBytes(f.input)).rejects.toThrow("Interrupted");
  await expect(stat(f.input.output)).rejects.toMatchObject({ code: "ENOENT" });
  const prior = await f.receipt();
  expect(prior.state).toBe("planned");
  expect((await stat(prior.candidate)).size).toBeGreaterThan(0);
  f.input.assertOwned.mockResolvedValue(undefined);
  await exportMailBytes(f.input);
  expect((await f.receipt()).candidate).toBe(prior.candidate);
  expect(await readFile(f.input.output)).toEqual(f.bytes);
});
test("Lost publication receipt recovers the exact published inode without reacquiring source", async () => {
  const f = await fixture();
  await exportMailBytes(f.input);
  const receipt = await f.receipt();
  await writeFile(
    f.input.operation,
    JSON.stringify({ ...receipt, state: "verified" }),
  );
  f.input.load.mockRejectedValue(new Error("No source"));
  await exportMailBytes(f.input);
  expect((await f.receipt()).state).toBe("complete");
  expect(f.input.load).toHaveBeenCalledTimes(1);
});
test.each(["short", "wrong_hash"])(
  "Rejects %s bytes before publication",
  async (mode) => {
    const f = await fixture();
    f.input.load.mockResolvedValue(
      mode === "short" ? f.bytes.subarray(1) : Buffer.alloc(f.bytes.length, 72),
    );
    await expect(exportMailBytes(f.input)).rejects.toThrow("changed");
    await expect(stat(f.input.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
test("Existing destination is never overwritten or treated as owned because its bytes match", async () => {
  const f = await fixture();
  await writeFile(f.input.output, f.bytes, { mode: 0o600 });
  await expect(exportMailBytes(f.input)).rejects.toThrow("changed");
  expect(f.input.load).not.toHaveBeenCalled();
  expect(await readFile(f.input.output)).toEqual(f.bytes);
});
test("Recovery refuses changed content, a substituted destination and a candidate symlink", async () => {
  const f = await fixture();
  await exportMailBytes(f.input);
  await writeFile(f.input.output, Buffer.alloc(f.bytes.length, 0));
  await expect(exportMailBytes(f.input)).rejects.toThrow("changed");
  const g = await fixture();
  await exportMailBytes(g.input);
  await unlink(g.input.output);
  await writeFile(g.input.output, g.bytes, { mode: 0o600 });
  await expect(exportMailBytes(g.input)).rejects.toThrow("changed");
  const h = await fixture();
  await exportMailBytes(h.input);
  const r = await h.receipt();
  await unlink(r.candidate);
  await symlink(h.input.output, r.candidate);
  await expect(exportMailBytes(h.input)).rejects.toBeDefined();
});
test("Recovery binds source context and expected digest and fails if completed output was removed", async () => {
  const f = await fixture(0);
  await exportMailBytes(f.input);
  await expect(
    exportMailBytes({ ...f.input, binding: "b".repeat(64) }),
  ).rejects.toThrow("changed");
  await expect(
    exportMailBytes({ ...f.input, sha256: "c".repeat(64) }),
  ).rejects.toThrow("changed");
  await unlink(f.input.output);
  await expect(exportMailBytes(f.input)).rejects.toThrow("changed");
});
