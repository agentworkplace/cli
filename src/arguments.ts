import { type Command, InvalidArgumentError, Option } from "commander";

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

/** `--wait [seconds]`: a whole number of seconds from 1 to 3600. */
export function waitParser(value: string) {
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || seconds < 1 || seconds > 3600)
    throw new InvalidArgumentError(
      "Use a whole number of seconds from 1 to 3600.",
    );
  return seconds;
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

// Hidden older spellings, keyed to the long flag of their canonical option.
const aliasOf = new WeakMap<Option, string>();
const requiredCanonical = new WeakSet<Option>();

/** A canonical option, marked `(required)` in help when `required`. */
export function canonicalOption(
  flags: string,
  description: string,
  required = false,
) {
  const option = new Option(
    flags,
    required ? `${description} (required)` : description,
  );
  if (required) requiredCanonical.add(option);
  return option;
}

/** An older spelling kept working but hidden from help. */
export function hiddenAlias(flags: string, canonicalFlag: string) {
  const option = new Option(flags).hideHelp();
  aliasOf.set(option, canonicalFlag);
  return option;
}

/**
 * Fold each older spelling into one value under the attribute the command's
 * action reads, rejecting conflicting values and a missing required value.
 */
export function resolveAliases(command: Command) {
  const values = command.opts<Record<string, unknown>>();
  for (const alias of command.options) {
    const canonicalFlag = aliasOf.get(alias);
    if (!canonicalFlag) continue;
    const canonical = command.options.find(
      (option) => option.long === canonicalFlag,
    );
    if (!canonical) continue;
    const preferred = values[canonical.attributeName()];
    const older = values[alias.attributeName()];
    if (
      preferred !== undefined &&
      older !== undefined &&
      JSON.stringify(preferred) !== JSON.stringify(older)
    )
      command.error(
        `error: options '${canonical.flags}' and '${alias.flags}' name different values; use '${canonical.long}'`,
        { code: "commander.conflictingOption", exitCode: 1 },
      );
    const value = preferred ?? older;
    if (value === undefined && requiredCanonical.has(canonical))
      command.error(
        `error: required option '${canonical.flags}' not specified`,
        {
          code: "commander.missingMandatoryOptionValue",
          exitCode: 1,
        },
      );
    command.setOptionValue(alias.attributeName(), value);
  }
}
