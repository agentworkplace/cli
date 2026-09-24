import { saveMailAttachment } from "../mail-download.js";
import { randomUUID } from "node:crypto";
import {
  withMailOperation,
  readMailText,
  readMailAttachmentSelection,
} from "../mail-operation.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import { CliConfigurationError } from "../errors.js";
export async function executeMailAddress(
  options: AccessCommandOptions & { mailbox?: string },
) {
  await executeSavedOperation(options, async (client, key, status) => {
    if (options.mailbox)
      return client.getMailbox({ apiKey: key }, options.mailbox);
    if (!status.mailbox)
      throw new CliConfigurationError(
        "This server did not return mailbox discovery; do not repeat signup or create another account",
      );
    return status.mailbox;
  });
}
export async function executeMailboxList(
  options: AccessCommandOptions & { after?: string; limit?: number },
) {
  await executeSavedOperation(options, (client, key) =>
    client.listMailboxes(
      { apiKey: key },
      { after: options.after, limit: options.limit },
    ),
  );
}

export async function executeMailSend(
  options: AccessCommandOptions & {
    operation: string;
    to?: string | string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    bodyFile?: string;
    attachmentsFile?: string;
    mailbox?: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withMailOperation(options.operation, async (store) => {
      const attachments =
        options.attachmentsFile === undefined
          ? undefined
          : await readMailAttachmentSelection(options.attachmentsFile);
      let saved = await store.read();
      if (saved) {
        if (saved.version !== 1)
          throw new CliConfigurationError(
            "Use the original Mail composition command to retry this operation",
          );
        if (
          saved.origin !== origin ||
          saved.workplaceId !== status.workplaceId ||
          saved.accountId !== status.accountId
        )
          throw new CliConfigurationError(
            "Mail operation belongs to another server, workplace or account",
          );
        if (
          (options.to !== undefined &&
            JSON.stringify(
              typeof options.to === "string" ? [options.to] : options.to,
            ) !==
              JSON.stringify(
                typeof saved.request.to === "string"
                  ? [saved.request.to]
                  : saved.request.to,
              )) ||
          (options.cc !== undefined &&
            JSON.stringify(options.cc) !==
              JSON.stringify(saved.request.cc ?? [])) ||
          (options.bcc !== undefined &&
            JSON.stringify(options.bcc) !==
              JSON.stringify(saved.request.bcc ?? [])) ||
          (attachments !== undefined &&
            JSON.stringify(attachments) !==
              JSON.stringify(saved.request.attachments)) ||
          (options.subject !== undefined &&
            options.subject !== saved.request.subject) ||
          (options.mailbox !== undefined &&
            options.mailbox !== saved.request.mailboxId) ||
          (options.bodyFile !== undefined &&
            (await readMailText(options.bodyFile)) !== saved.request.text)
        )
          throw new CliConfigurationError(
            "Mail operation is immutable; retry with its original inputs",
          );
      } else {
        if (
          options.to === undefined ||
          options.subject === undefined ||
          options.bodyFile === undefined
        )
          throw new CliConfigurationError(
            "A new Mail operation requires --to, --subject and --body-file",
          );
        const mailboxId = options.mailbox ?? status.mailbox?.mailboxId;
        if (!mailboxId)
          throw new CliConfigurationError(
            "Mailbox discovery is unavailable; do not repeat signup",
          );
        saved = {
          version: 1,
          origin,
          workplaceId: status.workplaceId,
          accountId: status.accountId,
          request: {
            operationId: randomUUID(),
            mailboxId,
            to:
              Array.isArray(options.to) && options.to.length === 1
                ? options.to[0]!
                : options.to,
            ...(options.cc === undefined ? {} : { cc: options.cc }),
            ...(options.bcc === undefined ? {} : { bcc: options.bcc }),
            subject: options.subject,
            text: await readMailText(options.bodyFile),
            ...(attachments === undefined ? {} : { attachments }),
          },
        };
        // The immutable ID and payload are durable before the first sending request.
        await store.write(saved);
      }
      return client.sendMail({ apiKey: key }, saved.request);
    }),
  );
}

