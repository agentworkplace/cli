#!/usr/bin/env node

import { createRequire } from "node:module";

import { runCli } from "./program.js";

interface PackageMetadata {
  version: string;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as PackageMetadata;

// A reader may close stdout early, as `| head` does. The command still finishes
// and reports its own outcome, so a completed change is never reported as failed.
const outputClosed = new AbortController();
const ignoreBrokenPipe =
  (onClosed?: () => void) => (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
    onClosed?.();
  };
process.stdout.on(
  "error",
  ignoreBrokenPipe(() => outputClosed.abort()),
);
process.stderr.on("error", ignoreBrokenPipe());

process.exitCode = await runCli(process.argv.slice(2), {
  version: packageMetadata.version,
  outputClosed: outputClosed.signal,
});
