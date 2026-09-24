import { randomUUID } from "node:crypto";
import { exportFilesLocally } from "../files-export.js";
import { downloadFileLocally } from "../files-download.js";
import {
  prepareFileUploadFromSource,
  parseFileReference,
  parseFilesOrganizationRequest,
  parseRestoreFileRevisionRequest,
  parseFileTrashRequest,
  parseFileDeletionRequest,
} from "@agent-workplace/sdk";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import {
  withFilesOperation,
  withFilesOrganizationOperation,
  withFilesRestorationOperation,
  withFilesTrashOperation,
  withFilesDeletionOperation,
  withFileUploadSource,
} from "../files-operation.js";
import { CliConfigurationError } from "../errors.js";
export async function executeFilesList(
  options: AccessCommandOptions & { after?: string; limit?: number },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.listFiles(
      { apiKey: key },
      {
        workplaceId: status.workplaceId,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}
export async function executeFilesPut(
  options: AccessCommandOptions & {
    operation: string;
    sourceFile: string;
    name?: string;
    parent?: string;
    file?: string;
    version?: string;
    contentType?: string;
    text?: boolean;
  },
) {
  if (options.file && options.parent !== undefined)
    throw new CliConfigurationError(
      "Use files organize to move an existing file",
    );
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesOperation(options.operation, async (store) =>
      withFileUploadSource(
        options.sourceFile,
        options.text ? 1024 * 1024 : 2_000_000_000,
        async (source) => {
          if (options.text) {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(
                await source.read(0, source.byteLength),
              );
            } catch {
              throw new CliConfigurationError("Text input must be valid UTF-8");
            }
          }
          let saved = await store.read();
          if (saved) {
            if (
              saved.origin !== origin ||
              saved.accountId !== status.accountId ||
              saved.request.workplaceId !== status.workplaceId
            )
              throw new CliConfigurationError(
                "Files operation belongs to another server, workplace or account",
              );
            const target = saved.request.target;
            if (
              (options.name !== undefined &&
                (!("name" in target) || target.name !== options.name)) ||
              (options.file !== undefined &&
                (!("fileId" in target) || target.fileId !== options.file)) ||
              (options.version !== undefined &&
                (!("version" in target) ||
                  target.version !== options.version)) ||
              (options.parent !== undefined &&
                (!("name" in target) ||
                  (target.parentId ?? null) !==
                    (options.parent === "root" ? null : options.parent))) ||
              (options.contentType !== undefined &&
                saved.request.contentType !== options.contentType)
            )
              throw new CliConfigurationError(
                "Files operation is immutable; retry its original inputs",
              );
          } else {
            if (
              Boolean(options.name) === Boolean(options.file) ||
              Boolean(options.file) !== Boolean(options.version)
            )
              throw new CliConfigurationError(
                "Specify a new --name or an existing --file and --expected-version",
              );
            saved = {
              version: 1,
              origin,
              accountId: status.accountId,
              request: await prepareFileUploadFromSource(
                {
                  workplaceId: status.workplaceId,
                  operationId: randomUUID(),
                  target: options.name
                    ? {
                        name: options.name,
                        ...(options.parent && options.parent !== "root"
                          ? { parentId: options.parent }
                          : {}),
                      }
                    : { fileId: options.file!, version: options.version! },
                  contentType:
                    options.contentType ??
                    (options.text
                      ? "text/plain; charset=utf-8"
                      : "application/octet-stream"),
                  expiresAt: new Date(Date.now() + 60 * 60000).toISOString(),
                },
                source,
              ),
            };
            await store.write(saved);
          }
          return client.uploadFileFromSource(
            { apiKey: key },
            saved.request,
            source,
          );
        },
      ),
    ),
  );
}
export async function executeFilesGet(
  options: AccessCommandOptions & {
    reference: string;
    output: string;
    operation?: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    downloadFileLocally(
      client,
      key,
      { origin, accountId: status.accountId, workplaceId: status.workplaceId },
      {
        ref: parseFileReference(options.reference),
        output: options.output,
        operation: options.operation,
      },
    ),
  );
}
export async function executeFilesStatus(
  options: AccessCommandOptions & {
    upload: string;
    cancel?: boolean;
    finalize?: boolean;
    parts?: boolean;
  },
) {
  await executeSavedOperation(options, (client, key, status) => {
    const method = options.cancel
      ? "cancelFileUpload"
      : options.finalize
        ? "finalizeFileUpload"
        : options.parts
          ? "getFileUploadedParts"
          : "getFileUpload";
    return client[method](
      { apiKey: key },
      { workplaceId: status.workplaceId, uploadId: options.upload },
    );
  });
}