export async function executeMailCompose(
  options: AccessCommandOptions & {
    operation: string;
    kind: "reply" | "reply_all" | "forward";
    message?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    bodyFile?: string;
    attachmentsFile?: string;
    mailbox?: string;
  },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withMailOperation(options.operation, async (store) => {
      const attachments =
        options.attachmentsFile === undefined
          ? undefined
          : await readMailAttachmentSelection(options.attachmentsFile);
      let saved = await store.read();
      if (saved) {
        if (saved.version !== 2 || saved.request.kind !== options.kind)
          throw new CliConfigurationError(
            "Use the original Mail command to retry this operation",
          );
        if (
          saved.origin !== origin ||
          saved.workplaceId !== status.workplaceId ||
          saved.accountId !== status.accountId
        )
          throw new CliConfigurationError(
            "Mail operation belongs to another server, workplace or account",
          );
        const request = saved.request;
        if (
          (attachments !== undefined &&
            JSON.stringify(attachments) !==
              JSON.stringify(request.attachments)) ||
          (options.message !== undefined &&
            options.message !== request.sourceMessageId) ||
          (options.mailbox !== undefined &&
            options.mailbox !== request.mailboxId) ||
          (options.subject !== undefined &&
            options.subject !== request.subject) ||
          (options.to !== undefined &&
            JSON.stringify(options.to) !== JSON.stringify(request.to)) ||
          (options.cc !== undefined &&
            JSON.stringify(options.cc) !== JSON.stringify(request.cc)) ||
          (options.bcc !== undefined &&
            JSON.stringify(options.bcc) !== JSON.stringify(request.bcc)) ||
          (options.bodyFile !== undefined &&
            (await readMailText(options.bodyFile)) !== request.text)
        )
          throw new CliConfigurationError(
            "Mail operation is immutable; retry with its original inputs",
          );
      } else {
        if (
          !options.message ||
          options.subject === undefined ||
          options.bodyFile === undefined
        )
          throw new CliConfigurationError(
            "A new Mail composition requires --message, --subject and --body-file",
          );
        const mailboxId = options.mailbox ?? status.mailbox?.mailboxId;
        if (!mailboxId)
          throw new CliConfigurationError(
            "Mailbox discovery is unavailable; do not repeat signup",
          );
        saved = {
          version: 2,
          origin,
          workplaceId: status.workplaceId,
          accountId: status.accountId,
          request: {
            operationId: randomUUID(),
            mailboxId,
            kind: options.kind,
            sourceMessageId: options.message,
            subject: options.subject,
            text: await readMailText(options.bodyFile),
            ...(attachments === undefined ? {} : { attachments }),
            ...(options.to ? { to: options.to } : {}),
            ...(options.cc ? { cc: options.cc } : {}),
            ...(options.bcc ? { bcc: options.bcc } : {}),
          },
        };
        await store.write(saved);
      }
      return client.composeMail({ apiKey: key }, saved.request);
    }),
  );
}

export async function executeMailOperationStatus(
  options: AccessCommandOptions & { operation: string },
) {
  await executeSavedOperation(options, (client, key, status, origin) =>
    withMailOperation(options.operation, async (store) => {
      const saved = await store.read();
      if (!saved)
        throw new CliConfigurationError(
          "No saved Mail operation; status lookup never creates or sends one",
        );
      if (
        saved.origin !== origin ||
        saved.workplaceId !== status.workplaceId ||
        saved.accountId !== status.accountId
      )
        throw new CliConfigurationError(
          "Mail operation belongs to another server, workplace or account",
        );
      return client.getMailOperation(
        { apiKey: key },
        saved.request.operationId,
      );
    }),
  );
}

