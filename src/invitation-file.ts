import type { MailboxAddressChoice } from "@agent-workplace/sdk";
import { accessOrigin } from "./credentials.js";
import { CliConfigurationError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";

interface InvitationIdentity {
  version: 1;
  origin: string;
  invitationId: string;
  workplaceId: string;
  accountId: string;
}
export interface SavedInvitation extends InvitationIdentity {
  kind: "invitation";
  code: string;
}
export type InvitationAttempt = InvitationIdentity & {
  kind: "invitation-attempt";
  handoffId: string;
} & (
    | {
        phase: "pending";
        code: string;
        recoveryProof: string;
        mailboxAddressChoice?: MailboxAddressChoice;
      }
    | {
        phase: "complete";
        code?: never;
        recoveryProof?: never;
        mailboxAddressChoice?: never;
      }
  );
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const proof = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const identityFields = [
  "version",
  "origin",
  "invitationId",
  "workplaceId",
  "accountId",
  "kind",
];
function invalid() {
  return new CliConfigurationError("Invalid private invitation file");
}
function identity(value: unknown) {
  if (!value || typeof value !== "object") throw invalid();
  const row = value as SavedInvitation;
  if (
    row.version !== 1 ||
    typeof row.origin !== "string" ||
    accessOrigin(row.origin) !== row.origin ||
    !uuid.test(row.invitationId) ||
    !uuid.test(row.workplaceId) ||
    !uuid.test(row.accountId)
  )
    throw invalid();
}
function fields(value: object, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}
function validateInvitation(value: unknown): SavedInvitation {
  identity(value);
  const row = value as SavedInvitation;
  fields(row, [...identityFields, "code"]);
  if (
    row.kind !== "invitation" ||
    typeof row.code !== "string" ||
    !proof.test(row.code)
  )
    throw invalid();
  return row;
}
function validateAttempt(value: unknown): InvitationAttempt {
  identity(value);
  const row = value as InvitationAttempt;
  const base = [...identityFields, "handoffId", "phase"];
  if (row.kind !== "invitation-attempt" || !uuid.test(row.handoffId))
    throw invalid();
  if (row.phase === "complete") fields(row, base);
  else if (row.phase === "pending") {
    fields(row, [...base, "code", "recoveryProof", "mailboxAddressChoice"]);
    if (
      typeof row.code !== "string" ||
      !proof.test(row.code) ||
      typeof row.recoveryProof !== "string" ||
      !proof.test(row.recoveryProof)
    )
      throw invalid();
    const choice = row.mailboxAddressChoice;
    if (choice !== undefined) {
      if (!choice || typeof choice !== "object") throw invalid();
      if (choice.kind === "automatic") fields(choice, ["kind"]);
      else if (
        choice.kind === "exact" &&
        typeof choice.localPart === "string" &&
        choice.localPart.length >= 3 &&
        choice.localPart.length <= 48
      )
        fields(choice, ["kind", "localPart"]);
      else throw invalid();
    }
  } else throw invalid();
  return row;
}
interface Store<T> {
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
}
export function withInvitation<T>(
  path: string,
  operation: (store: Store<SavedInvitation>) => Promise<T>,
) {
  return withPrivateJsonFile(
    path,
    { label: "Invitation", maximumBytes: 4096, validate: validateInvitation },
    operation,
  );
}
export function withInvitationAttempt<T>(
  path: string,
  operation: (store: Store<InvitationAttempt>) => Promise<T>,
) {
  return withPrivateJsonFile(
    path,
    {
      label: "Invitation attempt",
      maximumBytes: 4096,
      validate: validateAttempt,
    },
    operation,
  );
}
export function completedInvitationAttempt(
  attempt: InvitationAttempt,
): InvitationAttempt {
  return {
    version: 1,
    kind: "invitation-attempt",
    phase: "complete",
    origin: attempt.origin,
    invitationId: attempt.invitationId,
    workplaceId: attempt.workplaceId,
    accountId: attempt.accountId,
    handoffId: attempt.handoffId,
  };
}
