import { randomUUID } from "node:crypto";
import {
  parseMailAttachmentFileCopyIntent,
  type MailAttachmentFileCopyIntent,
} from "@agent-workplace/sdk";
import { accessOrigin } from "../credentials.js";
import { withPrivateJsonFile } from "../private-file.js";
import { CliConfigurationError } from "../errors.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
interface SavedCopy {
  version: 1;
  origin: string;
  accountId: string;
  intent: MailAttachmentFileCopyIntent;
}
export async function executeMailCopy(
  options: AccessCommandOptions & {
    operation: string;
    message?: string;
    attachment?: string;
    mailbox?: string;
    name?: string;
    parent?: string;
    file?: string;
    expectedVersion?: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withPrivateJsonFile(
      options.operation,
      {
        label: "Mail copy operation",
        maximumBytes: 16384,
        validate(value: unknown): SavedCopy {
          try {
            if (!value || typeof value !== "object") throw new Error();
            const row = value as SavedCopy;
            if (
              Object.keys(row).sort().join() !==
                "accountId,intent,origin,version" ||
              row.version !== 1 ||
              accessOrigin(row.origin) !== row.origin ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                row.accountId,
              )
            )
              throw new Error();
            return {
              ...row,
              intent: parseMailAttachmentFileCopyIntent(row.intent),
            };
          } catch {
            throw new CliConfigurationError("Invalid Mail copy operation file");
          }
        },
      },
      async (store) => {
        const saved = await store.read();
        if (saved) {
          if (
            saved.origin !== origin ||
            saved.accountId !== status.accountId ||
            saved.intent.request.workplaceId !== status.workplaceId
          )
            throw new CliConfigurationError(
              "Mail copy operation belongs to another server, workplace or account",
            );
          const {
            source,
            request: { target },
          } = saved.intent;
          if (
            (options.message !== undefined &&
              options.message !== source.messageId) ||
            (options.attachment !== undefined &&
              options.attachment !== source.attachmentId) ||
            (options.mailbox !== undefined &&
              options.mailbox !== source.mailboxId) ||
            (options.name !== undefined &&
              (!("name" in target) || options.name !== target.name)) ||
            (options.parent !== undefined &&
              (!("name" in target) ||
                (options.parent === "root" ? null : options.parent) !==
                  (target.parentId ?? null))) ||
            (options.file !== undefined &&
              (!("fileId" in target) || options.file !== target.fileId)) ||
            (options.expectedVersion !== undefined &&
              (!("version" in target) ||
                options.expectedVersion !== target.version))
          )
            throw new CliConfigurationError(
              "Mail copy operation is immutable; retry its original inputs",
            );
          store.assertOwned();
          return client.resumeMailAttachmentFileCopy(
            { apiKey: key },
            saved.intent,
          );
        }
        if (
          !options.message ||
          !options.attachment ||
          Boolean(options.name) === Boolean(options.file) ||
          Boolean(options.file) !== Boolean(options.expectedVersion) ||
          (options.file && options.parent !== undefined)
        )
          throw new CliConfigurationError(
            "A new copy requires --message, --attachment and either --name or --file with --expected-version; --parent applies only to a new file",
          );
        const mailboxId = options.mailbox ?? status.mailbox?.mailboxId;
        if (!mailboxId)
          throw new CliConfigurationError(
            "Mailbox discovery is unavailable; select --mailbox explicitly",
          );
        return client.copyMailAttachmentToFile(
          { apiKey: key },
          {
            workplaceId: status.workplaceId,
            operationId: randomUUID(),
            expiresAt: new Date(Date.now() + 60 * 60000).toISOString(),
            source: {
              messageId: options.message,
              attachmentId: options.attachment,
              mailboxId,
            },
            target: options.name
              ? {
                  name: options.name,
                  ...(options.parent && options.parent !== "root"
                    ? { parentId: options.parent }
                    : {}),
                }
              : { fileId: options.file!, version: options.expectedVersion! },
          },
          async (intent) => {
            await store.write({
              version: 1,
              origin,
              accountId: status.accountId,
              intent,
            });
          },
        );
      },
    ),
  );
}