// Shared result formatting already JSON-escapes C0/ANSI. Escape additional terminal
// controls and line/bidi spoofing in every field for human presentation only.
function safeMailOutput(options: AccessCommandOptions): AccessCommandOptions {
  if (options.json) return options;
  return {
    ...options,
    write: (value) =>
      options.write(
        value.replace(
          /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
      ),
  };
}
export async function executeMailList(
  options: AccessCommandOptions & {
    mailbox?: string;
    after?: string;
    limit?: number;
    view?: "active" | "archive" | "all" | "trash";
    direction?: "incoming" | "outgoing";
    subject?: string;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.listMailMessages(
      { apiKey: key },
      {
        mailboxId: options.mailbox,
        after: options.after,
        limit: options.limit,
        view: options.view,
        direction: options.direction,
        subject: options.subject,
      },
    ),
  );
}
export async function executeMailRead(
  options: AccessCommandOptions & { messageId: string; mailbox?: string },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.getMailMessage({ apiKey: key }, options.messageId, {
      mailboxId: options.mailbox,
    }),
  );
}
export async function executeMailOmissions(
  options: AccessCommandOptions & {
    mailbox?: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.listMailOmissions(
      { apiKey: key },
      {
        mailboxId: options.mailbox,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}

export async function executeMailContentChange(
  options: AccessCommandOptions & {
    messageId: string;
    mailbox?: string;
    action: "trash" | "restore" | "purge" | "archive" | "unarchive";
  },
) {
  await executeSavedOperation(options, (client, key) => {
    const method = {
      trash: client.trashMailMessage,
      archive: client.archiveMailMessage,
      unarchive: client.unarchiveMailMessage,
      restore: client.restoreMailMessage,
      purge: client.purgeMailMessage,
    }[options.action];
    return method.call(client, { apiKey: key }, options.messageId, {
      mailboxId: options.mailbox,
    });
  });
}

export async function executeMailSenderBlock(
  options: AccessCommandOptions & {
    sender: string;
    mailbox?: string;
    blocked: boolean;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) => {
    const method = options.blocked
      ? client.blockMailSender
      : client.unblockMailSender;
    return method.call(
      client,
      { apiKey: key },
      { sender: options.sender, mailboxId: options.mailbox },
    );
  });
}
export async function executeMailSenderBlocks(
  options: AccessCommandOptions & {
    mailbox?: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.listMailSenderBlocks(
      { apiKey: key },
      {
        mailboxId: options.mailbox,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}

export async function executeMailThread(
  options: AccessCommandOptions & {
    messageId: string;
    mailbox?: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.getMailThread({ apiKey: key }, options.messageId, {
      mailboxId: options.mailbox,
      after: options.after,
      limit: options.limit,
    }),
  );
}

export async function executeMailAttachments(
  options: AccessCommandOptions & {
    messageId: string;
    mailbox?: string;
    after?: number;
    limit?: number;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.listMailAttachments({ apiKey: key }, options.messageId, {
      mailboxId: options.mailbox,
      after: options.after,
      limit: options.limit,
    }),
  );
}

export async function executeMailPreparations(
  options: AccessCommandOptions & {
    mailbox?: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(safeMailOutput(options), (client, key) =>
    client.listMailPreparations(
      { apiKey: key },
      {
        mailboxId: options.mailbox,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}

export async function executeMailDownload(
  options: AccessCommandOptions & {
    messageId: string;
    attachmentId: string;
    mailbox?: string;
    output: string;
  },
) {
  await executeSavedOperation(safeMailOutput(options), async (client, key) => {
    const result = await client.downloadMailAttachment(
      { apiKey: key },
      {
        messageId: options.messageId,
        attachmentId: options.attachmentId,
        mailboxId: options.mailbox,
      },
    );
    const output = await saveMailAttachment(options.output, result.bytes);
    return {
      messageId: result.messageId,
      attachmentId: result.attachment.attachmentId,
      bytes: result.attachment.bytes,
      sha256: result.attachment.sha256,
      output,
    };
  });
}

export async function executeMailCheckpoint(
  options: AccessCommandOptions & { mailbox: string },
) {
  await executeSavedOperation(options, (client, key) =>
    client.getMailCheckpoint({ apiKey: key }, { mailboxId: options.mailbox }),
  );
}
export async function executeMailChanges(
  options: AccessCommandOptions & {
    mailbox: string;
    cursor: string;
    limit?: number;
  },
) {
  await executeSavedOperation(options, (client, key) =>
    client.listMailChanges(
      { apiKey: key },
      {
        mailboxId: options.mailbox,
        cursor: options.cursor,
        limit: options.limit,
      },
    ),
  );
}
export async function executeMailOperations(
  options: AccessCommandOptions & {
    mailbox: string;
    after?: string;
    limit?: number;
  },
) {
  await executeSavedOperation(options, (client, key) =>
    client.listMailOperations(
      { apiKey: key },
      {
        mailboxId: options.mailbox,
        after: options.after,
        limit: options.limit,
      },
    ),
  );
}

export async function executeMailOperation(
  options: AccessCommandOptions & { operationId: string },
) {
  await executeSavedOperation(options, (client, key) =>
    client.getMailOperation({ apiKey: key }, options.operationId),
  );
}
