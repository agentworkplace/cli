import { randomUUID } from "node:crypto";
import {
  AgentWorkplaceError,
  type AccountAccessStatus,
  type AgentWorkplace,
} from "@agent-workplace/sdk";
import { productClient } from "../client.js";
import {
  accessOrigin,
  completedCredentialState,
  requireCredentialFile,
  withCredentials,
  credentialFilePath,
  type CredentialState,
} from "../credentials.js";
import { CliConfigurationError } from "../errors.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";

/** The file lock spans issuance, atomic persistence and acknowledgement. The
 * saved phase tells an interrupted process which credential it must use next. */
export async function executeKeyRotation(
  options: AccessCommandOptions & { name: string },
) {
  requireCredentialFile(options);
  await withCredentials(options.credentials, async (store) => {
    let state = await store.read();
    if (!state?.credential)
      throw new CliConfigurationError("No saved agent credential");
    const origin =
      options.baseUrl !== undefined
        ? accessOrigin(options.baseUrl)
        : state.origin;
    if (origin !== state.origin)
      throw new CliConfigurationError(
        "Credential file belongs to another API origin",
      );
    const name = options.name.trim();
    if (!name || name.length > 32)
      throw new CliConfigurationError("Key name must contain 1–32 characters");
    if (state.rotation && state.rotation.name !== name)
      throw new CliConfigurationError(
        "Resume the unfinished rotation using its original name",
      );
    const client = productClient(options, origin);
    /** A refused rotation can leave this file holding a dead key. Go back to the
     * previous key only once it proves the candidate is really gone: a 401 can be
     * a passing fault, and the candidate may be the only live key. */
    const abandoned = async (error: unknown) => {
      if (!(error instanceof AgentWorkplaceError) || !state?.credential)
        return error;
      const rotation = state.rotation;
      const refused = error.code === "rotation_conflict";
      let key = state.credential.key;
      if (rotation?.phase === "saved") {
        const { predecessorKey, candidateId } = rotation;
        if (
          !predecessorKey ||
          !candidateId ||
          (!refused && error.code !== "access_denied")
        )
          return error;
        const keys = await client
          .listAgentKeys({ apiKey: predecessorKey }, state.credential.accountId)
          .catch(() => undefined);
        const unconfirmed =
          !keys ||
          keys.keys.some((item) => item.id === candidateId && item.enabled);
        // A refused completion came from the candidate, so it works even though
        // its handoff is over: keep it, and let rotation start again from it.
        if (unconfirmed && !refused) return error;
        if (!unconfirmed) key = predecessorKey;
      } else if (!refused) return error;
      await store.write(
        completedCredentialState(state, { ...state.credential, key }),
      );
      return new CliConfigurationError(
        "The unfinished rotation was cancelled; run rotate-key again",
      );
    };
    const status = await client
      .accountStatus({ apiKey: state.credential.key })
      .catch(async (error: unknown) => {
        throw state?.rotation?.phase === "saved"
          ? await abandoned(error)
          : error;
      });
    if (
      status.accountId !== state.credential.accountId ||
      status.workplaceId !== state.credential.workplaceId
    )
      throw new CliConfigurationError(
        "Saved credential account does not match the API response",
      );
    if (!state.rotation) {
      state = {
        ...state,
        rotation: { operationId: randomUUID(), name, phase: "issuing" },
      };
      await store.write(state);
    }
    const rotation = state.rotation!;
    if (rotation.phase === "issuing") {
      const candidate = await client
        .beginKeyRotation(
          state.credential!.key,
          rotation.operationId,
          rotation.name,
        )
        .catch(async (error: unknown) => {
          throw await abandoned(error);
        });
      if (candidate.operationId !== rotation.operationId)
        throw new CliConfigurationError(
          "Rotation response does not match the saved operation",
        );
      state = {
        ...state,
        credential: { ...state.credential!, key: candidate.key },
        rotation: {
          ...rotation,
          phase: "saved",
          predecessorKey: state.credential!.key,
          candidateId: candidate.id,
        },
      };
      // If this fails, no finalization request is made and the predecessor stays valid.
      await store.write(state);
    }
    await client
      .completeKeyRotation(state.credential!.key, rotation.operationId)
      .catch(async (error: unknown) => {
        throw await abandoned(error);
      });
    state = completedCredentialState(state, state.credential!);
    await store.write(state);
    const result = { rotated: true, accountId: state.credential!.accountId };
    options.write(
      `${JSON.stringify(result, null, options.json ? undefined : 2)}\n`,
    );
  });
}

