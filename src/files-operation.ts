import {
  parseFileUploadRequest,
  parseFilesOrganizationRequest,
  parseRestoreFileRevisionRequest,
  parseFileTrashRequest,
  parseFileDeletionRequest,
  type BeginFileUploadRequest,
  type FileUploadSource,
} from "@agent-workplace/sdk";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { accessOrigin } from "./credentials.js";
import { CliConfigurationError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";

/** One open regular-file identity per invocation. Reopening on a retry is safe
 * only when every byte still matches the saved SDK manifest. */
export async function withFileUploadSource<T>(
  path: string,
  maximumBytes: number,
  operation: (source: FileUploadSource) => Promise<T>,
) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new CliConfigurationError(
      "File must be a readable regular file within the transfer size limit",
    );
  }
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.size > BigInt(maximumBytes))
      throw new CliConfigurationError(
        "File must be a readable regular file within the transfer size limit",
      );
    const current = handle;
    // SDK hashing consumes each window before the next read; dispatch takes its
    // own copy. Reuse the borrowed source window instead of leaving full-size
    // streams of unreachable 8 MiB arrays for the collector.
    let buffer: Buffer | undefined;
    const check = async () => {
      const now = await current.stat({ bigint: true });
      if (
        !now.isFile() ||
        now.dev !== initial.dev ||
        now.ino !== initial.ino ||
        now.size !== initial.size ||
        now.mtimeNs !== initial.mtimeNs ||
        now.ctimeNs !== initial.ctimeNs
      )
        throw new CliConfigurationError(
          "Upload source changed; retry with its original bytes",
        );
    };
    return await operation({
      byteLength: Number(initial.size),
      async read(offset, length) {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > Number(initial.size) ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 8 * 1024 * 1024
        )
          throw new CliConfigurationError("Invalid bounded source read");
        try {
          await check();
          if (!buffer || buffer.length < length) buffer = Buffer.alloc(length);
          const bytes = buffer;
          let received = 0;
          while (received < length) {
            const result = await current.read(
              bytes,
              received,
              length - received,
              offset + received,
            );
            if (!result.bytesRead) break;
            received += result.bytesRead;
          }
          await check();
          return bytes.subarray(0, received);
        } catch (error) {
          if (error instanceof CliConfigurationError) throw error;
          throw new CliConfigurationError(
            "Unable to read the upload source safely",
          );
        }
      },
    });
  } finally {
    await handle.close();
  }
}
export interface SavedFilesOperation {
  version: 1;
  origin: string;
  accountId: string;
  request: BeginFileUploadRequest;
}
export function withFilesOperation<T>(
  path: string,
  operation: (store: {
    read(): Promise<SavedFilesOperation | undefined>;
    write(value: SavedFilesOperation): Promise<void>;
  }) => Promise<T>,
) {
  return withPrivateJsonFile(
    path,
    {
      label: "Files operation",
      maximumBytes: 65536,
      validate(value: unknown): SavedFilesOperation {
        try {
          if (!value || typeof value !== "object") throw new Error();
          const record = value as SavedFilesOperation;
          if (
            Object.keys(record).sort().join() !==
              "accountId,origin,request,version" ||
            record.version !== 1 ||
            accessOrigin(record.origin) !== record.origin ||
            !/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
              record.accountId,
            )
          )
            throw new Error();
          return { ...record, request: parseFileUploadRequest(record.request) };
        } catch {
          throw new CliConfigurationError("Invalid Files operation file");
        }
      },
    },
    operation,
  );
}
export async function readFileBytes(
  path: string,
  maximumBytes = 64 * 1024 * 1024,
) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > stat.size) throw new Error();
    return buffer.subarray(0, length);
  } catch {
    throw new CliConfigurationError(
      "File must be a readable regular file within the transfer size limit",
    );
  } finally {
    await handle?.close();
  }
}

interface SavedMutation<Request> {
  version: 1;
  origin: string;
  accountId: string;
  request: Request;
}
function withFilesMutationOperation<Request, Result>(
  path: string,
  label: string,
  parse: (value: unknown) => Request,
  operation: (store: {
    read(): Promise<SavedMutation<Request> | undefined>;
    write(value: SavedMutation<Request>): Promise<void>;
  }) => Promise<Result>,
) {
  return withPrivateJsonFile(
    path,
    {
      label,
      maximumBytes: 16384,
      validate(value: unknown): SavedMutation<Request> {
        try {
          if (!value || typeof value !== "object") throw new Error();
          const row = value as SavedMutation<unknown>;
          if (
            Object.keys(row).sort().join() !==
              "accountId,origin,request,version" ||
            row.version !== 1 ||
            accessOrigin(row.origin) !== row.origin ||
            typeof row.accountId !== "string"
          )
            throw new Error();
          return { ...row, request: parse(row.request) };
        } catch {
          throw new CliConfigurationError(`Invalid ${label} file`);
        }
      },
    },
    operation,
  );
}
export function withFilesOrganizationOperation<T>(
  path: string,
  operation: Parameters<
    typeof withFilesMutationOperation<
      ReturnType<typeof parseFilesOrganizationRequest>,
      T
    >
  >[3],
) {
  return withFilesMutationOperation(
    path,
    "Files organization operation",
    parseFilesOrganizationRequest,
    operation,
  );
}
export function withFilesRestorationOperation<T>(
  path: string,
  operation: Parameters<
    typeof withFilesMutationOperation<
      ReturnType<typeof parseRestoreFileRevisionRequest>,
      T
    >
  >[3],
) {
  return withFilesMutationOperation(
    path,
    "Files restoration operation",
    parseRestoreFileRevisionRequest,
    operation,
  );
}

export function withFilesTrashOperation<T>(
  path: string,
  operation: Parameters<
    typeof withFilesMutationOperation<
      ReturnType<typeof parseFileTrashRequest>,
      T
    >
  >[3],
) {
  return withFilesMutationOperation(
    path,
    "Files trash operation",
    parseFileTrashRequest,
    operation,
  );
}

export function withFilesDeletionOperation<T>(
  path: string,
  operation: Parameters<
    typeof withFilesMutationOperation<
      ReturnType<typeof parseFileDeletionRequest>,
      T
    >
  >[3],
) {
  return withFilesMutationOperation(
    path,
    "Files deletion operation",
    parseFileDeletionRequest,
    operation,
  );
}
