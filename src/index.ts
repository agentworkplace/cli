#!/usr/bin/env node

import { createRequire } from "node:module";

import { OutputWriteError } from "./errors.js";
import { runCli } from "./program.js";
import { startUpdateCheck } from "./update-check.js";

interface PackageMetadata {
  version: string;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as PackageMetadata;

// A reader may close stdout early, as `| head` does. The command still finishes
// and reports its own outcome, so a completed change is never reported as failed.
// Any other write failure also lets the command finish, then fails it, because
// throwing here would stop a change partway through.
const outputClosed = new AbortController();
let outputFailure: OutputWriteError | undefined;
const recordFailure = (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE")
    outputFailure ??= new OutputWriteError(error.code);
};
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  recordFailure(error);
  outputClosed.abort();
});
process.stderr.on("error", recordFailure);

const arguments_ = process.argv.slice(2);
// Runs beside the command; the notice follows the command's own output.
const updateCheck = startUpdateCheck({
  version: packageMetadata.version,
  arguments: arguments_,
  env: process.env,
});
process.exitCode = await runCli(arguments_, {
  version: packageMetadata.version,
  outputClosed: outputClosed.signal,
  outputFailure: () => outputFailure,
});
await updateCheck?.finish((text) => process.stderr.write(text));
