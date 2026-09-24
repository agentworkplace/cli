// Test-only barriers loaded before the built CLI; never part of its package.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const boundary = process.env.AWP_TEST_EXPORT_BOUNDARY;
let reached = false;
async function pause() {
  if (reached) return;
  reached = true;
  process.send({ boundary });
  await new Promise(() => {});
}
const originalOpen = fs.promises.open;
fs.promises.open = async function (path, ...args) {
  const h = await originalOpen.call(this, path, ...args);
  if (
    boundary === "inventory" &&
    basename(String(path)) === "inventory.ndjson"
  ) {
    const write = h.writeFile;
    h.writeFile = async function (...args) {
      const result = await write.apply(this, args);
      await pause();
      return result;
    };
  }
  return h;
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const request = new Request(input, init);
  if (
    boundary === "content" &&
    request.headers.get("range")?.startsWith("bytes=8388608-")
  )
    await pause();
  return originalFetch(input, init);
};
