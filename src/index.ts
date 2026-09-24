#!/usr/bin/env node

import { createRequire } from "node:module";

import { runCli } from "./program.js";

interface PackageMetadata {
  version: string;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as PackageMetadata;

process.exitCode = await runCli(process.argv.slice(2), {
  version: packageMetadata.version,
});