export async function executeParticipantList(options: AccessCommandOptions) {
  await executeSavedOperation(options, (client, apiKey) =>
    client.listParticipants({ apiKey }),
  );
}
export async function executeParticipantRemoval(
  options: AccessCommandOptions,
  accountId?: string,
) {
  await executeSavedOperation(options, (client, apiKey, status) =>
    client.removeParticipant({ apiKey }, accountId ?? status.accountId),
  );
}
/** The key this command authenticates with, when the target is this account. An
 * API without `currentKeyId` gives none, so there is no marker and no guard. */
function keyInUse(status: AccountAccessStatus, accountId: string) {
  return accountId.toLowerCase() === status.accountId
    ? status.currentKeyId
    : undefined;
}

export async function executeKeyList(
  options: AccessCommandOptions,
  accountId?: string,
) {
  await executeSavedOperation(options, async (client, apiKey, status) => {
    const target = accountId ?? status.accountId;
    const list = await client.listAgentKeys({ apiKey }, target);
    const current = keyInUse(status, target);
    return {
      ...list,
      keys: list.keys.map((key) =>
        key.id === current ? { ...key, current: true } : key,
      ),
    };
  });
}
export async function executeKeyEdit(
  options: AccessCommandOptions,
  input: {
    accountId?: string;
    keyId: string;
    name?: string;
    allowCurrent?: boolean;
  },
) {
  await executeSavedOperation(options, async (client, apiKey, status) => {
    const target = input.accountId ?? status.accountId;
    if (input.name !== undefined)
      return client.renameAgentKey({ apiKey }, target, input.keyId, input.name);
    if (
      !input.allowCurrent &&
      input.keyId.toLowerCase() === keyInUse(status, target)
    )
      throw new CliConfigurationError(
        "This is the key in use, and revoking it ends this credential's access; use rotate-key to replace it, or pass --allow-current",
        { code: "current_key" },
      );
    return client.revokeAgentKey({ apiKey }, target, input.keyId);
  });
}

/** MCP agent grants are listed and revoked with the agent's key; a grant
 * cannot manage grants. */
export async function executeGrantList(
  options: AccessCommandOptions,
  accountId?: string,
) {
  await executeSavedOperation(options, (client, apiKey, status) =>
    client.listAgentGrants({ apiKey }, accountId ?? status.accountId),
  );
}
export async function executeGrantRevoke(
  options: AccessCommandOptions,
  input: { accountId?: string; grantId: string },
) {
  await executeSavedOperation(options, (client, apiKey, status) =>
    client.revokeAgentGrant(
      { apiKey },
      input.accountId ?? status.accountId,
      input.grantId,
    ),
  );
}

/**
 * Revoke-all on your own account must not depend on the response that returns
 * the replacement. Save a new key first, then revoke everything else with it:
 * until then the old key works, and a rerun simply replaces the new key too.
 */
