import { randomUUID } from "node:crypto";
import { productClient } from "../client.js";
import {
  accessOrigin,
  completedCredentialState,
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
  await withCredentials(options.credentials, async (store) => {
    let state = await store.read();
    if (!state?.credential)
      throw new CliConfigurationError("No saved agent credential");
    const origin = options.baseUrl
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
    const status = await client.accountStatus({ apiKey: state.credential.key });
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
      const candidate = await client.beginKeyRotation(
        state.credential!.key,
        rotation.operationId,
        rotation.name,
      );
      if (candidate.operationId !== rotation.operationId)
        throw new CliConfigurationError(
          "Rotation response does not match the saved operation",
        );
      state = {
        ...state,
        credential: { ...state.credential!, key: candidate.key },
        rotation: { ...rotation, phase: "saved" },
      };
      // If this fails, no finalization request is made and the predecessor stays valid.
      await store.write(state);
    }
    await client.completeKeyRotation(
      state.credential!.key,
      rotation.operationId,
    );
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
export async function executeKeyList(
  options: AccessCommandOptions,
  accountId?: string,
) {
  await executeSavedOperation(options, (client, apiKey, status) =>
    client.listAgentKeys({ apiKey }, accountId ?? status.accountId),
  );
}
export async function executeKeyEdit(
  options: AccessCommandOptions,
  input: { accountId?: string; keyId: string; name?: string },
) {
  await executeSavedOperation(options, (client, apiKey, status) =>
    input.name === undefined
      ? client.revokeAgentKey(
          { apiKey },
          input.accountId ?? status.accountId,
          input.keyId,
        )
      : client.renameAgentKey(
          { apiKey },
          input.accountId ?? status.accountId,
          input.keyId,
          input.name,
        ),
  );
}

export async function executeKeyIssue(
  options: AccessCommandOptions & {
    accountId?: string;
    name: string;
    saveTo: string;
  },
  recovery: boolean,
) {
  await withCredentials(options.credentials, async (source) => {
    const saved = await source.read();
    if (!saved?.credential)
      throw new CliConfigurationError("No saved agent credential");
    if (options.baseUrl && accessOrigin(options.baseUrl) !== saved.origin)
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
