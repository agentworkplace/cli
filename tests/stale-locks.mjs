import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";

/**
 * Backdates the private-file locks a killed CLI left under a test-owned
 * directory past the 10-second stale threshold, so the next process reclaims
 * them at once through the ordinary stale-lock rule. Nothing is removed. Call
 * only after every CLI process using the directory has exited.
 */
export async function ageAbandonedLocks(directory) {
  const locks = (
    await readdir(directory, { recursive: true, withFileTypes: true })
  ).filter((entry) => entry.isDirectory() && entry.name.endsWith(".lock"));
  if (!locks.length) throw new Error("Killed CLI left no lock to age");
  const stale = new Date(Date.now() - 60_000);
  for (const lock of locks)
    await utimes(join(lock.parentPath, lock.name), stale, stale);
}