async function recoverOwnKeys(
  client: AgentWorkplace,
  saved: CredentialState,
  destination: { write(state: CredentialState): Promise<void> },
  options: { name: string; write(result: object): void },
) {
  const credential = saved.credential!;
  const { accountId } = credential;
  const issue = () =>
    client.createAgentKey({ apiKey: credential.key }, accountId, options.name);
  // At the key limit there is no room for a replacement. The other keys are
  // going anyway, and revoking them keeps this key, so no step risks lockout.
  const key = await issue().catch(async (error: unknown) => {
    if (!(error instanceof AgentWorkplaceError) || error.code !== "key_limit")
      throw error;
    await client.recoverAgentKeysExceptCurrent(credential.key, accountId);
    return issue();
  });
  const replacement = { ...credential, key: key.key };
  await destination.write(completedCredentialState(saved, replacement));
  const result = await client.recoverAgentKeysExceptCurrent(
    replacement.key,
    accountId,
  );
  options.write({
    accountId,
    keyId: result.id,
    saved: true,
    recovered: true,
  });
}

export async function executeKeyIssue(
  options: AccessCommandOptions & {
    accountId?: string;
    name: string;
    saveTo: string;
  },
  recovery: boolean,
) {
  requireCredentialFile(options);
  await withCredentials(options.credentials, async (source) => {
    const saved = await source.read();
    if (!saved?.credential)
      throw new CliConfigurationError("No saved agent credential");
    if (
      options.baseUrl !== undefined &&
      accessOrigin(options.baseUrl) !== saved.origin
    )
      throw new CliConfigurationError(
        "Credential file belongs to another API origin",
      );
    const client = productClient(options, saved.origin);
    const status = await client.accountStatus({ apiKey: saved.credential.key });
    if (
      status.accountId !== saved.credential.accountId ||
      status.workplaceId !== saved.credential.workplaceId
    )
      throw new CliConfigurationError(
        "Saved credential account does not match the API response",
      );
    const accountId = options.accountId ?? status.accountId;
    const target = (
      await client.listParticipants({ apiKey: saved.credential.key })
    ).participants.find(
      (p) => p.id === accountId && p.kind === "agent" && p.state === "active",
    );
    if (!target)
      throw new CliConfigurationError(
        "Target is not an active agent in this workplace",
      );
    const sameFile =
      credentialFilePath(options.saveTo) ===
      credentialFilePath(options.credentials);
    if (sameFile && (accountId !== status.accountId || saved.rotation))
      throw new CliConfigurationError(
        "Choose a separate credential destination for this handoff",
      );
    const issue = async (destination: {
      read(): Promise<CredentialState | undefined>;
      write(state: CredentialState): Promise<void>;
    }) => {
      const previous = await destination.read();
      // Replacing a saved key here would leave it live with no local copy;
      // recovery may, because recovery has already revoked it.
      if (previous && !recovery)
        throw new CliConfigurationError(
          "Destination already holds a credential; choose a new --save-to path, or use rotate-key to replace this key",
        );
      if (
        previous &&
        (previous.origin !== saved.origin ||
          previous.credential?.accountId !== accountId ||
          previous.rotation)
      )
        throw new CliConfigurationError(
          "Destination belongs to another account or unfinished handoff",
        );
      const authorization = { apiKey: saved.credential!.key };
      if (recovery && accountId === saved.credential!.accountId) {
        await recoverOwnKeys(client, saved, destination, {
          name: options.name,
          write: (result) =>
            options.write(
              `${JSON.stringify(result, null, options.json ? undefined : 2)}\n`,
            ),
        });
        return;
      }
      const key = recovery
        ? await client.recoverAgentKeys(authorization, accountId, options.name)
        : await client.createAgentKey(authorization, accountId, options.name);
      const credential = {
        accountId,
        workplaceId: status.workplaceId,
        key: key.key,
      };
      await destination.write(
        accountId === saved.credential!.accountId
          ? completedCredentialState(saved, credential)
          : { version: 1, kind: "account", origin: saved.origin, credential },
      );
      options.write(
        `${JSON.stringify({ accountId, keyId: key.id, saved: true, recovered: recovery }, null, options.json ? undefined : 2)}\n`,
      );
    };
    if (sameFile) await issue(source);
    else await withCredentials(options.saveTo, issue);
  });
}
