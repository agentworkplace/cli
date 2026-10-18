import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Read a bounded regular file without following a final symlink or waiting on
 * a FIFO writer. Failures carry no path or content; callers present their own. */
export async function readBoundedFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumBytes)
      throw new Error("Invalid file");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error("Input too large");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
