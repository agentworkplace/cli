import { executeMailCopy } from "./commands/mail-copy.js";
import { executeMailExport } from "./commands/mail-export.js";
import {
  executeOwnerEmailHandoff,
  executeOwnerEmailStatus,
} from "./commands/owner-email.js";
import {
  executeFilesList,
  executeFilesDeletion,
  executeFilesDeletionStatus,
  executeFilesTrashList,
  executeFilesTrash,
  executeFilesTrashStatus,
  executeFilesHistory,
  executeFilesRestore,
  executeFilesRestorationStatus,
  executeFilesTree,
  executeFilesCheckpoint,
  executeFilesChanges,
  executeFilesBaseline,
  executeFilesEntry,
  executeFilesOrganize,
  executeFilesPut,
  executeFilesGet,
  executeFilesExport,
  executeFilesStatus,
} from "./commands/files.js";
import { executeRoleRead, executeRoleUpdate } from "./commands/roles.js";
import {
  executeProfileRead,
  executeProfileUpdate,
} from "./commands/profiles.js";
import {
  executeBillingInvoices,
  executeBillingInvoiceLink,
  executeBillingStatus,
  executeBillingCommand,
  executeBillingCommandRead,
  executeBillingPurchase,
  executeBillingPayment,
  executeWorkplaceRead,
  executeWorkplaceUpdate,
} from "./commands/workplace.js";
import {
  executeInvitationCreate,
  executeHumanInvitationCreate,
  executeInvitationList,
  executeInvitationCancel,
  executeInvitationPreview,
  executeInvitationJoin,
} from "./commands/invitations.js";
import type { CreateProductClient } from "./client.js";
export type { CreateProductClient } from "./client.js";
import {
  executeMailContentChange,
  executeMailList,
  executeMailRead,
  executeMailOperation,
  executeMailCheckpoint,
  executeMailChanges,
  executeMailOperations,
  executeMailThread,
  executeMailAttachments,
  executeMailDownload,
  executeMailOmissions,
  executeMailPreparations,
  executeMailSenderBlock,
  executeMailSenderBlocks,
  executeMailAddress,
  executeMailboxList,
  executeMailSend,
  executeMailCompose,
  executeMailOperationStatus,
} from "./commands/mail.js";
import {
  executeDeletionStatus,
  type CreateDeletionClient,
} from "./commands/deletion.js";
import {
  executeKeyRotation,
  executeKeyIssue,
  executeParticipantList,
  executeParticipantRemoval,
  executeKeyList,
  executeKeyEdit,
} from "./commands/keys.js";
import {
  executeSignup,
  executeAccess,
  executeAccountStatus,
  executeNominationChange,
  executeCurrentNomination,
  executeNominationAuthorization,
  executeOwnershipConfirmation,
  readOwnershipCode,
} from "./commands/access.js";
import { CliConfigurationError } from "./errors.js";
import { Command, CommanderError, Option } from "commander";

import { executeHealth } from "./commands/health.js";
import type { CreateHealthClient } from "./commands/health.js";
import {
  executeDocsListOrRead,
  executeDocsSearch,
  type CreateDocsClient,
} from "./commands/docs.js";
import { writeError } from "./output.js";
import type { WriteOutput } from "./output.js";

interface GlobalOptions {
  credentials?: string;
}

interface HealthOptions {
  json?: boolean;
}

interface OperationalFailure {
  error: unknown;
  json: boolean;
}

export interface RunCliOptions {
  version: string;
  input?: AsyncIterable<string | Uint8Array>;
  createClient?: CreateHealthClient;
  createDocsClient?: CreateDocsClient;
  createDeletionClient?: CreateDeletionClient;
  /** Used for every product operation, including private deletion receipts. */
  createProductClient?: CreateProductClient;
  writeOut?: WriteOutput;
  writeErr?: WriteOutput;
}

