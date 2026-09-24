import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { withFileUploadSource } from "../src/files-operation.js";
import type { FileUploadSource } from "@agent-workplace/sdk";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "awp-bounded-source-"));
  directories.push(dir);
  const path = join(dir, "input");
  await writeFile(path, "original");
  return { dir, path };
}
test("reads bounded ranges and closes the source after callback failure", async () => {
  const { path } = await fixture();
  let captured: FileUploadSource | undefined;
  await expect(
    withFileUploadSource(path, 64 * 1024 * 1024, async (source) => {
      captured = source;
      expect(source.byteLength).toBe(8);
      expect(new TextDecoder().decode(await source.read(2, 3))).toBe("igi");
      expect((await source.read(8, 1)).length).toBe(0);
      await expect(source.read(0, 8 * 1024 * 1024 + 1)).rejects.toThrow(
        "bounded",
      );
      throw new Error("stop fixture");
    }),
  ).rejects.toThrow("stop fixture");
  await expect(captured!.read(0, 1)).rejects.toThrow("safely");
});
test("rejects changed content, symlinks and oversized declarations without reading whole files", async () => {
  const { path, dir } = await fixture();
  await expect(
    withFileUploadSource(path, 64 * 1024 * 1024, async (source) => {
      await writeFile(path, "modified");
      await source.read(0, 8);
    }),
  ).rejects.toThrow("changed");
  const alias = join(dir, "alias");
  await symlink(path, alias);
  await expect(
    withFileUploadSource(alias, 64 * 1024 * 1024, async () => {
      throw new Error("must not enter");
    }),
  ).rejects.toThrow("regular file");
  await expect(
    withFileUploadSource(path, 1, async () => {
      throw new Error("must not enter");
    }),
  ).rejects.toThrow("size limit");
});
