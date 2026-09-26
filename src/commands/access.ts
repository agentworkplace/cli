import {
  productClient,
  productionApiOrigin,
  type ProductClientOptions,
} from "../client.js";
import type { MailboxAddressChoice } from "@agent-workplace/sdk";
import { randomBytes } from "node:crypto";
import {
  AgentWorkplaceError,
  type AccessStatus,
  type AccountAccessStatus,
  type AgentWorkplace,
} from "@agent-workplace/sdk";
import {
  accessOrigin,
  withCredentials,
  type CredentialState,
} from "../credentials.js";
import { CliConfigurationError } from "../errors.js";
import type { WriteOutput } from "../output.js";

export interface AccessCommandOptions extends ProductClientOptions {
  baseUrl?: string | undefined;
  credentials?: string | undefined;
  json: boolean;
  write: WriteOutput;
}
function output(value: unknown, json: boolean, write: WriteOutput) {
  write(
    json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`,
  );
}
function signupOutput(status: AccessStatus, json: boolean, write: WriteOutput) {
  if (json) return output(status, true, write);
  const delivery = status.nomination?.deliveryState;
  const next =
    delivery === "failed"
      ? "Check status, then resend the nomination if appropriate."
      : delivery === "uncertain"
        ? "Check status before retrying nomination delivery."
        : delivery === "accepted"
          ? "Read the nomination ID from status before confirming ownership."
          : "Check status for the current nomination and next step.";
  write(
    [
      status.mailbox?.address
        ? `Mailbox address: ${status.mailbox.address}`
        : "Mailbox address: unavailable; check account-status or mail address",
      ...(status.mailbox
        ? ["This address is permanent and cannot be renamed."]
        : []),
      `Account ID: ${status.accountId}`,
      `Workplace ID: ${status.workplaceId}`,
      `Workplace status: ${status.workplaceState}`,
      ...(status.workplaceState === "unconfirmed"
        ? [
            `Cleanup deadline: ${status.cleanupAt}`,
            `Nomination delivery: ${delivery ?? "none"}`,
            `Next: ${next}`,
          ]
        : []),
    ].join("\n") + "\n",
  );
}

export async function executeSignup(
  options: AccessCommandOptions & {
    name: string;
    ownerEmail: string;
    mailboxName?: string;
    mailboxDefault?: boolean;
  },
) {
  await withCredentials(options.credentials, async (store) => {
    let state = await store.read();
    if (state?.version === 1)
      throw new CliConfigurationError(
        "Credential file belongs to an account, not a signup; choose a separate credential file",
      );
    const origin =
      options.baseUrl !== undefined
        ? accessOrigin(options.baseUrl)
        : (state?.origin ?? productionApiOrigin);
    if (
      state &&
      (state.origin !== origin ||
        state.name !== options.name.trim() ||
        state.nominatedEmail !== options.ownerEmail.trim().toLowerCase())
    )
      throw new CliConfigurationError(
        "Credential file belongs to another signup; choose a separate credential file",
      );
    if (!state) {
      state = {
        origin,
        name: options.name.trim(),
        nominatedEmail: options.ownerEmail.trim().toLowerCase(),
        bootstrapProof: randomBytes(32).toString("base64url"),
        acknowledged: false,
      };
      await store.write(state); // Must complete before the first HTTP request.
    }
    if (options.mailboxName !== undefined && options.mailboxDefault)
      throw new CliConfigurationError("Choose only one mailbox address option");
    const selected: MailboxAddressChoice | undefined =
      options.mailboxName !== undefined
        ? { kind: "exact", localPart: options.mailboxName }
        : options.mailboxDefault
          ? { kind: "automatic" }
          : undefined;
    if (selected && !state.credential) {
      state = { ...state, mailboxAddressChoice: selected };
      await store.write(state);
    }
    const client = productClient(options, origin);
    if (state.credential) {
      try {
        // Safe after a lost acknowledgement response or an interrupted local write.
        await client.acknowledgeSignup(state.credential.key);
        state = {
          origin: state.origin,
          name: state.name,
          nominatedEmail: state.nominatedEmail,
          credential: state.credential,
          acknowledged: true,
        };
        await store.write(state);
        const status = await client.accessStatus(state.credential!.key);
        if (
          status.accountId !== state.credential!.accountId ||
          status.workplaceId !== state.credential!.workplaceId
        )
          throw new CliConfigurationError(
            "Saved credential identity does not match the API response",
          );
        signupOutput(status, options.json, options.write);
        return;
      } catch (error) {
        if (
          !(error instanceof AgentWorkplaceError) ||
          error.code !== "access_denied" ||
          !state.bootstrapProof
        )
          throw error;
      }
    }
    if (!state.bootstrapProof)
      throw new CliConfigurationError("No signup recovery proof is available");
    let response;
    try {
      response = await client.signup({
        name: state.name,
        nominatedEmail: state.nominatedEmail,
        bootstrapProof: state.bootstrapProof,
        mailboxAddressChoice: state.mailboxAddressChoice,
        expectedChoiceRevision: state.mailboxChoiceRevision,
      });
    } catch (error) {
      if (
        error instanceof AgentWorkplaceError &&
        error.choiceRevision !== undefined
      ) {
        state = { ...state, mailboxChoiceRevision: error.choiceRevision };
        if (
          ["address_unavailable", "address_choice_expired"].includes(
            error.code ?? "",
          )
        )
          delete state.mailboxAddressChoice;
        await store.write(state);
      }
      throw error;
    }
    state = {
      ...state,
      credential: {
        accountId: response.accountId,
        workplaceId: response.workplaceId,
        key: response.credential.key,
      },
    };
    await store.write(state);
    await client.acknowledgeSignup(response.credential.key);
    const completed: CredentialState = {
      origin: state.origin,
      name: state.name,
      nominatedEmail: state.nominatedEmail,
      credential: state.credential!,
      acknowledged: true,
    };
    await store.write(completed);
    signupOutput(
      await client.accessStatus(response.credential.key),
      options.json,
      options.write,
    );
  });
}

export async function executeAccess(
  options: AccessCommandOptions,
  resend = false,
) {
  await executeSavedOperation(options, async (client, key) =>
    resend ? client.resendNomination(key) : client.accessStatus(key),
  );
}

export async function executeAccountStatus(options: AccessCommandOptions) {
  await executeSavedOperation(options, async (_client, _key, status) => status);
}

export async function executeNominationChange(
  options: AccessCommandOptions,
  change: { nominationId: string; nominatedEmail?: string },
) {
  await executeSavedOperation(options, (client, key) =>
    change.nominatedEmail === undefined
      ? client.cancelNomination(key, { nominationId: change.nominationId })
      : client.correctNomination(key, {
          nominationId: change.nominationId,
          nominatedEmail: change.nominatedEmail,
        }),
  );
}

export async function executeOwnershipConfirmation(
  options: AccessCommandOptions,
  input: {
    nominationId: string;
    code: string;
    ownerMailboxAddressChoice?: MailboxAddressChoice;
  },
) {
  await executeSavedOperation(options, (client, key) =>
    client.confirmOwnership(key, input),
  );
}

/** Bounded non-interactive input; codes never enter argv or credential storage. */
export async function readOwnershipCode(
  input: AsyncIterable<string | Uint8Array>,
) {
  let value = "";
  for await (const chunk of input) {
    value +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (value.length > 64)
      throw new CliConfigurationError(
        "Expected one six-digit ownership code on standard input",
      );
  }
  if (!/^\d{6}(?:\r?\n)?$/.test(value))
    throw new CliConfigurationError(
      "Expected one six-digit ownership code on standard input",
    );
  return value.trim();
}

export async function executeSavedOperation(
  options: AccessCommandOptions,
  operation: (
    client: AgentWorkplace,
    key: string,
    status: AccountAccessStatus,
    origin: string,
  ) => Promise<object>,
) {
  await withCredentials(options.credentials, async (store) => {
    const state = await store.read();
    if (!state?.credential)
      throw new CliConfigurationError(
        "No saved credentials; save an account key or complete signup first",
      );
    if (
      options.baseUrl !== undefined &&
      accessOrigin(options.baseUrl) !== state.origin
    )
      throw new CliConfigurationError(
        "Saved credentials belong to another API origin",
      );
    const client = productClient(options, state.origin);
    const status = await client.accountStatus({ apiKey: state.credential.key });
    if (
      status.accountId !== state.credential.accountId ||
      status.workplaceId !== state.credential.workplaceId
    )
      throw new CliConfigurationError(
        "Saved credential account does not match the API response",
      );
    const result = await operation(
      client,
      state.credential.key,
      status,
      state.origin,
    );
    output(result, options.json, options.write);
  });
}

export async function executeCurrentNomination(options: AccessCommandOptions) {
  await executeSavedOperation(options, (client, key) =>
    client.currentNomination(key),
  );
}
export async function executeNominationAuthorization(
  options: AccessCommandOptions,
  nominatedEmail: string,
) {
  await executeSavedOperation(options, async (client, key) => {
    const current = await client.currentNomination(key);
    return client.authorizeNomination(key, {
      nominatedEmail,
      expectedNominationId: current.nomination?.id ?? null,
    });
  });
}
