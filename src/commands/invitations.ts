import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AgentWorkplaceError,
  parseHumanInvitationFile,
  createHumanInvitationLink,
  parseHumanInvitationLink,
  type InvitationAdmission,
  type MailboxAddressChoice,
} from "@agent-workplace/sdk";
import {
  accessOrigin,
  credentialFilePath,
  withCredentials,
} from "../credentials.js";
import { productClient } from "../client.js";
import { CliConfigurationError } from "../errors.js";
import {
  completedInvitationAttempt,
  withInvitation,
  withInvitationAttempt,
  type InvitationAttempt,
} from "../invitation-file.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import { withPrivateJsonFile, withPrivateTextFile } from "../private-file.js";

function separatePaths(options: AccessCommandOptions, invitationFile?: string) {
  const credentials = credentialFilePath(options.credentials);
  const attempt = `${credentials}.invitation.json`;
  if (
    invitationFile &&
    [credentials, attempt].includes(resolve(invitationFile))
  )
    throw new CliConfigurationError(
      "Invitation and credential files must have different paths",
    );
  return { credentials, attempt };
}
function output(value: unknown, options: AccessCommandOptions) {
  options.write(
    JSON.stringify(value, null, options.json ? undefined : 2) + "\n",
  );
}
function sameIdentity(
  a: {
    origin: string;
    invitationId: string;
    accountId: string;
    workplaceId: string;
  },
  b: typeof a,
) {
  return (
    a.origin === b.origin &&
    a.invitationId === b.invitationId &&
    a.accountId === b.accountId &&
    a.workplaceId === b.workplaceId
  );
}
export async function executeInvitationCreate(
  options: AccessCommandOptions & {
    invitationFile: string;
    name: string;
    role?: "admin" | "member";
  },
) {
  separatePaths(options, options.invitationFile);
  await executeSavedOperation(options, async (client, key, _status, origin) =>
    withInvitation(options.invitationFile, async (store) => {
      if (await store.read())
        throw new CliConfigurationError(
          "Invitation file already exists; choose a new path",
        );
      const issued = await client.createAgentInvitation(
        { apiKey: key },
        { name: options.name, role: options.role },
      );
      await store.write({
        version: 1,
        kind: "invitation",
        origin,
        invitationId: issued.id,
        workplaceId: issued.workplaceId,
        accountId: issued.accountId,
        code: issued.code,
      });
      return {
        invitationId: issued.id,
        accountId: issued.accountId,
        workplaceId: issued.workplaceId,
        role: issued.role,
        expiresAt: issued.expiresAt,
        invitationFile: resolve(options.invitationFile),
      };
    }),
  );
}
export async function executeHumanInvitationCreate(
  options: AccessCommandOptions & {
    invitationFile?: string;
    invitationLinkFile?: string;
    dashboardUrl?: string;
    email: string;
    name?: string;
    role?: "admin" | "member";
  },
) {
  if (options.invitationFile && options.invitationLinkFile)
    throw new CliConfigurationError("Choose only one invitation output file");
  if (Boolean(options.invitationLinkFile) !== Boolean(options.dashboardUrl))
    throw new CliConfigurationError(
      "--dashboard-url is required only with --invitation-link-file",
    );
  const path = options.invitationFile ?? options.invitationLinkFile;
  separatePaths(options, path);
  await executeSavedOperation(options, async (client, key, _status, origin) => {
    const linkOptions = {
      dashboardOrigin: options.dashboardUrl ?? "",
      apiOrigin: origin,
    };
    if (options.invitationLinkFile) {
      try {
        createHumanInvitationLink(
          {
            version: 1,
            kind: "human-invitation",
            origin,
            invitationId: randomUUID(),
            workplaceId: randomUUID(),
            accountId: randomUUID(),
            code: randomBytes(32).toString("base64url"),
          },
          linkOptions,
        );
      } catch {
        throw new CliConfigurationError(
          "Specify a canonical HTTPS dashboard origin, or HTTP on loopback",
        );
      }
    }
    let issued = false;
    const create = async () => {
      const value = await client.createHumanInvitation(
        { apiKey: key },
        { email: options.email, name: options.name, role: options.role },
      );
      issued = true;
      return value;
    };
    const metadata = (value: Awaited<ReturnType<typeof create>>) => ({
      invitationId: value.id,
      accountId: value.accountId,
      workplaceId: value.workplaceId,
      role: value.role,
      expiresAt: value.expiresAt,
    });
    if (!path) return metadata(await create());
    const record = (value: Awaited<ReturnType<typeof create>>) => ({
      version: 1 as const,
      kind: "human-invitation" as const,
      origin,
      invitationId: value.id,
      workplaceId: value.workplaceId,
      accountId: value.accountId,
      code: value.code,
    });
    try {
      if (options.invitationLinkFile) {
        return await withPrivateTextFile(
          path,
          {
            label: "Human invitation link",
            maximumBytes: 8192,
            createOnly: true,
            validate(value) {
              if (typeof value !== "string") throw new Error("Invalid link");
              parseHumanInvitationLink(value, linkOptions);
              return value;
            },
          },
          async (store) => {
            if ((await store.read()) !== undefined)
              throw new CliConfigurationError(
                "Invitation file already exists; choose a new path",
              );
            const value = await create();
            await store.write(
              createHumanInvitationLink(record(value), linkOptions),
            );
            return { ...metadata(value), invitationLinkFile: resolve(path) };
          },
        );
      }
      return await withPrivateJsonFile(
        path,
        {
          label: "Human invitation",
          maximumBytes: 4096,
          validate: parseHumanInvitationFile,
          createOnly: true,
        },
        async (store) => {
          if ((await store.read()) !== undefined)
            throw new CliConfigurationError(
              "Invitation file already exists; choose a new path",
            );
          const value = await create();
          await store.write(record(value));
          return { ...metadata(value), invitationFile: resolve(path) };
        },
      );
    } catch (error) {
      if (issued)
        throw new CliConfigurationError(
          "Invitation creation and email delivery may already have succeeded, but saving the private file failed. Use invitations list to inspect the invitation; cancel it before issuing a replacement if needed.",
        );
      throw error;
    }
  });
}
export async function executeInvitationList(
  options: AccessCommandOptions,
  after?: string,
) {
  await executeSavedOperation(options, (client, key) =>
    client.listInvitations({ apiKey: key }, { after }),
  );
}
export async function executeInvitationCancel(
  options: AccessCommandOptions,
  invitationId: string,
) {
  await executeSavedOperation(options, (client, key) =>
    client.cancelInvitation({ apiKey: key }, invitationId),
  );
}
export async function executeInvitationPreview(
  options: AccessCommandOptions & { invitationFile: string },
) {
  separatePaths(options, options.invitationFile);
  const saved = await withInvitation(options.invitationFile, (store) =>
    store.read(),
  );
  if (!saved) throw new CliConfigurationError("Invitation file does not exist");
  if (
    options.baseUrl !== undefined &&
    accessOrigin(options.baseUrl) !== saved.origin
  )
    throw new CliConfigurationError("Invitation belongs to another API origin");
  output(
    await productClient(options, saved.origin).previewInvitation({
      invitationId: saved.invitationId,
      code: saved.code,
    }),
    options,
  );
}

