import type {
  ChatAddRequest,
  ChatCreateRequest,
  ChatLeaveRequest,
  ChatRemoveRequest,
} from "@agent-workplace/sdk";
import { readBoundedFile } from "./bounded-file.js";
import { accessOrigin } from "./credentials.js";
import { CliConfigurationError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";

export type ChatAction = "create" | "post" | "add" | "leave" | "remove";
type ChatOperationOwner = {
  version: 1;
  origin: string;
  workplaceId: string;
  accountId: string;
};
export type SavedChatOperation = ChatOperationOwner &
  (
    | { action: "create"; request: ChatCreateRequest }
    | {
        action: "post";
        conversationId: string;
        request: { operationId: string; text: string };
      }
    | { action: "add"; conversationId: string; request: ChatAddRequest }
    | { action: "leave"; conversationId: string; request: ChatLeaveRequest }
    | { action: "remove"; conversationId: string; request: ChatRemoveRequest }
  );

// Local mirrors of the published Chat limits keep an unusable request from
// becoming a saved operation; the SDK still validates before transmission.
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumAccounts = 100;
function boundedText(value: unknown, maximumBytes: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\0\p{Surrogate}]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}
export const isChatText = (value: unknown) => boundedText(value, 64_000);
export const isChatTopic = (value: unknown) => boundedText(value, 1_000);
export const isChatId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
export function isChatAccountList(value: unknown, minimum: number) {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximumAccounts &&
    value.every(isChatId) &&
    new Set(value).size === value.length
  );
}

function invalid() {
  return new CliConfigurationError("Invalid Chat operation file");
}
function keys(value: object, expected: string[]) {
  return Object.keys(value).sort().join() === [...expected].sort().join();
}
function validRequest(record: SavedChatOperation) {
  const request = record.request as Record<string, unknown>;
  if (!request || typeof request !== "object" || !isChatId(request.operationId))
    return false;
  switch (record.action) {
    case "create":
      return (
        keys(request, [
          "operationId",
          "accountIds",
          ...("topic" in request ? ["topic"] : []),
        ]) &&
        isChatAccountList(request.accountIds, 2) &&
        (!("topic" in request) || isChatTopic(request.topic))
      );
    case "post":
      return keys(request, ["operationId", "text"]) && isChatText(request.text);
    case "add":
      return (
        keys(request, ["operationId", "accountIds"]) &&
        isChatAccountList(request.accountIds, 1)
      );
    case "leave":
      return keys(request, ["operationId"]);
    case "remove":
      return (
        keys(request, ["operationId", "accountId"]) &&
        isChatId(request.accountId)
      );
    default:
      return false;
  }
}
function validate(value: unknown): SavedChatOperation {
  if (!value || typeof value !== "object") throw invalid();
  const record = value as SavedChatOperation;
  const owner = [
    "accountId",
    "action",
    "origin",
    "request",
    "version",
    "workplaceId",
  ];
  if (
    !keys(
      record,
      record.action === "create" ? owner : [...owner, "conversationId"],
    ) ||
    record.version !== 1 ||
    typeof record.origin !== "string" ||
    accessOrigin(record.origin) !== record.origin ||
    !isChatId(record.accountId) ||
    !isChatId(record.workplaceId) ||
    ("conversationId" in record && !isChatId(record.conversationId)) ||
    !validRequest(record)
  )
    throw invalid();
  return record;
}

export function withChatOperation<T>(
  path: string,
  operation: (store: {
    read(): Promise<SavedChatOperation | undefined>;
    write(value: SavedChatOperation): Promise<void>;
  }) => Promise<T>,
) {
  return withPrivateJsonFile(
    path,
    // Worst-case JSON escaping of 64,000 bytes of text stays below this bound.
    { label: "Chat operation", maximumBytes: 512 * 1024, validate },
    operation,
  );
}

/** Byte-exact message text: no trimming or BOM removal, so a trailing newline
 * is posted. */
export async function readChatText(path: string): Promise<string> {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await readBoundedFile(path, 64_000));
    if (!isChatText(text)) throw new Error("Invalid text");
    return text;
  } catch {
    throw new CliConfigurationError(
      "Chat text must be a readable UTF-8 plain-text file of 1 to 64000 bytes without NUL characters",
    );
  }
}
