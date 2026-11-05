import {
  parseMailSendRequest,
  parseMailAttachmentSelection,
  parseMailComposeRequest,
  type ComposeMailRequest,
  type SendMailRequest,
} from "@agent-workplace/sdk";
import { randomUUID } from "node:crypto";
import { readBoundedFile, readBoundedInput } from "./bounded-file.js";
import { accessOrigin } from "./credentials.js";
import { CliConfigurationError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";

type MailOperationOwner = {
  origin: string;
  workplaceId: string;
  accountId: string;
};
export type SavedMailOperation = MailOperationOwner &
  (
    | { version: 1; request: SendMailRequest & { mailboxId: string } }
    | { version: 2; request: ComposeMailRequest & { mailboxId: string } }
  );
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid() {
  return new CliConfigurationError("Invalid Mail operation file");
}

/**
 * Name the recipient option at fault before a new operation is saved; a
 * rejected address would otherwise read as a corrupt operation file.
 */
export function checkMailRecipients(recipients: {
  to?: string | string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
}) {
  for (const [flag, value] of [
    ["--to", recipients.to],
    ["--cc", recipients.cc],
    ["--bcc", recipients.bcc],
  ] as const)
    for (const address of value === undefined
      ? []
      : Array.isArray(value)
        ? value
        : [value])
      try {
        parseMailSendRequest({
          operationId: randomUUID(),
          mailboxId: randomUUID(),
          to: address,
          subject: "Recipient check",
          text: "Recipient check",
        });
      } catch {
        throw new CliConfigurationError(`Invalid ${flag} address: ${address}`);
      }
}
function validate(value: unknown): SavedMailOperation {
  if (!value || typeof value !== "object") throw invalid();
  const record = value as SavedMailOperation;
  if (
    Object.keys(record).sort().join() !==
      "accountId,origin,request,version,workplaceId" ||
    (record.version !== 1 && record.version !== 2) ||
    typeof record.origin !== "string" ||
    accessOrigin(record.origin) !== record.origin ||
    !uuid.test(record.accountId) ||
    !uuid.test(record.workplaceId) ||
    !record.request ||
    typeof record.request !== "object"
  )
    throw invalid();
  try {
    // An operation saved before empty bodies were refused stays readable, so
    // `mail status` can follow it; sending it again is refused by the SDK.
    const saved = record.request as { text?: unknown };
    const checked = saved.text === "" ? { ...saved, text: " " } : saved;
    const request =
      record.version === 1
        ? parseMailSendRequest(checked)
        : parseMailComposeRequest(checked);
    if (!request.mailboxId || !uuid.test(request.mailboxId)) throw invalid();
    Object.assign(record, {
      request: {
        ...request,
        text: saved.text,
        mailboxId: request.mailboxId,
      },
    });
  } catch {
    throw invalid();
  }
  return record;
}
export function withMailOperation<T>(
  path: string,
  operation: (store: {
    read(): Promise<SavedMailOperation | undefined>;
    write(value: SavedMailOperation): Promise<void>;
  }) => Promise<T>,
) {
  return withPrivateJsonFile(
    path,
    { label: "Mail operation", maximumBytes: 2 * 1024 * 1024, validate },
    operation,
  );
}

/** Replies and new sends need text; a forward carries the original message. */
export function requireMailText(text: string) {
  if (!text)
    throw new CliConfigurationError(
      "Mail body is empty; the email provider refuses a message without text",
    );
  return text;
}

/** Read bounded UTF-8 text without following a final symlink; never print it. */
async function readBoundedMailText(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedFile(path, maximumBytes),
  );
  if (text.includes("\0")) throw invalid();
  return text;
}

export async function readMailText(
  path: string,
  input?: AsyncIterable<string | Uint8Array>,
): Promise<string> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedInput(path, 262144, input),
    );
    if (text.includes("\0")) throw invalid();
    return text;
  } catch (error) {
    if (error instanceof Error && "code" in error)
      throw new CliConfigurationError(
        `Unable to read the Mail body file: ${path}`,
      );
    throw new CliConfigurationError(
      "Mail body must be readable UTF-8 plain text of at most 256 KiB; use --body-file - for stdin",
    );
  }
}

export async function readMailAttachmentSelection(path: string) {
  try {
    return parseMailAttachmentSelection(
      JSON.parse(await readBoundedMailText(path, 16_384)),
    );
  } catch {
    throw new CliConfigurationError(
      "Mail attachments must be a regular UTF-8 JSON file of at most 16 KiB containing one to ten immutable source references",
    );
  }
}
