// Test-only process-kill barriers. Loaded before the built CLI, never shipped.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const boundary = process.env.AWP_TEST_DOWNLOAD_BOUNDARY;
const operation = process.env.AWP_TEST_DOWNLOAD_OPERATION;
const output = process.env.AWP_TEST_DOWNLOAD_OUTPUT;
let reached = false;
async function pause() {
  if (reached) return;
  reached = true;
  process.send({ boundary });
  await new Promise(() => {});
}
const originalOpen = fs.promises.open;
fs.promises.open = async function (path, ...args) {
  const handle = await originalOpen.call(this, path, ...args);
  if (
    boundary === "bytes-before-checkpoint" &&
    basename(String(path)) === "content"
  ) {
    const originalWrite = handle.write;
    handle.write = async function (...args) {
      const result = await originalWrite.apply(this, args);
      await pause();
      return result;
    };
  }
  return handle;
};
const originalRename = fs.promises.rename;
fs.promises.rename = async function (source, target) {
  await originalRename.call(this, source, target);
  if (boundary === "receipt-before-cleanup" && target === operation) {
    const value = JSON.parse(await fs.promises.readFile(target, "utf8"));
    if (value.state === "complete") await pause();
  }
};
const originalLink = fs.promises.link;
fs.promises.link = async function (source, target) {
  await originalLink.call(this, source, target);
  if (boundary === "link-before-receipt" && target === output) await pause();
};
const originalUnlink = fs.promises.unlink;
fs.promises.unlink = async function (path) {
  await originalUnlink.call(this, path);
  if (
    boundary === "unlink-before-directory" &&
    basename(String(path)) === "content"
  )
    await pause();
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const request = new Request(input, init);
  if (
    boundary === "after-checkpoint" &&
    request.headers.get("range")?.startsWith("bytes=8388608-")
  )
    await pause();
  return originalFetch(input, init);
};
