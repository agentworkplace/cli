import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AgentWorkplaceError,
  parseHumanInvitationFile,
  createHumanInvitationLink,
  parseHumanInvitationLink,
  createAgentInvitationLink,
  parseAgentInvitationLink,
  type InvitationAdmission,
  type MailboxAddressChoice,
} from "@agent-workplace/sdk";
import {
  accessOrigin,
  credentialFilePath,
  requireCredentialFile,
  withCredentials,
} from "../credentials.js";
import {
  productClient,
  productionApiOrigin,
  productionDashboardOrigin,
} from "../client.js";
import { CliConfigurationError } from "../errors.js";
import {
  completedInvitationAttempt,
  withInvitation,
  withInvitationAttempt,
  type InvitationAttempt,
  type SavedInvitation,
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
const maximumLinkBytes = 8192;
/** The production dashboard is implied only by the production API. */
function dashboardOriginFor(apiOrigin: string, dashboardUrl?: string) {
  if (dashboardUrl === undefined) {
    if (apiOrigin === productionApiOrigin) return productionDashboardOrigin;
    throw new CliConfigurationError(
      "Specify --dashboard-url for invitation links outside production",
    );
  }
  try {
    return accessOrigin(dashboardUrl);
  } catch {
    throw new CliConfigurationError(
      "Specify a canonical HTTPS dashboard origin, or HTTP on loopback",
    );
  }
}
const linkText = {
  label: "Invitation link",
  maximumBytes: maximumLinkBytes,
  validate(value: unknown) {
    if (typeof value !== "string") throw new Error("Invalid link");
    return value;
  },
};
async function readStandardInput(input?: AsyncIterable<string | Uint8Array>) {
  if (!input && process.stdin.isTTY)
    throw new CliConfigurationError(
      "Pipe the invitation link on standard input",
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input ?? process.stdin) {
    const next = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += next.byteLength;
    if (length > maximumLinkBytes)
      throw new CliConfigurationError("Invalid agent invitation link");
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString("utf8");
}
type InvitationInput = {
  invitationFile?: string;
  link?: string;
  linkFile?: string;
  dashboardUrl?: string;
  input?: AsyncIterable<string | Uint8Array>;
};
/** Links never choose the destination: both origins come from configuration. */
async function suppliedInvitation(
  options: AccessCommandOptions & InvitationInput,
): Promise<SavedInvitation | undefined> {
  const sources = [
    options.invitationFile,
    options.link,
    options.linkFile,
  ].filter((value) => value !== undefined);
  if (sources.length > 1)
    throw new CliConfigurationError(
      "Choose only one of --link, --link-file or --invitation-file",
    );
  if (options.link === undefined && options.linkFile === undefined) {
    if (options.dashboardUrl !== undefined)
      throw new CliConfigurationError(
        "--dashboard-url is used only with --link or --link-file",
      );
    if (options.invitationFile === undefined) return undefined;
    const saved = await withInvitation(options.invitationFile, (store) =>
      store.read(),
    );
    if (!saved)
      throw new CliConfigurationError("Invitation file does not exist");
    return saved;
  }
  // Never echo this value: anything passed here may be a bearer link.
  if (options.link !== undefined && options.link !== "-")
    throw new CliConfigurationError(
      "Pass the invitation link on standard input with --link -, or use --link-file",
    );
  const apiOrigin = accessOrigin(options.baseUrl ?? productionApiOrigin);
  const dashboardOrigin = dashboardOriginFor(apiOrigin, options.dashboardUrl);
  let value: string | undefined;
  if (options.linkFile !== undefined) {
    value = await withPrivateTextFile(options.linkFile, linkText, (store) =>
      store.read(),
    );
    if (value === undefined)
      throw new CliConfigurationError("Invitation link file does not exist");
  } else value = await readStandardInput(options.input);
  try {
    return parseAgentInvitationLink(value.trim(), {
      dashboardOrigin,
      apiOrigin,
    });
  } catch {
    throw new CliConfigurationError(
      "Invalid agent invitation link for this API and dashboard",
    );
  }
}
export async function executeInvitationCreate(
  options: AccessCommandOptions & {
    invitationFile?: string;
    invitationLinkFile?: string;
    dashboardUrl?: string;
    name: string;
    role?: "admin" | "member";
  },
) {
  const path = options.invitationLinkFile ?? options.invitationFile;
  if (!path || (options.invitationFile && options.invitationLinkFile))
    throw new CliConfigurationError(
      "Specify exactly one of --invitation-link-file or --invitation-file",
    );
  if (options.dashboardUrl !== undefined && !options.invitationLinkFile)
    throw new CliConfigurationError(
      "--dashboard-url is used only with --invitation-link-file",
    );
  separatePaths(options, path);
  await executeSavedOperation(options, async (client, key, _status, origin) => {
    const linkOptions = {
      dashboardOrigin: options.invitationLinkFile
        ? dashboardOriginFor(origin, options.dashboardUrl)
        : "",
      apiOrigin: origin,
    };
    let issued = false;
    const create = async () => {
      const value = await client.createAgentInvitation(
        { apiKey: key },
        { name: options.name, role: options.role },
      );
      issued = true;
      return value;
    };
    const record = (value: Awaited<ReturnType<typeof create>>) => ({
      version: 1 as const,
      kind: "invitation" as const,
      origin,
      invitationId: value.id,
      workplaceId: value.workplaceId,
      accountId: value.accountId,
      code: value.code,
    });
    const metadata = (value: Awaited<ReturnType<typeof create>>) => ({
      invitationId: value.id,
      accountId: value.accountId,
      workplaceId: value.workplaceId,
      role: value.role,
      expiresAt: value.expiresAt,
    });
    try {
      if (options.invitationLinkFile)
        return await withPrivateTextFile(
          path,
          {
            ...linkText,
            createOnly: true,
            validate(value) {
              if (typeof value !== "string") throw new Error("Invalid link");
              parseAgentInvitationLink(value, linkOptions);
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
              createAgentInvitationLink(record(value), linkOptions),
            );
            return { ...metadata(value), invitationLinkFile: resolve(path) };
          },
        );
      return await withInvitation(path, async (store) => {
        if (await store.read())
          throw new CliConfigurationError(
            "Invitation file already exists; choose a new path",
          );
        const value = await create();
        await store.write(record(value));
        return { ...metadata(value), invitationFile: resolve(path) };
      });
    } catch (error) {
      if (issued)
        throw new CliConfigurationError(
          "Invitation creation may already have succeeded, but saving the private file failed. Use invitations list to inspect the invitation; cancel it before issuing a replacement if needed.",
        );
      throw error;
    }
  });
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
  options: AccessCommandOptions & InvitationInput,
) {
  separatePaths(options, options.invitationFile ?? options.linkFile);
  const saved = await suppliedInvitation(options);
  if (!saved)
    throw new CliConfigurationError(
      "Specify --link -, --link-file or --invitation-file",
    );
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
  options: AccessCommandOptions &
    InvitationInput & {
      mailboxName?: string;
      mailboxDefault?: boolean;
    },
) {
  requireCredentialFile(options);
  const paths = separatePaths(
    options,
    options.invitationFile ?? options.linkFile,
  );
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
  const supplied = await suppliedInvitation(options);
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
            "Specify --link -, --link-file or --invitation-file for the first admission",
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
