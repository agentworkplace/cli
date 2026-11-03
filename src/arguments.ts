import { type Command, InvalidArgumentError } from "commander";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `--limit` parser that rejects non-integers and out-of-range page sizes. */
export function limitParser(maximum: number) {
  return (value: string) => {
    const limit = Number(value);
    if (!/^\d+$/.test(value) || limit < 1 || limit > maximum)
      throw new InvalidArgumentError(
        `Use a whole number from 1 to ${maximum}.`,
      );
    return limit;
  };
}

/** Mailbox names are saved with signup state, so reject overlong ones first. */
export function mailboxNameParser(value: string) {
  const length = value.trim().length;
  if (length < 3 || length > 48)
    throw new InvalidArgumentError("Use 3 to 48 characters.");
  return value;
}

// Options whose `<id>` or `<uuid>` value is always a UUID.
const uuidOptions = new Set([
  "mailbox",
  "account",
  "accountId",
  "id",
  "revision",
  "expectedVersion",
  "message",
  "file",
  "purchaseId",
  "nominationId",
  "keyId",
  "grantId",
  "attachment",
  "submissionId",
]);
// Positional arguments that are always UUIDs; `folder` and `parent` also take `root`.
const uuidArguments = new Set([
  "messageId",
  "attachmentId",
  "invitationId",
  "commandId",
  "purchaseId",
  "operationId",
  "file",
  "entry",
  "id",
  "upload",
]);

function invalid(command: Command, subject: string, value: string) {
  command.error(`error: ${subject} '${value}' is invalid. Use a UUID.`, {
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

/**
 * Reject malformed IDs before any credential read or request, so the error
 * names the input instead of returning a server validation failure.
 */
export function validateIdentifiers(command: Command) {
  const values = command.opts<Record<string, unknown>>();
  for (const option of command.options) {
    const name = option.attributeName();
    const value = values[name];
    if (value === undefined) continue;
    const placeholder = /<(id|uuid)>/.test(option.flags);
    const parent = name === "parent" && /<id>/.test(option.flags);
    if (!placeholder || (!uuidOptions.has(name) && !parent)) continue;
    for (const item of Array.isArray(value) ? value : [value])
      if (
        typeof item === "string" &&
        !uuid.test(item) &&
        !(parent && item === "root")
      )
        invalid(command, `option '${option.flags}' argument`, item);
  }
  command.registeredArguments.forEach((argument, index) => {
    const value = command.processedArgs[index] as unknown;
    if (typeof value !== "string") return;
    const name = argument.name();
    if (name === "folder" && value === "root") return;
    if (uuidArguments.has(name) || name === "folder")
      if (!uuid.test(value))
        invalid(command, `command-argument <${name}> value`, value);
  });
}
