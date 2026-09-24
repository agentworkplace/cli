import type { MailboxAddressChoice } from "@agent-workplace/sdk";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withPrivateJsonFile } from "./private-file.js";

import { CliConfigurationError } from "./errors.js";

interface SavedCredential {
  accountId: string;
  workplaceId: string;
  key: string;
}
interface CredentialBase {
  origin: string;
  rotation?: { operationId: string; name: string; phase: "issuing" | "saved" };
}
/** Legacy creation records remain readable and retain their recovery state. */
export interface SignupCredentialState extends CredentialBase {
  version?: never;
  kind?: never;
  mailboxAddressChoice?: MailboxAddressChoice;
  mailboxChoiceRevision?: number;
  name: string;
  nominatedEmail: string;
  bootstrapProof?: string;
  credential?: SavedCredential;
  acknowledged: boolean;
}
/** A saved account credential is not evidence of a signup or an invitation. */
export interface AccountCredentialState extends CredentialBase {
  version: 1;
  kind: "account";
  credential: SavedCredential;
  name?: never;
  nominatedEmail?: never;
  bootstrapProof?: never;
  acknowledged?: never;
}
export type CredentialState = SignupCredentialState | AccountCredentialState;

export function completedCredentialState(
  state: CredentialState,
  credential: SavedCredential,
): CredentialState {
  return state.version === 1
    ? { version: 1, kind: "account", origin: state.origin, credential }
    : {
        origin: state.origin,
        name: state.name,
        nominatedEmail: state.nominatedEmail,
        acknowledged: true,
        credential,
      };
}

export function accessOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliConfigurationError("Specify an absolute API origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new CliConfigurationError(
      "Credentials require an HTTPS API origin, or HTTP on loopback",
    );
  return url.origin;
}

function validateState(value: unknown): CredentialState {
  if (
    !value ||
    typeof value !== "object" ||
    !("origin" in value) ||
    typeof value.origin !== "string"
  )
    throw new CliConfigurationError("Invalid credential file");
  const state = value as CredentialState;
  accessOrigin(state.origin);
  if ("version" in state || "kind" in state) {
    if (
      state.version !== 1 ||
      state.kind !== "account" ||
      !state.credential ||
      ["name", "nominatedEmail", "bootstrapProof", "acknowledged"].some(
        (field) => field in state,
      )
    )
      throw new CliConfigurationError("Invalid credential file");
  } else if (
    typeof state.name !== "string" ||
    typeof state.nominatedEmail !== "string" ||
    typeof state.acknowledged !== "boolean"
  ) {
    throw new CliConfigurationError("Invalid credential file");
  }

  if (state.version !== 1) {
    const choice = state.mailboxAddressChoice;
    if (
      choice &&
      (typeof choice !== "object" ||
        !["automatic", "exact"].includes(choice.kind) ||
        (choice.kind === "exact" &&
          (typeof choice.localPart !== "string" ||
            choice.localPart.length > 48)))
    )
      throw new CliConfigurationError("Invalid credential file");
    if (
      state.mailboxChoiceRevision !== undefined &&
      (!Number.isSafeInteger(state.mailboxChoiceRevision) ||
        state.mailboxChoiceRevision < 0)
    )
      throw new CliConfigurationError("Invalid credential file");
  }
  if (
    state.bootstrapProof !== undefined &&
    !/^[A-Za-z0-9_-]{43}$/.test(state.bootstrapProof)
  )
    throw new CliConfigurationError("Invalid credential file");
  if (
    state.credential &&
    (typeof state.credential.key !== "string" ||
      !state.credential.key ||
      !/^[0-9a-f-]{36}$/.test(state.credential.accountId) ||
      !/^[0-9a-f-]{36}$/.test(state.credential.workplaceId))
  )
    throw new CliConfigurationError("Invalid credential file");
  if (
    (!state.credential && !state.bootstrapProof) ||
    (state.acknowledged && (!state.credential || state.bootstrapProof))
  )
    throw new CliConfigurationError("Invalid credential file");
  if (
    state.rotation &&
    (!state.credential ||
      !/^[0-9a-f-]{36}$/.test(state.rotation.operationId) ||
      typeof state.rotation.name !== "string" ||
      !state.rotation.name.trim() ||
      state.rotation.name.length > 32 ||
      !["issuing", "saved"].includes(state.rotation.phase))
  )
    throw new CliConfigurationError("Invalid credential file");
  return state;
}

export function credentialFilePath(configuredPath: string | undefined) {
  return resolve(
    configuredPath ??
      join(homedir(), ".config", "agent-workplace", "credentials.json"),
  );
}

export async function withCredentials<T>(
  configuredPath: string | undefined,
  operation: (store: {
    read(): Promise<CredentialState | undefined>;
    write(value: CredentialState): Promise<void>;
  }) => Promise<T>,
) {
  return withPrivateJsonFile(
    credentialFilePath(configuredPath),
    {
      label: "Credential",
      maximumBytes: 8192,
      validate: validateState,
    },
    operation,
  );
}