export async function executeFilesTree(
  options: AccessCommandOptions & {
    parent?: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.listFilesTree(
      { apiKey: key },
      {
        workplaceId: status.workplaceId,
        parentId: options.parent === "root" ? null : options.parent,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}
export async function executeFilesEntry(
  options: AccessCommandOptions & { entry: string },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.getFilesEntry(
      { apiKey: key },
      { workplaceId: status.workplaceId, entryId: options.entry },
    ),
  );
}
export async function executeFilesOrganize(
  options: AccessCommandOptions & {
    action: "create_folder" | "organize" | "delete_folder";
    operation: string;
    entry?: string;
    expectedVersion?: string;
    name?: string;
    parent?: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesOrganizationOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (
        saved &&
        (saved.origin !== origin ||
          saved.accountId !== status.accountId ||
          saved.request.workplaceId !== status.workplaceId)
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      const request = parseFilesOrganizationRequest({
        workplaceId: status.workplaceId,
        operationId: saved?.request.operationId ?? randomUUID(),
        action: options.action,
        ...(options.action === "create_folder"
          ? {}
          : {
              entryId: options.entry,
              expectedVersion: options.expectedVersion,
            }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.parent === undefined
          ? {}
          : { parentId: options.parent === "root" ? null : options.parent }),
      });
      if (saved && JSON.stringify(saved.request) !== JSON.stringify(request))
        throw new CliConfigurationError(
          "Files operation is immutable; retry its original inputs",
        );
      if (!saved)
        await store.write({
          version: 1,
          origin,
          accountId: status.accountId,
          request,
        });
      return client.organizeFiles({ apiKey: key }, request);
    }),
  );
}

export async function executeFilesHistory(
  options: AccessCommandOptions & {
    file: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.listFileRevisions(
      { apiKey: key },
      {
        workplaceId: status.workplaceId,
        fileId: options.file,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}
export async function executeFilesRestore(
  options: AccessCommandOptions & {
    file: string;
    revision: string;
    expectedVersion: string;
    operation: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesRestorationOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (
        saved &&
        (saved.origin !== origin ||
          saved.accountId !== status.accountId ||
          saved.request.workplaceId !== status.workplaceId)
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      const request = parseRestoreFileRevisionRequest({
        workplaceId: status.workplaceId,
        operationId: saved?.request.operationId ?? randomUUID(),
        fileId: options.file,
        revisionId: options.revision,
        expectedVersion: options.expectedVersion,
      });
      if (saved && JSON.stringify(saved.request) !== JSON.stringify(request))
        throw new CliConfigurationError(
          "Files operation is immutable; retry its original inputs",
        );
      if (!saved)
        await store.write({
          version: 1,
          origin,
          accountId: status.accountId,
          request,
        });
      return client.restoreFileRevision({ apiKey: key }, request);
    }),
  );
}
export async function executeFilesRestorationStatus(
  options: AccessCommandOptions & { operation: string },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesRestorationOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (!saved)
        throw new CliConfigurationError(
          "Files restoration operation file is required",
        );
      if (
        saved.origin !== origin ||
        saved.accountId !== status.accountId ||
        saved.request.workplaceId !== status.workplaceId
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      return client.getFileRestoration({ apiKey: key }, saved.request);
    }),
  );
}

export async function executeFilesTrashList(
  options: AccessCommandOptions & { after?: string; limit?: number },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.listTrashedFiles(
      { apiKey: key },
      {
        workplaceId: status.workplaceId,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}
export async function executeFilesTrash(
  options: AccessCommandOptions & {
    action: "trash" | "restore";
    file: string;
    expectedVersion: string;
    operation: string;
    parent?: string;
    name?: string;
  },
) {
  if ((options.parent === undefined) !== (options.name === undefined))
    throw new CliConfigurationError(
      "An explicit restore destination requires both --parent and --name",
    );
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesTrashOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (
        saved &&
        (saved.origin !== origin ||
          saved.accountId !== status.accountId ||
          saved.request.workplaceId !== status.workplaceId)
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      const request = parseFileTrashRequest({
        action: options.action,
        workplaceId: status.workplaceId,
        fileId: options.file,
        expectedVersion: options.expectedVersion,
        operationId: saved?.request.operationId ?? randomUUID(),
        ...(options.action === "restore" && options.parent !== undefined
          ? {
              destination: {
                parentId: options.parent === "root" ? null : options.parent,
                name: options.name,
              },
            }
          : {}),
      });
      if (saved && JSON.stringify(saved.request) !== JSON.stringify(request))
        throw new CliConfigurationError(
          "Files operation is immutable; retry its original inputs",
        );
      if (!saved)
        await store.write({
          version: 1,
          origin,
          accountId: status.accountId,
          request,
        });
      return client.changeFileTrash({ apiKey: key }, request);
    }),
  );
}
export async function executeFilesTrashStatus(
  options: AccessCommandOptions & { operation: string },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesTrashOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (!saved)
        throw new CliConfigurationError(
          "Files trash operation file is required",
        );
      if (
        saved.origin !== origin ||
        saved.accountId !== status.accountId ||
        saved.request.workplaceId !== status.workplaceId
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      return client.getFileTrashOperation({ apiKey: key }, saved.request);
    }),
  );
}

