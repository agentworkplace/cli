import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { CliConfigurationError } from "./errors.js";

export async function readPrivateReceipt(
  path: string,
  input: AsyncIterable<string | Uint8Array>,
  invalid: () => Error,
) {
  if (path === "-") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4096) throw invalid();
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (process.platform === "win32")
    throw new CliConfigurationError(
      "Private receipt files require POSIX permissions; use protected standard input on other platforms",
    );
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 4096
      )
        throw invalid();
      const bytes = Buffer.alloc(4097);
      let size = 0;
      while (size < bytes.length) {
        const next = await file.read(bytes, size, bytes.length - size, size);
        if (!next.bytesRead) break;
        size += next.bytesRead;
      }
      if (size > 4096) throw invalid();
      return bytes.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new CliConfigurationError(
      "Unable to read a private receipt file; use a regular file owned by you with mode 600",
    );
  }
}
