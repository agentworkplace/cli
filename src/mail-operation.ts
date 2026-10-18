import {
  parseMailSendRequest,
  parseMailAttachmentSelection,
  parseMailComposeRequest,
  type ComposeMailRequest,
  type SendMailRequest,
} from "@agent-workplace/sdk";
import { readBoundedFile } from "./bounded-file.js";
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
    const request =
      record.version === 1
        ? parseMailSendRequest(record.request)
        : parseMailComposeRequest(record.request);
    if (!request.mailboxId || !uuid.test(request.mailboxId)) throw invalid();
    Object.assign(record, {
      request: { ...request, mailboxId: request.mailboxId },
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

export async function readMailText(path: string): Promise<string> {
  try {
    return await readBoundedMailText(path, 262144);
  } catch {
    throw new CliConfigurationError(
      "Mail body must be a readable UTF-8 plain-text file of at most 256 KiB",
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