export async function executeFilesDeletion(
  options: AccessCommandOptions & {
    action: "purge" | "clear_history";
    file: string;
    expectedVersion: string;
    operation: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesDeletionOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (
        saved &&
        (saved.origin !== origin ||
          saved.accountId !== status.accountId ||
          saved.request.workplaceId !== status.workplaceId)
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      const request = parseFileDeletionRequest({
        action: options.action,
        workplaceId: status.workplaceId,
        fileId: options.file,
        expectedVersion: options.expectedVersion,
        operationId: saved?.request.operationId ?? randomUUID(),
      });
      if (saved && JSON.stringify(saved.request) !== JSON.stringify(request))
        throw new CliConfigurationError(
          "Files operation is immutable; retry its original inputs",
        );
      if (!saved)
        await store.write({
          version: 1,
          origin,
          accountId: status.accountId,
          request,
        });
      return client.beginFileDeletion({ apiKey: key }, request);
    }),
  );
}
export async function executeFilesDeletionStatus(
  options: AccessCommandOptions & { operation: string },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withFilesDeletionOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (!saved)
        throw new CliConfigurationError(
          "Files deletion operation file is required",
        );
      if (
        saved.origin !== origin ||
        saved.accountId !== status.accountId ||
        saved.request.workplaceId !== status.workplaceId
      )
        throw new CliConfigurationError(
          "Files operation belongs to another server, workplace or account",
        );
      return client.getFileDeletionOperation({ apiKey: key }, saved.request);
    }),
  );
}

export async function executeFilesCheckpoint(options: AccessCommandOptions) {
  await executeSavedOperation(options, (client, key, status) =>
    client.getFilesCheckpoint(
      { apiKey: key },
      { workplaceId: status.workplaceId },
    ),
  );
}
export async function executeFilesChanges(
  options: AccessCommandOptions & { cursor: string; limit?: number },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.listFilesChanges(
      { apiKey: key },
      {
        workplaceId: status.workplaceId,
        cursor: options.cursor,
        limit: options.limit,
      },
    ),
  );
}
export async function executeFilesBaseline(
  options: AccessCommandOptions & { after?: string; limit?: number },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.listFilesBaseline(
      { apiKey: key },
      {
        workplaceId: status.workplaceId,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}

export async function executeFilesExport(
  options: AccessCommandOptions & {
    mode: "current" | "retained";
    folder?: string;
    output: string;
    operation: string;
  },
) {
  let partial = false;
  await executeSavedOperation(options, async (client, key, status, origin) => {
    const result = await exportFilesLocally(
      client,
      key,
      { origin, accountId: status.accountId, workplaceId: status.workplaceId },
      {
        mode: options.mode,
        parentId: options.folder === "root" ? null : options.folder,
        output: options.output,
        operation: options.operation,
      },
    );
    partial = result.state === "partial";
    return result;
  });
  if (partial)
    throw new CliConfigurationError(
      "Export is partial; inspect its manifest. Retry to resume this inventory, or use a new operation and destination to discover changes",
    );
}