export async function runCli(
  arguments_: readonly string[],
  options: RunCliOptions,
): Promise<number> {
  const writeOut = options.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = options.writeErr ?? ((value) => process.stderr.write(value));
  const apiUrlOverride = process.env.AGENT_WORKPLACE_API_URL;
  let failure: OperationalFailure | undefined;

  const program = new Command()
    .name("agent-workplace")
    .description("Command-line interface for Agent Workplace")
    .version(options.version)
    .exitOverride()
    .configureOutput({ writeOut, writeErr });

  program.addOption(
    new Option("--credentials <path>", "Private credential file").env(
      "AGENT_WORKPLACE_CREDENTIALS_FILE",
    ),
  );

  const productOptions = () => ({
    ...program.opts<GlobalOptions>(),
    baseUrl: apiUrlOverride,
    createProductClient: options.createProductClient,
  });

  program
    .command("owner-email-handoff")
    .description("Show the owner browser flow without exporting credentials")
    .requiredOption("--dashboard-url <url>", "Trusted dashboard origin")
    .option("--json", "output machine-readable JSON")
    .action((input: { dashboardUrl: string; json?: boolean }) => {
      try {
        executeOwnerEmailHandoff({
          dashboardUrl: input.dashboardUrl,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });

  program
    .command("owner-email-status")
    .description(
      "Read private owner login-email status without session cookies",
    )
    .requiredOption(
      "--receipt <path>",
      "Private receipt file, or - for standard input",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (input: { receipt: string; json?: boolean }) => {
      try {
        await executeOwnerEmailStatus({
          baseUrl: apiUrlOverride,
          createProductClient: options.createProductClient,
          receipt: input.receipt,
          input: options.input ?? process.stdin,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });

  program
    .command("deletion-status")
    .description("Read private deletion status without workplace credentials")
    .requiredOption(
      "--receipt <path>",
      "Private receipt file, or - for standard input",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (input: { receipt: string; json?: boolean }) => {
      try {
        if (options.createProductClient && options.createDeletionClient)
          throw new CliConfigurationError(
            "Choose either createProductClient or createDeletionClient for deletion status",
          );
        await executeDeletionStatus({
          baseUrl: apiUrlOverride,
          receipt: input.receipt,
          input: options.input ?? process.stdin,
          json: input.json ?? false,
          write: writeOut,
          createClient:
            options.createProductClient ?? options.createDeletionClient,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });

  program
    .command("account-status")
    .description("Read current account access without a signup attempt")
    .option("--json", "output machine-readable JSON")
    .action(async (input: HealthOptions) => {
      try {
        await executeAccountStatus({
          ...productOptions(),
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });

  const profile = program
    .command("profile")
    .description("Read and edit workplace participant profiles");
  profile
    .command("show")
    .option("--account <id>", "Participant UUID; defaults to your account")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { account?: string; json?: boolean }) => {
      try {
        await executeProfileRead({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  profile
    .command("update")
    .requiredOption("--revision <uuid>", "Revision returned by profile show")
    .option("--account <id>", "Participant UUID; defaults to your account")
    .option("--name <name>", "New display name")
    .option("--description <text>", "New plain-text description")
    .option("--clear-description", "Remove the description")
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        revision: string;
        account?: string;
        name?: string;
        description?: string;
        clearDescription?: boolean;
        json?: boolean;
      }) => {
        try {
          await executeProfileUpdate({
            ...productOptions(),
            ...input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );
  const workplace = program
    .command("workplace")
    .description("Read and edit your workplace settings");
  workplace
    .command("show")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { json?: boolean }) => {
      try {
        await executeWorkplaceRead({
          ...productOptions(),
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  workplace
    .command("update")
    .requiredOption("--revision <uuid>", "Revision returned by workplace show")
    .option("--name <name>", "New workplace name")
    .option("--description <text>", "New plain-text description")
    .option("--clear-description", "Remove the description")
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        revision: string;
        name?: string;
        description?: string;
        clearDescription?: boolean;
        json?: boolean;
      }) => {
        try {
          await executeWorkplaceUpdate({
            ...productOptions(),
            ...input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );

  const billing = workplace
    .command("billing")
    .description("Inspect and manage workplace billing");
  billing
    .command("upgrade")
    .description(
      "Request Pro at $20/month plus applicable tax; reuse the purchase ID after uncertain responses",
    )
    .requiredOption("--purchase-id <uuid>", "Stable purchase request identity")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { purchaseId: string; json?: boolean }) => {
      try {
        await executeBillingPurchase({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  billing
    .command("purchase <purchaseId>")
    .description("Inspect purchase progress")
    .option("--json", "output machine-readable JSON")
    .action(async (purchaseId: string, input: { json?: boolean }) => {
      try {
        await executeBillingPurchase({
          ...productOptions(),
          purchaseId,
          inspect: true,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  billing
    .command("payment")
    .description(
      "Get a sensitive hosted payment/recovery link; share privately with the authorized payer",
    )
    .option(
      "--purchase-id <uuid>",
      "Purchase to continue; omit for current subscription recovery",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (input: { purchaseId?: string; json?: boolean }) => {
      try {
        await executeBillingPayment({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  billing
    .command("invoices")
    .description("List a page of workplace invoice summaries")
    .option(
      "--after <reference>",
      "Next-page reference from the preceding result",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (input: { after?: string; json?: boolean }) => {
      try {
        await executeBillingInvoices({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  billing
    .command("invoice-link <reference>")
    .description(
      "Get a sensitive paid/void invoice link; share privately and do not log it",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (reference: string, input: { json?: boolean }) => {
      try {
        await executeBillingInvoiceLink({
          ...productOptions(),
          reference,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  billing
    .command("status")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { json?: boolean }) => {
      try {
        await executeBillingStatus({
          ...productOptions(),
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });

  for (const action of ["cancel", "resume"] as const) {
    billing
      .command(action)
      .description(
        action === "cancel"
          ? "Request cancellation; paid access continues to its boundary"
          : "Undo scheduled cancellation without starting a new allowance period",
      )
      .requiredOption(
        "--command-id <uuid>",
        "Stable request identity; reuse it after an uncertain response",
      )
      .requiredOption(
        "--revision <uuid>",
        "Subscription revision from billing status",
      )
      .option("--json", "output machine-readable JSON")
      .action(
        async (input: {
          commandId: string;
          revision: string;
          json?: boolean;
        }) => {
          try {
            await executeBillingCommand({
              ...productOptions(),
              ...input,
              action,
              json: input.json ?? false,
              write: writeOut,
            });
          } catch (error) {
            failure = { error, json: input.json ?? false };
          }
        },
      );
  }
  billing
    .command("command <commandId>")
    .description("Inspect a pending or completed billing command")
    .option("--json", "output machine-readable JSON")
    .action(async (commandId: string, input: { json?: boolean }) => {
      try {
        await executeBillingCommandRead({
          ...productOptions(),
          commandId,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });

  const invitations = program
    .command("invitations")
    .description("Invite participants and privately join a workplace");
  invitations
    .command("create-human")
    .requiredOption("--email <email>", "Intended human login email")
    .option("--name <name>", "Invited human display name")
    .addOption(
      new Option("--role <role>", "Initial workplace role").choices([
        "member",
        "admin",
      ]),
    )
    .requiredOption(
      "--invitation-file <path>",
      "New private file for the human invitation",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        email: string;
        name?: string;
        role?: "member" | "admin";
        invitationFile: string;
        json?: boolean;
      }) => {
        try {
          await executeHumanInvitationCreate({
            ...productOptions(),
            ...input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );
  invitations
    .command("create")
    .requiredOption("--name <name>", "Invited agent display name")
    .addOption(
      new Option("--role <role>", "Initial workplace role").choices([
        "member",
        "admin",
      ]),
    )
    .requiredOption(
      "--invitation-file <path>",
      "New private file for the invitation code",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        name: string;
        role?: "member" | "admin";
        invitationFile: string;
        json?: boolean;
      }) => {
        try {
          await executeInvitationCreate({
            ...productOptions(),
            ...input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );
  invitations
    .command("list")
    .option("--after <id>", "Continue after this invitation UUID")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { after?: string; json?: boolean }) => {
      try {
        await executeInvitationList(
          { ...productOptions(), json: input.json ?? false, write: writeOut },
          input.after,
        );
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  invitations
    .command("cancel <invitationId>")
    .option("--json", "output machine-readable JSON")
    .action(async (id: string, input: HealthOptions) => {
      try {
        await executeInvitationCancel(
          { ...productOptions(), json: input.json ?? false, write: writeOut },
          id,
        );
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  invitations
    .command("preview")
    .requiredOption(
      "--invitation-file <path>",
      "Private invitation received from an administrator",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (input: { invitationFile: string; json?: boolean }) => {
      try {
        await executeInvitationPreview({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  invitations
    .command("join")
    .option(
      "--invitation-file <path>",
      "Required for the first admission; retries use the saved private attempt",
    )
    .option(
      "--mailbox-name <label>",
      "Exact Mailbox name; resolve an earlier attempt before replacing a rejected choice",
    )
    .option("--mailbox-default", "Use the automatic Mailbox name")
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        invitationFile?: string;
        mailboxName?: string;
        mailboxDefault?: boolean;
        json?: boolean;
      }) => {
        try {
          await executeInvitationJoin({
            ...productOptions(),
            ...input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );

  const roles = program
    .command("role")
    .description("Read or change participant roles");
  roles
    .command("show")
    .requiredOption("--account <uuid>", "Target participant UUID")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { account: string; json?: boolean }) => {
      try {
        await executeRoleRead({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  roles
    .command("update")
    .requiredOption("--account <uuid>", "Target participant UUID")
    .requiredOption("--revision <uuid>", "Observed role revision")
    .addOption(
      new Option("--role <role>", "New role")
        .choices(["admin", "member"])
        .makeOptionMandatory(),
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        account: string;
        revision: string;
        role: "admin" | "member";
        json?: boolean;
      }) => {
        try {
          await executeRoleUpdate({
            ...productOptions(),
            ...input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );
  program
    .command("accounts")
    .description("List workplace participants")
    .option("--json", "output machine-readable JSON")
    .action(async (input: HealthOptions) => {
      try {
        await executeParticipantList({
          ...productOptions(),
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  for (const action of ["leave", "remove-account"] as const) {
    const command = program
      .command(action)
      .description(
        action === "leave"
          ? "Leave the workplace and revoke all your access"
          : "Remove a non-owner and revoke all their access",
      )
      .option("--json", "output machine-readable JSON");
    if (action === "remove-account")
      command.requiredOption("--account-id <id>", "Target account UUID");
    command.action(async (input: { accountId?: string; json?: boolean }) => {
      try {
        await executeParticipantRemoval(
          {
            ...productOptions(),
            json: input.json ?? false,
            write: writeOut,
          },
          input.accountId,
        );
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  }
  program
    .command("keys")
    .description("List safe agent key metadata")
    .option("--account-id <id>", "Target agent UUID; defaults to this account")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { accountId?: string; json?: boolean }) => {
      try {
        await executeKeyList(
          {
            ...productOptions(),
            json: input.json ?? false,
            write: writeOut,
          },
          input.accountId,
        );
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  for (const action of ["rename-key", "revoke-key"] as const) {
    const command = program
      .command(action)
      .description(
        action === "rename-key" ? "Rename an agent key" : "Revoke an agent key",
      )
      .requiredOption("--key-id <id>", "Key UUID from keys")
      .option(
        "--account-id <id>",
        "Target agent UUID; defaults to this account",
      )
      .option("--json", "output machine-readable JSON");
    if (action === "rename-key")
      command.requiredOption("--name <name>", "New key name");
    command.action(
      async (input: {
        accountId?: string;
        keyId: string;
        name?: string;
        json?: boolean;
      }) => {
        try {
          await executeKeyEdit(
            {
              ...productOptions(),
              json: input.json ?? false,
              write: writeOut,
            },
            input,
          );
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );
  }

  for (const action of ["create-key", "recover-keys"] as const) {
    program
      .command(action)
      .description(
        action === "create-key"
          ? "Create a named key and save it privately"
          : "Revoke all target keys and save one replacement",
      )
      .requiredOption("--name <name>", "Key name")
      .requiredOption(
        "--save-to <path>",
        "Explicit private credential destination",
      )
      .option(
        "--account-id <id>",
        "Target agent UUID; defaults to this account",
      )
      .option("--json", "output machine-readable JSON")
      .action(
        async (input: {
          name: string;
          saveTo: string;
          accountId?: string;
          json?: boolean;
        }) => {
          try {
            await executeKeyIssue(
              {
                ...productOptions(),
                ...input,
                json: input.json ?? false,
                write: writeOut,
              },
              action === "recover-keys",
            );
          } catch (error) {
            failure = { error, json: input.json ?? false };
          }
        },
      );
  }
  program
    .command("rotate-key")
    .description(
      "Save a replacement credential before revoking the current key",
    )
    .requiredOption("--name <name>", "Name for the replacement key")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: { name: string; json?: boolean }) => {
      try {
        await executeKeyRotation({
          ...productOptions(),
          name: commandOptions.name,
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  const files = program
    .command("files")
    .description("Publish, read and update shared Files");
  files
    .command("list")
    .option("--after <cursor>", "Continue listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: { after?: string; limit?: string; json?: boolean }) => {
        try {
          await executeFilesList({
            ...productOptions(),
            ...options,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  files
    .command("trashed")
    .description("List recoverable trashed files")
    .option("--after <cursor>", "Continue listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: { after?: string; limit?: string; json?: boolean }) => {
        try {
          await executeFilesTrashList({
            ...productOptions(),
            ...options,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  for (const action of ["trash", "restore"] as const) {
    const command = files
      .command(action === "trash" ? "trash <file>" : "restore-trash <file>")
      .description(
        action === "trash"
          ? "Move a file to seven-day trash"
          : "Restore a trashed file with its retained identity",
      )
      .requiredOption("--expected-version <id>", "Observed entry version")
      .requiredOption(
        "--operation <path>",
        "Private immutable trash/restore receipt",
      )
      .option("--json", "output machine-readable JSON");
    if (action === "restore")
      command
        .option("--parent <id>", "Explicit folder or root (requires --name)")
        .option("--name <name>", "Explicit restored name (requires --parent)");
    command.action(
      async (
        file: string,
        options: {
          expectedVersion: string;
          operation: string;
          parent?: string;
          name?: string;
          json?: boolean;
        },
      ) => {
        try {
          await executeFilesTrash({
            ...productOptions(),
            ...options,
            action,
            file,
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  }
  files
    .command("trash-status")
    .description("Read a saved trash/restore outcome")
    .requiredOption("--operation <path>", "Private trash/restore receipt")
    .option("--json", "output machine-readable JSON")
    .action(async (options: { operation: string; json?: boolean }) => {
      try {
        await executeFilesTrashStatus({
          ...productOptions(),
          ...options,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    });
  for (const action of ["purge", "clear_history"] as const) {
    files
      .command(action === "purge" ? "purge <file>" : "clear-history <file>")
      .description(
        action === "purge"
          ? "Irreversibly purge a trashed file (administrator)"
          : "Irreversibly clear old revisions while preserving current content (administrator)",
      )
      .requiredOption("--expected-version <id>", "Observed entry version")
      .requiredOption(
        "--operation <path>",
        "Private immutable deletion receipt",
      )
      .option("--json", "output machine-readable JSON")
      .action(
        async (
          file: string,
          options: {
            expectedVersion: string;
            operation: string;
            json?: boolean;
          },
        ) => {
          try {
            await executeFilesDeletion({
              ...productOptions(),
              ...options,
              action,
              file,
              json: options.json ?? false,
              write: writeOut,
            });
          } catch (error) {
            failure = { error, json: options.json ?? false };
          }
        },
      );
  }
  files
    .command("deletion-status")
    .description(
      "Read saved administrative deletion progress; physical cleanup is independent",
    )
    .requiredOption("--operation <path>", "Private deletion receipt")
    .option("--json", "output machine-readable JSON")
    .action(async (options: { operation: string; json?: boolean }) => {
      try {
        await executeFilesDeletionStatus({
          ...productOptions(),
          ...options,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    });
  files
    .command("history <file>")
    .description("List retained revisions and expiry")
    .option("--after <cursor>", "Continue history")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        file: string,
        options: { after?: string; limit?: string; json?: boolean },
      ) => {
        try {
          await executeFilesHistory({
            ...productOptions(),
            ...options,
            file,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  files
    .command("restore <file>")
    .description("Restore a retained revision as new current content")
    .requiredOption("--revision <id>", "Retained source revision")
    .requiredOption("--expected-version <id>", "Observed current entry version")
    .requiredOption(
      "--operation <path>",
      "Private immutable restoration receipt",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        file: string,
        options: {
          revision: string;
          expectedVersion: string;
          operation: string;
          json?: boolean;
        },
      ) => {
        try {
          await executeFilesRestore({
            ...productOptions(),
            ...options,
            file,
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  files
    .command("restore-status")
    .description("Read a saved restoration outcome")
    .requiredOption("--operation <path>", "Private restoration receipt")
    .option("--json", "output machine-readable JSON")
    .action(async (options: { operation: string; json?: boolean }) => {
      try {
        await executeFilesRestorationStatus({
          ...productOptions(),
          ...options,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    });
  for (const kind of ["put", "text"] as const)
    files
      .command(kind)
      .description(
        kind === "text"
          ? "Publish UTF-8 text up to 1 MiB"
          : "Publish a file up to 2,000,000,000 bytes",
      )
      .requiredOption(
        "--source-file <path>",
        "Local regular file containing the bytes",
      )
      .requiredOption(
        "--operation <path>",
        "Private durable upload request file",
      )
      .option("--name <name>", "Create a new file under this name")
      .option("--parent <id>", "Destination folder UUID or root for a new file")
      .option("--file <id>", "Update this existing file")
      .option(
        "--expected-version <id>",
        "Expected current version for an update",
      )
      .option("--content-type <type>", "Media type of the bytes")
      .option("--json", "output machine-readable JSON")
      .action(
        async (options: {
          sourceFile: string;
          operation: string;
          name?: string;
          parent?: string;
          file?: string;
          expectedVersion?: string;
          contentType?: string;
          json?: boolean;
        }) => {
          try {
            await executeFilesPut({
              ...productOptions(),
              ...options,
              version: options.expectedVersion,
              text: kind === "text",
              json: options.json ?? false,
              write: writeOut,
            });
          } catch (error) {
            failure = { error, json: options.json ?? false };
          }
        },
      );
  files
    .command("checkpoint")
    .description("Capture a checkpoint before a Files baseline")
    .option("--json", "output machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        await executeFilesCheckpoint({
          ...productOptions(),
          ...options,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    });
  files
    .command("changes")
    .description("Read Files changes or a baseline-required gap")
    .requiredOption("--cursor <cursor>", "Saved checkpoint or next-page cursor")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: { json?: boolean; cursor: string; limit?: string }) => {
        try {
          await executeFilesChanges({
            ...productOptions(),
            ...options,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  files
    .command("baseline")
    .description("List retained Files and folders without a snapshot")
    .option("--after <cursor>", "Continue the baseline listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: { json?: boolean; after?: string; limit?: string }) => {
        try {
          await executeFilesBaseline({
            ...productOptions(),
            ...options,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  files
    .command("tree")
    .description("List files and folders within a parent")
    .option("--parent <id>", "Folder UUID or root")
    .option("--after <cursor>", "Continue listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: {
        parent?: string;
        after?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          await executeFilesTree({
            ...productOptions(),
            ...options,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  files
    .command("entry <id>")
    .description("Read current entry metadata and version")
    .option("--json", "output machine-readable JSON")
    .action(async (entry: string, options: { json?: boolean }) => {
      try {
        await executeFilesEntry({
          ...productOptions(),
          entry,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    });
  const folders = files
    .command("folders")
    .description("Create or delete empty shared folders");
  for (const action of [
    "create_folder",
    "organize",
    "delete_folder",
  ] as const) {
    const command =
      action === "create_folder"
        ? folders.command("create")
        : action === "delete_folder"
          ? folders.command("delete <entry>")
          : files.command("organize <entry>");
    command
      .requiredOption(
        "--operation <path>",
        "Private immutable operation receipt",
      )
      .option("--json", "output machine-readable JSON");
    if (action !== "create_folder")
      command.requiredOption(
        "--expected-version <id>",
        "Observed current entry version",
      );
    if (action === "create_folder")
      command.requiredOption("--name <name>", "Folder name");
    else if (action === "organize") command.option("--name <name>", "New name");
    if (action !== "delete_folder")
      command.option("--parent <id>", "Destination folder UUID or root");
    const run = async (
      entry: string | undefined,
      options: {
        operation: string;
        expectedVersion?: string;
        name?: string;
        parent?: string;
        json?: boolean;
      },
    ) => {
      try {
        await executeFilesOrganize({
          ...productOptions(),
          ...options,
          action,
          entry,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    };
    if (action === "create_folder")
      command.action((options) => run(undefined, options));
    else command.action((entry, options) => run(entry, options));
  }
  files
    .command("get <reference>")
    .description("Save verified file bytes without overwriting a local file")
    .requiredOption("--output <path>", "New destination file")
    .option(
      "--operation <path>",
      "Private receipt for interrupted download recovery",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        reference: string,
        options: { output: string; operation?: string; json?: boolean },
      ) => {
        try {
          await executeFilesGet({
            ...productOptions(),
            ...options,
            reference,
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  for (const mode of ["current", "retained"] as const) {
    const command = files
      .command(mode === "current" ? "get-folder <folder>" : "export")
      .description(
        mode === "current"
          ? "Download the active current folder tree (UUID or root), with a partial-result manifest"
          : "Export all retained workplace Files, including history and trash metadata",
      )
      .requiredOption("--output <path>", "New destination directory")
      .requiredOption(
        "--operation <path>",
        "Private export receipt outside the destination",
      )
      .option("--json", "output machine-readable JSON");
    const run = async (
      folder: string | undefined,
      options: { output: string; operation: string; json?: boolean },
    ) => {
      try {
        await executeFilesExport({
          ...productOptions(),
          ...options,
          folder,
          mode,
          json: options.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: options.json ?? false };
      }
    };
    if (mode === "current")
      command.action((folder, options) => run(folder, options));
    else command.action((options) => run(undefined, options));
  }
  for (const command of ["status", "cancel", "finalize", "parts"] as const)
    files
      .command(`${command} <upload>`)
      .description(
        command === "status"
          ? "Read the current upload outcome"
          : command === "parts"
            ? "Inspect uploaded part presence; final integrity verification is still required"
            : command === "finalize"
              ? "Explicitly finalize an upload using current access"
              : "Cancel an upload and schedule cleanup",
      )
      .option("--json", "output machine-readable JSON")
      .action(async (upload: string, options: { json?: boolean }) => {
        try {
          await executeFilesStatus({
            ...productOptions(),
            upload,
            cancel: command === "cancel",
            finalize: command === "finalize",
            parts: command === "parts",
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      });
  const mail = program
    .command("mail")
    .description(
      "Discover mailboxes and send explicitly requested plain-text mail",
    );
  for (const action of ["block-sender", "unblock-sender"] as const) {
    mail
      .command(`${action} <sender>`)
      .description(
        "Set an exact From-address rule for future Mailbox retention",
      )
      .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
      .option("--json", "output machine-readable JSON")
      .action(
        async (
          sender: string,
          options: { mailbox?: string; json?: boolean },
        ) => {
          try {
            await executeMailSenderBlock({
              ...productOptions(),
              ...options,
              sender,
              blocked: action === "block-sender",
              json: options.json ?? false,
              write: writeOut,
            });
          } catch (error) {
            failure = { error, json: options.json ?? false };
          }
        },
      );
  }
  mail
    .command("blocked-senders")
    .description("List current exact-address sender blocks")
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--after <cursor>", "Continue this live listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: {
        mailbox?: string;
        after?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailSenderBlocks({
            ...productOptions(),
            ...options,
            limit:
              options.limit === undefined ? undefined : Number(options.limit),
            json: options.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: options.json ?? false };
        }
      },
    );
  mail
    .command("list")
    .description(
      "List current retained correspondence; restart listing for newer or restored messages",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--after <cursor>", "Continue this listing")
    .option("--limit <count>", "Page size, 1–100")
    .addOption(
      new Option("--view <view>", "Correspondence view").choices([
        "active",
        "archive",
        "all",
        "trash",
      ]),
    )
    .addOption(
      new Option("--direction <direction>", "Filter message direction").choices(
        ["incoming", "outgoing"],
      ),
    )
    .option("--subject <text>", "Case-insensitive literal subject substring")
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox?: string;
        after?: string;
        limit?: string;
        view?: "active" | "archive" | "all" | "trash";
        direction?: "incoming" | "outgoing";
        subject?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailList({
            ...productOptions(),
            ...commandOptions,
            limit:
              commandOptions.limit === undefined
                ? undefined
                : Number(commandOptions.limit),
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("read <messageId>")
    .description(
      "Read one retained message; HTML is returned as text and never rendered",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        messageId: string,
        commandOptions: { mailbox?: string; json?: boolean },
      ) => {
        try {
          await executeMailRead({
            ...productOptions(),
            ...commandOptions,
            messageId,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("operation <operationId>")
    .description(
      "Read current authorized send status by ID without a local receipt",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (operationId: string, commandOptions: { json?: boolean }) => {
      try {
        await executeMailOperation({
          ...productOptions(),
          operationId,
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  mail
    .command("checkpoint")
    .description(
      "Capture an independent Mail checkpoint before baseline discovery",
    )
    .requiredOption("--mailbox <id>", "Authorized Mailbox")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: { mailbox: string; json?: boolean }) => {
      try {
        await executeMailCheckpoint({
          ...productOptions(),
          ...commandOptions,
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  mail
    .command("changes")
    .description("Read one bounded change page; a gap requires a new baseline")
    .requiredOption("--mailbox <id>", "Authorized Mailbox bound to the cursor")
    .requiredOption("--cursor <cursor>", "Saved checkpoint or continuation")
    .option("--limit <count>", "Changes per page (1–100)", (value) =>
      Number(value),
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox: string;
        cursor: string;
        limit?: number;
        json?: boolean;
      }) => {
        try {
          await executeMailChanges({
            ...productOptions(),
            ...commandOptions,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("operations")
    .description(
      "List retained operation identities, including sends with purged content",
    )
    .requiredOption("--mailbox <id>", "Authorized Mailbox")
    .option("--after <id>", "Continue operation discovery")
    .option("--limit <count>", "Operations per page (1–100)", (value) =>
      Number(value),
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox: string;
        after?: string;
        limit?: number;
        json?: boolean;
      }) => {
        try {
          await executeMailOperations({
            ...productOptions(),
            ...commandOptions,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("thread <messageId>")
    .description(
      "Discover historical thread hints; repeat indexing, follow empty-page cursors, restart on conflict",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--after <cursor>", "Continue candidate traversal")
    .option(
      "--limit <count>",
      "Candidates inspected per page (1–100)",
      (value) => Number(value),
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        messageId: string,
        commandOptions: {
          mailbox?: string;
          after?: string;
          limit?: number;
          json?: boolean;
        },
      ) => {
        try {
          await executeMailThread({
            ...productOptions(),
            ...commandOptions,
            messageId,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("copy")
    .description(
      "Copy one retained attachment into workplace Files, or recover its saved operation",
    )
    .requiredOption(
      "--operation <path>",
      "Private durable copy intent; reuse for recovery",
    )
    .option("--message <id>", "Source message for a new copy")
    .option("--attachment <id>", "Source attachment for a new copy")
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--name <name>", "Explicit name for a new workplace file")
    .option("--parent <id>", "New file parent, or root")
    .option("--file <id>", "Existing destination file")
    .option(
      "--expected-version <id>",
      "Required current version for existing file",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        operation: string;
        message?: string;
        attachment?: string;
        mailbox?: string;
        name?: string;
        parent?: string;
        file?: string;
        expectedVersion?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailCopy({
            ...productOptions(),
            ...commandOptions,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("export")
    .description(
      "Export retained Mail and verified attachments with private recovery state",
    )
    .requiredOption("--mailbox <id>", "Authorized Mailbox UUID")
    .requiredOption("--scope <kind>", "message, thread or mailbox")
    .option("--message <id>", "Seed message UUID for message or thread scope")
    .requiredOption(
      "--output <path>",
      "New output directory; existing parent required",
    )
    .requiredOption(
      "--operation <path>",
      "Private operation file outside output; existing private parent required",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox: string;
        scope: string;
        message?: string;
        output: string;
        operation: string;
        json?: boolean;
      }) => {
        try {
          await executeMailExport({
            ...productOptions(),
            ...commandOptions,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("download <messageId> <attachmentId>")
    .description(
      "Download and verify one retained attachment without overwriting existing files",
    )
    .requiredOption(
      "--output <path>",
      "New destination filename; existing parent directory required",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        messageId: string,
        attachmentId: string,
        commandOptions: { output: string; mailbox?: string; json?: boolean },
      ) => {
        try {
          await executeMailDownload({
            ...productOptions(),
            ...commandOptions,
            messageId,
            attachmentId,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("attachments <messageId>")
    .description(
      "List attachment retention states; restart pagination to observe changes",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option(
      "--after <ordinal>",
      "Continue after this attachment ordinal",
      (value) => Number(value),
    )
    .option(
      "--limit <count>",
      "Candidates inspected per page (1–100)",
      (value) => Number(value),
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        messageId: string,
        commandOptions: {
          mailbox?: string;
          after?: number;
          limit?: number;
          json?: boolean;
        },
      ) => {
        try {
          await executeMailAttachments({
            ...productOptions(),
            ...commandOptions,
            messageId,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  for (const action of [
    "trash",
    "restore",
    "purge",
    "archive",
    "unarchive",
  ] as const) {
    mail
      .command(`${action} <messageId>`)
      .description(
        {
          archive: "Archive retained content without stopping sending",
          unarchive: "Return archived content to the active view",
          trash: "Trash content and stop further sending submissions",
          restore: "Restore unexpired content without resuming sending",
          purge:
            "Permanently remove trashed content (owner/admin only); no provider recall",
        }[action],
      )
      .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
      .option("--json", "output machine-readable JSON")
      .action(
        async (
          messageId: string,
          commandOptions: { mailbox?: string; json?: boolean },
        ) => {
          try {
            await executeMailContentChange({
              ...productOptions(),
              ...commandOptions,
              messageId,
              action,
              json: commandOptions.json ?? false,
              write: writeOut,
            });
          } catch (error) {
            failure = { error, json: commandOptions.json ?? false };
          }
        },
      );
  }
  mail
    .command("omissions")
    .description(
      "List seven-day terminal omission history; missing history is not proof no mail arrived",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--after <cursor>", "Continue this listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox?: string;
        after?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailOmissions({
            ...productOptions(),
            ...commandOptions,
            limit:
              commandOptions.limit === undefined
                ? undefined
                : Number(commandOptions.limit),
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("preparations")
    .description(
      "Discover pending arrivals without retained content; restart to find changes",
    )
    .option("--mailbox <id>", "Explicitly select an authorized Mailbox")
    .option("--after <cursor>", "Continue this listing")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox?: string;
        after?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailPreparations({
            ...productOptions(),
            ...commandOptions,
            limit:
              commandOptions.limit === undefined
                ? undefined
                : Number(commandOptions.limit),
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  mail
    .command("send")
    .description(
      "Send or retry an explicitly requested email using a private immutable operation file",
    )
    .requiredOption(
      "--operation <path>",
      "Private operation file to create or reuse",
    )
    .option(
      "--to <email>",
      "Requested To recipient; repeat for multiple (required for a new operation)",
      (value: string, prior: string[] | undefined) => [...(prior ?? []), value],
    )
    .option(
      "--cc <email>",
      "Visible copy recipient; repeat for multiple",
      (value: string, prior: string[] | undefined) => [...(prior ?? []), value],
    )
    .option(
      "--bcc <email>",
      "Hidden recipient; repeat for multiple",
      (value: string, prior: string[] | undefined) => [...(prior ?? []), value],
    )
    .option(
      "--subject <text>",
      "Requested subject (required for a new operation)",
    )
    .option(
      "--body-file <path>",
      "UTF-8 body file (required for a new operation)",
    )
    .option(
      "--attachments-file <path>",
      "Ordered JSON array of immutable Files/Mail attachment sources (at most 16 KiB)",
    )
    .option("--mailbox <id>", "Explicitly select an authorized mailbox")
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        operation: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        bodyFile?: string;
        attachmentsFile?: string;
        mailbox?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailSend({
            ...productOptions(),
            ...commandOptions,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  for (const kind of ["reply", "reply_all", "forward"] as const) {
    const command = mail
      .command(kind.replace("_", "-"))
      .description(
        "Compose or retry retained plain-text correspondence using a private immutable receipt",
      )
      .requiredOption(
        "--operation <path>",
        "Private operation file to create or reuse",
      )
      .option(
        "--message <id>",
        "Source message in the selected mailbox (required for a new operation)",
      )
      .option(
        "--subject <text>",
        "Explicit subject (required for a new operation)",
      )
      .option(
        "--body-file <path>",
        "UTF-8 reply or forward introduction (required for a new operation)",
      )
      .option(
        "--attachments-file <path>",
        "Ordered JSON array of immutable Files/Mail attachment sources (at most 16 KiB)",
      )
      .option("--mailbox <id>", "Explicitly select an authorized mailbox")
      .option("--json", "output machine-readable JSON");
    if (kind === "forward")
      for (const group of ["to", "cc", "bcc"])
        command.option(
          `--${group} <email>`,
          `Forward ${group} recipient; repeat for multiple`,
          (value: string, prior: string[] | undefined) => [
            ...(prior ?? []),
            value,
          ],
        );
    command.action(
      async (commandOptions: {
        operation: string;
        message?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        bodyFile?: string;
        attachmentsFile?: string;
        mailbox?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailCompose({
            ...productOptions(),
            ...commandOptions,
            kind,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  }
  mail
    .command("status")
    .description("Read a saved send operation without submitting mail")
    .requiredOption("--operation <path>", "Existing private operation file")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: { operation: string; json?: boolean }) => {
      try {
        await executeMailOperationStatus({
          ...productOptions(),
          ...commandOptions,
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  mail
    .command("address")
    .option("--mailbox <id>", "Read a specific authorized mailbox")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: { mailbox?: string; json?: boolean }) => {
      try {
        await executeMailAddress({
          ...productOptions(),
          ...commandOptions,
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  mail
    .command("mailboxes")
    .option("--after <id>", "Page after a mailbox ID")
    .option("--limit <count>", "Page size, 1–100")
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        after?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          await executeMailboxList({
            ...productOptions(),
            ...commandOptions,
            limit:
              commandOptions.limit === undefined
                ? undefined
                : Number(commandOptions.limit),
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  program
    .command("signup")
    .description(
      "Create or resume an agent workplace and securely save credentials",
    )
    .requiredOption(
      "--name <name>",
      "Agent display name; does not select the mailbox address",
    )
    .requiredOption("--owner-email <email>", "Nominated human email")
    .option(
      "--mailbox-name <label>",
      "Optional permanent exact mailbox name; otherwise allocate a readable default",
    )
    .option(
      "--mailbox-default",
      "Select an automatic mailbox address after a conflict or expiry",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        name: string;
        ownerEmail: string;
        mailboxName?: string;
        mailboxDefault?: boolean;
        json?: boolean;
      }) => {
        try {
          await executeSignup({
            ...productOptions(),
            ...commandOptions,
            json: commandOptions.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  program
    .command("status")
    .description("Return to the saved workplace")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: HealthOptions) => {
      try {
        await executeAccess({
          ...productOptions(),
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  program
    .command("nomination")
    .description("Read the current ownership nomination as an administrator")
    .option("--json", "output machine-readable JSON")
    .action(async (input: HealthOptions) => {
      try {
        await executeCurrentNomination({
          ...productOptions(),
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  program
    .command("authorize-nomination")
    .description(
      "Authorize a fresh ownership nomination and invalidate previous confirmation codes",
    )
    .requiredOption("--owner-email <email>", "Intended human owner email")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { ownerEmail: string; json?: boolean }) => {
      try {
        await executeNominationAuthorization(
          { ...productOptions(), json: input.json ?? false, write: writeOut },
          input.ownerEmail,
        );
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  program
    .command("resend-nomination")
    .description("Send or resend the pending ownership nomination")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: HealthOptions) => {
      try {
        await executeAccess(
          {
            ...productOptions(),
            json: commandOptions.json ?? false,
            write: writeOut,
          },
          true,
        );
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });

  program
    .command("confirm-ownership")
    .option(
      "--owner-mailbox-name <label>",
      "Owner-requested exact mailbox name",
    )
    .option(
      "--owner-mailbox-default",
      "Use the automatic owner mailbox address",
    )
    .description(
      "Submit the human's ownership code; does not create a human login session",
    )
    .requiredOption(
      "--nomination-id <id>",
      "Nomination ID from authenticated status",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        nominationId: string;
        json?: boolean;
        ownerMailboxName?: string;
        ownerMailboxDefault?: boolean;
      }) => {
        try {
          if (!options.input && process.stdin.isTTY)
            throw new CliConfigurationError(
              "Supply the ownership code through standard input",
            );
          if (
            commandOptions.ownerMailboxName !== undefined &&
            commandOptions.ownerMailboxDefault
          )
            throw new CliConfigurationError(
              "Choose only one owner mailbox address option",
            );
          const code = await readOwnershipCode(options.input ?? process.stdin);
          await executeOwnershipConfirmation(
            {
              ...productOptions(),
              json: commandOptions.json ?? false,
              write: writeOut,
            },
            {
              nominationId: commandOptions.nominationId,
              code,
              ownerMailboxAddressChoice:
                commandOptions.ownerMailboxName !== undefined
                  ? {
                      kind: "exact",
                      localPart: commandOptions.ownerMailboxName,
                    }
                  : commandOptions.ownerMailboxDefault
                    ? { kind: "automatic" }
                    : undefined,
            },
          );
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  program
    .command("correct-nomination")
    .description(
      "Replace the named pending nomination with a corrected human email",
    )
    .requiredOption(
      "--nomination-id <id>",
      "Nomination ID from authenticated status",
    )
    .requiredOption("--owner-email <email>", "Corrected human email")
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        nominationId: string;
        ownerEmail: string;
        mailboxName?: string;
        mailboxDefault?: boolean;
        json?: boolean;
      }) => {
        try {
          await executeNominationChange(
            {
              ...productOptions(),
              json: commandOptions.json ?? false,
              write: writeOut,
            },
            {
              nominationId: commandOptions.nominationId,
              nominatedEmail: commandOptions.ownerEmail,
            },
          );
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  program
    .command("cancel-nomination")
    .description(
      "Cancel the named pending nomination without deleting the workplace",
    )
    .requiredOption(
      "--nomination-id <id>",
      "Nomination ID from authenticated status",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        nominationId: string;
        json?: boolean;
        ownerMailboxName?: string;
        ownerMailboxDefault?: boolean;
      }) => {
        try {
          await executeNominationChange(
            {
              ...productOptions(),
              json: commandOptions.json ?? false,
              write: writeOut,
            },
            {
              nominationId: commandOptions.nominationId,
            },
          );
        } catch (error) {
          failure = { error, json: commandOptions.json ?? false };
        }
      },
    );
  program
    .command("health")
    .description("Check the Agent Workplace API health")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: HealthOptions) => {
      try {
        await executeHealth({
          baseUrl: apiUrlOverride,
          json: commandOptions.json ?? false,
          createClient: options.createClient,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });

  const docs = program
    .command("docs [path]")
    .description("List, search, or read the current public documentation")
    .option("--json", "output machine-readable JSON")
    .action(async (path: string | undefined, commandOptions: HealthOptions) => {
      try {
        await executeDocsListOrRead(path, {
          createClient: options.createDocsClient,
          json: commandOptions.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: commandOptions.json ?? false };
      }
    });
  docs
    .command("search <query>")
    .description("Find documentation pages")
    .option("--json", "output machine-readable JSON")
    .action(async (query: string, commandOptions: HealthOptions) => {
      const json =
        commandOptions.json ?? docs.opts<HealthOptions>().json ?? false;
      try {
        await executeDocsSearch(query, {
          createClient: options.createDocsClient,
          json,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json };
      }
    });

  try {
    await program.parseAsync([...arguments_], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    writeError(error, false, writeErr);
    return 1;
  }

  if (failure !== undefined) {
    writeError(failure.error, failure.json, writeErr);
    return 1;
  }

  return 0;
}
