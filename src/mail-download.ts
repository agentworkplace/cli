import { rmSync } from "node:fs";
import { mkdtemp, open, link, rm, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliConfigurationError } from "./errors.js";

/** Publish only complete verified bytes, never overwrite an existing path. */
export async function saveMailAttachment(output: string, bytes: Uint8Array) {
  let staging: string | undefined;
  // This directory is ours and holds only a candidate: an interrupt can remove it.
  const interrupted = (signal: NodeJS.Signals) => {
    if (staging) rmSync(staging, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const requested = resolve(output);
    const directory = await realpath(dirname(requested));
    const destination = join(directory, basename(requested));
    staging = await mkdtemp(join(directory, ".awp-mail-download-"));
    const candidate = join(staging, "content");
    const file = await open(candidate, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(candidate, destination);
    return destination;
  } catch {
    throw new CliConfigurationError(
      "Attachment output is unavailable or already exists; no existing destination was overwritten",
    );
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    if (staging)
      await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