export async function executeInvitationJoin(
  options: AccessCommandOptions & {
    invitationFile?: string;
    mailboxName?: string;
    mailboxDefault?: boolean;
  },
) {
  const paths = separatePaths(options, options.invitationFile);
  if (options.mailboxName !== undefined && options.mailboxDefault)
    throw new CliConfigurationError("Choose only one mailbox address option");
  const selected: MailboxAddressChoice | undefined =
    options.mailboxName !== undefined
      ? { kind: "exact", localPart: options.mailboxName.trim().toLowerCase() }
      : options.mailboxDefault
        ? { kind: "automatic" }
        : undefined;
  if (
    selected?.kind === "exact" &&
    (selected.localPart.length < 3 || selected.localPart.length > 48)
  )
    throw new CliConfigurationError(
      "Mailbox name must contain 3 to 48 characters",
    );
  const supplied = options.invitationFile
    ? await withInvitation(options.invitationFile, (store) => store.read())
    : undefined;
  if (options.invitationFile && !supplied)
    throw new CliConfigurationError("Invitation file does not exist");
  await withCredentials(paths.credentials, async (credentials) => {
    await withInvitationAttempt(paths.attempt, async (store) => {
      let account = await credentials.read();
      let attempt = await store.read();
      if (!attempt) {
        if (account)
          throw new CliConfigurationError(
            "Credential file already belongs to an account; choose a separate file",
          );
        if (!supplied)
          throw new CliConfigurationError(
            "Specify --invitation-file for the first admission",
          );
        attempt = {
          ...supplied,
          kind: "invitation-attempt",
          phase: "pending",
          handoffId: randomUUID(),
          recoveryProof: randomBytes(32).toString("base64url"),
          ...(selected ? { mailboxAddressChoice: selected } : {}),
        };
      }
      if (supplied && !sameIdentity(attempt, supplied))
        throw new CliConfigurationError(
          "Saved attempt belongs to another invitation",
        );
      if (
        options.baseUrl !== undefined &&
        accessOrigin(options.baseUrl) !== attempt.origin
      )
        throw new CliConfigurationError(
          "Saved invitation belongs to another API origin",
        );
      if (
        account &&
        (account.version !== 1 ||
          account.origin !== attempt.origin ||
          account.credential.accountId !== attempt.accountId ||
          account.credential.workplaceId !== attempt.workplaceId)
      )
        throw new CliConfigurationError(
          "Saved credential does not match this invitation attempt",
        );
      await store.write(attempt); // Private recovery is durable before the first request.
      const client = productClient(options, attempt.origin);
      let requestedMailboxChoiceApplied = !account || selected === undefined;
      if (!account) {
        if (attempt.phase !== "pending")
          throw new CliConfigurationError(
            "Completed admission credentials are missing; ask a workplace administrator for credential recovery",
          );
        let admitted: InvitationAdmission;
        const redeem = (
          pending: Extract<InvitationAttempt, { phase: "pending" }>,
        ) =>
          client.redeemAgentInvitation({
            invitationId: pending.invitationId,
            code: pending.code,
            handoffId: pending.handoffId,
            recoveryProof: pending.recoveryProof,
            mailboxAddressChoice: pending.mailboxAddressChoice,
          });
        const differentChoice =
          selected !== undefined &&
          JSON.stringify(selected) !==
            JSON.stringify(
              attempt.mailboxAddressChoice ?? { kind: "automatic" },
            );
        try {
          admitted = await redeem(attempt);
          // An uncertain earlier request may already have admitted its original
          // address. Preserve that outcome rather than discarding its proof.
          requestedMailboxChoiceApplied = !differentChoice;
        } catch (error) {
          if (
            !(error instanceof AgentWorkplaceError) ||
            !differentChoice ||
            !["address_unavailable", "invalid_mailbox_address"].includes(
              error.code ?? "",
            )
          )
            throw error;
          attempt = {
            ...attempt,
            handoffId: randomUUID(),
            recoveryProof: randomBytes(32).toString("base64url"),
            mailboxAddressChoice: selected,
          };
          await store.write(attempt);
          admitted = await redeem(attempt);
        }
        if (
          admitted.invitationId !== attempt.invitationId ||
          admitted.handoffId !== attempt.handoffId ||
          admitted.accountId !== attempt.accountId ||
          admitted.workplaceId !== attempt.workplaceId
        )
          throw new CliConfigurationError(
            "Admission identity does not match the private invitation",
          );
        account = {
          version: 1,
          kind: "account",
          origin: attempt.origin,
          credential: {
            accountId: admitted.accountId,
            workplaceId: admitted.workplaceId,
            key: admitted.credential.key,
          },
        };
        await credentials.write(account); // Durable account save precedes acknowledgement.
      }
      if (!account.credential)
        throw new CliConfigurationError(
          "Saved account credential is unavailable",
        );
      if (attempt.phase === "pending") {
        await client.acknowledgeInvitation(
          { apiKey: account.credential.key },
          { invitationId: attempt.invitationId, handoffId: attempt.handoffId },
        );
        await store.write(completedInvitationAttempt(attempt));
      }
      const status = await client.accountStatus({
        apiKey: account.credential.key,
      });
      if (
        status.accountId !== attempt.accountId ||
        status.workplaceId !== attempt.workplaceId
      )
        throw new CliConfigurationError(
          "Saved credential identity does not match the API response",
        );
      output({ ...status, requestedMailboxChoiceApplied }, options);
    });
  });
}
