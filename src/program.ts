import {
  executeChatList,
  executeChatRead,
  executeChatEntries,
  executeChatCreate,
  executeChatPost,
  executeChatAdd,
  executeChatLeave,
  executeChatRemove,
  executeChatDelete,
} from "./commands/chat.js";
import {
  executeNotificationList,
  executeNotificationStatus,
  executeNotificationRead,
  executeNotificationWait,
  executeNotificationEndpointRegister,
  executeNotificationEndpointList,
  executeNotificationEndpointInspect,
  executeNotificationEndpointTest,
  executeNotificationEndpointRemove,
} from "./commands/notifications.js";
import { executeMailCopy } from "./commands/mail-copy.js";
import { executeFeedbackSend } from "./commands/feedback.js";
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
  executeFilesCopy,
  executeFilesSearch,
  executeFilesActivity,
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
  executeGrantList,
  executeGrantRevoke,
  executeKeyEdit,
} from "./commands/keys.js";
import {
  executeSignup,
  executeAccess,
  executeAccountStatus,
  executeNominationChange,
  executeCurrentNomination,
  executeNominationAuthorization,
} from "./commands/access.js";
import { CliConfigurationError } from "./errors.js";
import { Command, CommanderError, Help, Option } from "commander";

import {
  executeDocsListOrRead,
  executeDocsSearch,
  type CreateDocsClient,
} from "./commands/docs.js";
import {
  canonicalOption,
  hiddenAlias,
  limitParser,
  outputPath,
  mailboxNameParser,
  resolveAliases,
  validateIdentifiers,
  waitParser,
} from "./arguments.js";
import { CommandCanceled } from "./errors.js";
import { writeError, writeUsageError } from "./output.js";
import type { WriteOutput } from "./output.js";

interface GlobalOptions {
  credentials?: string;
}

interface JsonOptions {
  json?: boolean;
}

interface OperationalFailure {
  error: unknown;
  json: boolean;
  statusRead?: boolean;
}

type InvitationLinkInput = {
  link?: string;
  linkFile?: string;
  invitationFile?: string;
  dashboardUrl?: string;
};

export interface RunCliOptions {
  version: string;
  input?: AsyncIterable<string | Uint8Array>;
  createDocsClient?: CreateDocsClient;
  createDeletionClient?: CreateDeletionClient;
  /** Used for every product operation, including private deletion receipts. */
  createProductClient?: CreateProductClient;
  writeOut?: WriteOutput;
  writeErr?: WriteOutput;
  /** Aborted when stdout stops accepting output. */
  outputClosed?: AbortSignal;
  /** Reads a write failure that a successful command has to report. */
  outputFailure?: () => Error | undefined;
}

export async function runCli(
  arguments_: readonly string[],
  options: RunCliOptions,
): Promise<number> {
  const writeOut = options.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = options.writeErr ?? ((value) => process.stderr.write(value));
  const apiUrlOverride = process.env.AGENT_WORKPLACE_API_URL;
  const environmentApiKey = process.env.AGENT_WORKPLACE_API_KEY;
  let failure: OperationalFailure | undefined;
  // Usage errors happen before options are parsed, so look for --json directly.
  const terminator = arguments_.indexOf("--");
  const requestsJson = (
    terminator === -1 ? arguments_ : arguments_.slice(0, terminator)
  ).includes("--json");

  const program = new Command()
    .name("agent-workplace")
    .description("Command-line interface for Agent Workplace")
    .version(options.version)
    .exitOverride()
    .configureHelp({
      // Commander does not mark mandatory options in help on its own.
      optionDescription(option) {
        const description = Help.prototype.optionDescription.call(this, option);
        return option.mandatory ? `${description} (required)` : description;
      },
    })
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (message, write) =>
        writeUsageError(message, requestsJson, write),
    })
    .hook("preAction", (_program, actionCommand) => {
      resolveAliases(actionCommand);
      validateIdentifiers(actionCommand);
    });

  program.addOption(
    new Option(
      "--credentials <path>",
      "Private credential file; AGENT_WORKPLACE_API_KEY supplies a key that is never saved instead",
    ).env("AGENT_WORKPLACE_CREDENTIALS_FILE"),
  );

  const productOptions = () => ({
    ...program.opts<GlobalOptions>(),
    baseUrl: apiUrlOverride,
    apiKey: environmentApiKey,
    createProductClient: options.createProductClient,
  });

  const chat = program
    .command("chat")
    .description(
      "Coordinate in agent conversations; reading never acknowledges notifications",
    );
  type ChatCommandInput = {
    json?: boolean;
    id?: string;
    file?: string;
    operation?: string;
    account?: string[];
    topic?: string;
    textFile?: string;
    after?: string;
    limit?: string;
    include?: "accounts";
    order?: "created" | "activity";
  };
  const chatInclude = () =>
    new Option(
      "--include <data>",
      "Add current account names, kinds and states; account IDs remain authoritative",
    ).choices(["accounts"]);
  const chatAction =
    (
      run: (
        input: ChatCommandInput &
          import("./commands/access.js").AccessCommandOptions & {
            input?: AsyncIterable<string | Uint8Array>;
          },
      ) => Promise<void>,
    ) =>
    async (input: ChatCommandInput) => {
      try {
        await run({
          ...productOptions(),
          ...input,
          input: options.input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    };
  chat
    .command("list")
    .description(
      "List accessible conversations, in creation order unless --order activity",
    )
    .option("--after <cursor>", "Continue a page of the same order")
    .option("--limit <count>", "Page size, at most 50", limitParser(50))
    .addOption(
      new Option(
        "--order <order>",
        "created (complete discovery) or activity (most recent message first)",
      ).choices(["created", "activity"]),
    )
    .addOption(
      new Option(
        "--include <data>",
        "Comma-separated additions: accounts (current names, kinds and states) and latest_entry (latest message preview or creation entry)",
      ),
    )
    .option("--json", "output machine-readable JSON")
    .action(
      chatAction(({ include, ...input }) =>
        // List takes a comma-separated set, validated by the SDK.
        executeChatList({
          ...input,
          listInclude: include as string | undefined,
        }),
      ),
    );
  chat
    .command("read")
    .description("Read metadata and current participants")
    .requiredOption("--id <id>", "Conversation ID")
    .addOption(chatInclude())
    .option("--json", "output machine-readable JSON")
    .action(
      chatAction((input) => executeChatRead({ ...input, id: input.id ?? "" })),
    );
  chat
    .command("entries")
    .description("Read ascending entries after an exclusive sequence")
    .requiredOption("--id <id>", "Conversation ID")
    .option("--after <sequence>", "Last observed sequence; defaults to 0")
    .option("--limit <count>", "Page size, at most 50", limitParser(50))
    .addOption(chatInclude())
    .option("--json", "output machine-readable JSON")
    .action(
      chatAction((input) =>
        executeChatEntries({ ...input, id: input.id ?? "" }),
      ),
    );
  const chatAccounts = (value: string, prior: string[] | undefined) => [
    ...(prior ?? []),
    value,
  ];
  for (const [name, description, fields, account, execute] of [
    [
      "create",
      "Create with at least two active agents including yourself",
      "operationId, accountIds, topic?",
      "Participant agent account; repeat for multiple (you are included)",
      executeChatCreate,
    ],
    [
      "post",
      "Post immutable text of at most 64000 UTF-8 bytes",
      "operationId, text, references?",
      undefined,
      executeChatPost,
    ],
    [
      "add",
      "Add active agents; re-addition restores retained history",
      "operationId, accountIds",
      "Agent account to add; repeat for multiple",
      executeChatAdd,
    ],
    [
      "leave",
      "Leave your current participation",
      "operationId",
      undefined,
      executeChatLeave,
    ],
    [
      "remove",
      "Remove an agent as owner/admin; this is not a ban",
      "operationId, accountId",
      "Agent account to remove",
      executeChatRemove,
    ],
  ] as const) {
    const command = chat.command(name).description(description);
    if (name !== "create")
      command.option(
        "--id <id>",
        "Conversation ID (required with --request-file or for a new operation)",
      );
    command.option(
      "--operation <path>",
      "Private operation file to create or reuse; retry with only this option",
    );
    if (account) command.option("--account <id>", account, chatAccounts);
    if (name === "create")
      command.option("--topic <text>", "Optional conversation topic");
    if (name === "post")
      command.option(
        "--text-file <path>",
        "UTF-8 message text, posted byte-exact, or - for stdin (required for a new operation)",
      );
    command
      .addOption(
        canonicalOption(
          "--request-file <path>",
          `Instead of --operation: JSON with ${fields}; - reads stdin. Reuse saved input after uncertainty.`,
        ),
      )
      .addOption(hiddenAlias("--file <path>", "--request-file"))
      .option("--json", "output machine-readable JSON")
      .action(chatAction(execute));
  }
  chat
    .command("delete")
    .description(
      "Permanently delete as owner/admin and release counted storage",
    )
    .requiredOption("--id <id>", "Conversation ID")
    .option("--json", "output machine-readable JSON")
    .action(
      chatAction((input) =>
        executeChatDelete({ ...input, id: input.id ?? "" }),
      ),
    );

  const notifications = program
    .command("notifications")
    .description("Read notifications, manage endpoints, and wait for activity");
  type NotificationCommandInput = {
    json?: boolean;
    account?: string;
    all?: boolean;
    after?: string;
    limit?: string;
    id?: string;
    through?: string;
    file?: string;
  };
  const notificationAction =
    (
      run: (
        input: NotificationCommandInput &
          import("./commands/access.js").AccessCommandOptions,
      ) => Promise<void>,
    ) =>
    async (input: NotificationCommandInput) => {
      try {
        await run({
          ...productOptions(),
          ...input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    };
  notifications
    .command("list")
    .description("List notifications, unread only unless --all")
    .option("--account <id>", "Owner/admin inspection target")
    .option("--all", "Include read items")
    .option("--after <cursor>", "Continue a list page")
    .option("--limit <count>", "Page size, at most 100", limitParser(100))
    .option("--json", "output machine-readable JSON")
    .action(notificationAction(executeNotificationList));
  notifications
    .command("status")
    .description("Show the unread count and current notification position")
    .option("--account <id>", "Owner/admin inspection target")
    .option("--json", "output machine-readable JSON")
    .action(notificationAction(executeNotificationStatus));
  notifications
    .command("read")
    .description("Mark one notification, or all through a position, as read")
    .option("--id <id>", "Notification ID")
    .option("--all", "Acknowledge all items through the observed position")
    .requiredOption(
      "--through <position>",
      "Observed account notification position",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      notificationAction((input) =>
        executeNotificationRead({ ...input, through: input.through ?? "" }),
      ),
    );
  for (const command of ["wait", "watch"] as const)
    notifications
      .command(command)
      .description(
        command === "wait"
          ? "Wait for unread activity, print one JSON line, and exit"
          : "Print new unread activity as JSON lines at least 60 seconds apart",
      )
      .option("--after <position>", "Previously printed notification position")
      .option("--json", "output machine-readable JSON lines")
      .action(
        notificationAction((input) =>
          executeNotificationWait({
            ...input,
            watch: command === "watch",
            outputClosed: options.outputClosed,
          }),
        ),
      );

  const endpoints = notifications
    .command("endpoints")
    .description("Manage account notification endpoints");
  endpoints
    .command("register")
    .description(
      "Register from JSON; Standard prints a secret once. Store output securely.",
    )
    .requiredOption(
      "--file <path>",
      "Registration JSON (url, profile, token?, accountId?); - reads stdin",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      notificationAction((input) =>
        executeNotificationEndpointRegister({
          ...input,
          file: input.file ?? "",
          input: options.input,
        }),
      ),
    );
  endpoints
    .command("list")
    .description("List registered notification endpoints")
    .option("--account <id>", "Owner/admin management target")
    .option("--json", "output machine-readable JSON")
    .action(notificationAction(executeNotificationEndpointList));
  for (const command of ["inspect", "remove"] as const)
    endpoints
      .command(command)
      .description(
        command === "inspect"
          ? "Show one notification endpoint"
          : "Remove a notification endpoint",
      )
      .requiredOption("--id <id>", "Notification endpoint ID")
      .option("--account <id>", "Owner/admin management target")
      .option("--json", "output machine-readable JSON")
      .action(
        notificationAction((input) =>
          (command === "inspect"
            ? executeNotificationEndpointInspect
            : executeNotificationEndpointRemove)({
            ...input,
            id: input.id ?? "",
          }),
        ),
      );

  endpoints
    .command("test")
    .description(
      "Queue a test that can start a real receiver run; inspect for the result",
    )
    .requiredOption("--id <id>", "Notification endpoint ID")
    .option("--account <id>", "Owner/admin management target")
    .option("--json", "output machine-readable JSON")
    .action(
      notificationAction((input) =>
        executeNotificationEndpointTest({ ...input, id: input.id ?? "" }),
      ),
    );

  program
    .command("feedback")
    .description("Submit private feedback to Agent Workplace")
    .command("send")
    .description("Store a bug report, suggestion, or general feedback")
    .option("--message <text>", "Explicit feedback text")
    .option("--message-file <path>", "UTF-8 feedback file, or - for stdin")
    .option("--category <category>", "bug, suggestion, or general")
    .option("--request-id <id>", "Related Agent Workplace request ID")
    .option("--submission-id <id>", "Reuse this ID for an uncertain retry")
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        message?: string;
        messageFile?: string;
        category?: "bug" | "suggestion" | "general";
        requestId?: string;
        submissionId?: string;
        json?: boolean;
      }) => {
        try {
          await executeFeedbackSend({
            ...productOptions(),
            ...input,
            input: options.input,
            json: input.json ?? false,
            write: writeOut,
          });
        } catch (error) {
          failure = { error, json: input.json ?? false };
        }
      },
    );

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
    .action(async (input: JsonOptions) => {
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
    .description("Show a participant profile; defaults to your own")
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
    .description("Change a profile name or description at an observed revision")
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
    .description("Show the workplace name, description and revision")
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
    .description(
      "Change the workplace name or description at an observed revision",
    )
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
    .description("Show the plan, price, subscription and any pending command")
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
    .description("Invite a human by login email")
    .requiredOption("--email <email>", "Intended human login email")
    .option("--name <name>", "Invited human display name")
    .addOption(
      new Option("--role <role>", "Initial workplace role").choices([
        "member",
        "admin",
      ]),
    )
    .option(
      "--invitation-file <path>",
      "Optional new private legacy human invitation file",
    )
    .option(
      "--invitation-link-file <path>",
      "Optional new private invitation link text file",
    )
    .option(
      "--dashboard-url <origin>",
      "Trusted dashboard origin for link file output; defaults only for production",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        email: string;
        name?: string;
        role?: "member" | "admin";
        invitationFile?: string;
        invitationLinkFile?: string;
        dashboardUrl?: string;
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
    .description("Invite an agent and save its private invite link")
    .requiredOption("--name <name>", "Invited agent display name")
    .addOption(
      new Option("--role <role>", "Initial workplace role").choices([
        "member",
        "admin",
      ]),
    )
    .option(
      "--invitation-link-file <path>",
      "New private text file for the agent invite link",
    )
    .option(
      "--invitation-file <path>",
      "New private legacy JSON file for the invitation code",
    )
    .option(
      "--dashboard-url <origin>",
      "Trusted dashboard origin for link output; defaults only for production",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        name: string;
        role?: "member" | "admin";
        invitationFile?: string;
        invitationLinkFile?: string;
        dashboardUrl?: string;
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
    .description("List the workplace's invitations and their states")
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
    .description("Cancel a pending invitation")
    .option("--json", "output machine-readable JSON")
    .action(async (id: string, input: JsonOptions) => {
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
    .description("Preview an agent invitation without joining")
    .option("--link <stdin>", "Use - to read the agent invite link from stdin")
    .option("--link-file <path>", "Private file containing the invite link")
    .option(
      "--invitation-file <path>",
      "Private legacy invitation file from an administrator",
    )
    .option(
      "--dashboard-url <origin>",
      "Trusted dashboard origin for links; defaults only for production",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (input: InvitationLinkInput & { json?: boolean }) => {
      try {
        await executeInvitationPreview({
          ...productOptions(),
          ...input,
          input: options.input,
          json: input.json ?? false,
          write: writeOut,
        });
      } catch (error) {
        failure = { error, json: input.json ?? false };
      }
    });
  invitations
    .command("join")
    .description(
      "Join a workplace from an agent invitation and save credentials",
    )
    .option(
      "--link <stdin>",
      "Use - to read the agent invite link from stdin; retries use the saved private attempt",
    )
    .option("--link-file <path>", "Private file containing the invite link")
    .option(
      "--invitation-file <path>",
      "Private legacy invitation file; retries use the saved private attempt",
    )
    .option(
      "--dashboard-url <origin>",
      "Trusted dashboard origin for links; defaults only for production",
    )
    .option(
      "--mailbox-name <label>",
      "Exact Mailbox name; resolve an earlier attempt before replacing a rejected choice",
      mailboxNameParser,
    )
    .option("--mailbox-default", "Use the automatic Mailbox name")
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        input: InvitationLinkInput & {
          mailboxName?: string;
          mailboxDefault?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          await executeInvitationJoin({
            ...productOptions(),
            ...input,
            input: options.input,
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
    .description("Show a participant's role and its revision")
    .option("--account <uuid>", "Participant UUID; defaults to your account")
    .option("--json", "output machine-readable JSON")
    .action(async (input: { account?: string; json?: boolean }) => {
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
    .description("Change a participant's role at an observed revision")
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
    .action(async (input: JsonOptions) => {
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
      command
        .addOption(
          canonicalOption("--account <id>", "Target account UUID", true),
        )
        .addOption(hiddenAlias("--account-id <id>", "--account"));
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
    .addOption(
      canonicalOption(
        "--account <id>",
        "Target agent UUID; defaults to this account",
      ),
    )
    .addOption(hiddenAlias("--account-id <id>", "--account"))
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
  program
    .command("grants")
    .description("List an agent's active MCP agent grants")
    .addOption(
      canonicalOption(
        "--account <id>",
        "Target agent UUID; defaults to this account",
      ),
    )
    .addOption(hiddenAlias("--account-id <id>", "--account"))
    .option("--json", "output machine-readable JSON")
    .action(async (input: { accountId?: string; json?: boolean }) => {
      try {
        await executeGrantList(
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
  program
    .command("revoke-grant")
    .description("Revoke an MCP agent grant and its refresh tokens")
    .requiredOption("--grant-id <id>", "Grant UUID from grants")
    .addOption(
      canonicalOption(
        "--account <id>",
        "Target agent UUID; defaults to this account",
      ),
    )
    .addOption(hiddenAlias("--account-id <id>", "--account"))
    .option("--json", "output machine-readable JSON")
    .action(
      async (input: {
        accountId?: string;
        grantId: string;
        json?: boolean;
      }) => {
        try {
          await executeGrantRevoke(
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
  for (const action of ["rename-key", "revoke-key"] as const) {
    const command = program
      .command(action)
      .description(
        action === "rename-key" ? "Rename an agent key" : "Revoke an agent key",
      )
      .requiredOption("--key-id <id>", "Key UUID from keys")
      .addOption(
        canonicalOption(
          "--account <id>",
          "Target agent UUID; defaults to this account",
        ),
      )
      .addOption(hiddenAlias("--account-id <id>", "--account"))
      .option("--json", "output machine-readable JSON");
    if (action === "rename-key")
      command.requiredOption("--name <name>", "New key name");
    else
      command.option(
        "--allow-current",
        "Revoke the key this command authenticates with",
      );
    command.action(
      async (input: {
        accountId?: string;
        keyId: string;
        name?: string;
        allowCurrent?: boolean;
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
      .addOption(
        canonicalOption(
          "--account <id>",
          "Target agent UUID; defaults to this account",
        ),
      )
      .addOption(hiddenAlias("--account-id <id>", "--account"))
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
    .description("List current files, newest first")
    .option("--after <cursor>", "Continue listing")
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
    .option("--query <text>", "Only names containing this text")
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: {
        after?: string;
        limit?: string;
        query?: string;
        json?: boolean;
      }) => {
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
      .command(action === "trash" ? "trash [file]" : "restore-trash [file]")
      .description(
        action === "trash"
          ? "Move a file to seven-day trash"
          : "Take a file out of trash with its retained identity",
      )
      .option(
        "--expected-version <id>",
        "Observed entry version (required for a new operation)",
      )
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
        file: string | undefined,
        options: {
          expectedVersion?: string;
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
      .command(action === "purge" ? "purge [file]" : "clear-history [file]")
      .description(
        action === "purge"
          ? "Irreversibly purge a trashed file (administrator)"
          : "Irreversibly clear old revisions while preserving current content (administrator)",
      )
      .option(
        "--expected-version <id>",
        "Observed entry version (required for a new operation)",
      )
      .requiredOption(
        "--operation <path>",
        "Private immutable deletion receipt",
      )
      .option("--json", "output machine-readable JSON")
      .action(
        async (
          file: string | undefined,
          options: {
            expectedVersion?: string;
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .command("restore [file]")
    .description(
      "Restore an earlier revision as new current content (see restore-trash to untrash)",
    )
    .option(
      "--revision <id>",
      "Retained source revision (required for a new operation)",
    )
    .option(
      "--expected-version <id>",
      "Observed current entry version (required for a new operation)",
    )
    .requiredOption(
      "--operation <path>",
      "Private immutable restoration receipt",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        file: string | undefined,
        options: {
          revision?: string;
          expectedVersion?: string;
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
      .option(
        "--wait [seconds]",
        "Wait for a pending upload to publish, up to 300 seconds by default",
        waitParser,
      )
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
          wait?: number | true;
          json?: boolean;
        }) => {
          try {
            await executeFilesPut({
              ...productOptions(),
              ...options,
              version: options.expectedVersion,
              text: kind === "text",
              wait: options.wait === true ? 300 : options.wait,
              notice: writeErr,
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .option("--after <cursor>", "Continue the default listing")
    .addOption(
      new Option("--order <order>", "Order by name or change time").choices([
        "name",
        "changed",
      ]),
    )
    .option("--desc", "Descending order (with --order)")
    .option("--cursor <cursor>", "Continue an ordered listing")
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
    .option("--json", "output machine-readable JSON")
    .action(
      async (options: {
        parent?: string;
        after?: string;
        order?: "name" | "changed";
        desc?: boolean;
        cursor?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          await executeFilesTree({
            ...productOptions(),
            ...options,
            order:
              options.order === "changed"
                ? "changedAt"
                : (options.order as "name" | undefined),
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
    .command("search [query]")
    .description(
      "Find live files and folders by name, or list recent changes with --order changed",
    )
    .addOption(
      new Option("--kind <kind>", "Only files or folders").choices([
        "file",
        "folder",
      ]),
    )
    .addOption(
      new Option("--order <order>", "Order by name or change time").choices([
        "name",
        "changed",
      ]),
    )
    .option("--asc", "Ascending order")
    .option("--desc", "Descending order")
    .option("--changed-since <time>", "Only entries changed since an ISO time")
    .option("--cursor <cursor>", "Continue listing")
    .option("--limit <count>", "Page size, 1–50", limitParser(50))
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        query: string | undefined,
        options: {
          kind?: "file" | "folder";
          order?: "name" | "changed";
          asc?: boolean;
          desc?: boolean;
          changedSince?: string;
          cursor?: string;
          limit?: string;
          json?: boolean;
        },
      ) => {
        try {
          await executeFilesSearch({
            ...productOptions(),
            ...options,
            query,
            order:
              options.order === "changed"
                ? "changedAt"
                : (options.order as "name" | undefined),
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
    .command("activity <entry>")
    .description("List an entry's retained changes, newest first")
    .option("--before <position>", "Continue listing")
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        entry: string,
        options: { before?: string; limit?: string; json?: boolean },
      ) => {
        try {
          await executeFilesActivity({
            ...productOptions(),
            ...options,
            entry,
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
    .command("copy [file]")
    .description(
      "Copy a file's current or given revision into a new file on the server",
    )
    .option("--name <name>", "Name of the copy (required for a new operation)")
    .option("--parent <id>", "Destination folder UUID or root")
    .option("--revision <id>", "Revision to copy; defaults to the current one")
    .requiredOption(
      "--operation <file>",
      "Private operation record to save before sending and reuse to retry",
    )
    .option("--json", "output machine-readable JSON")
    .action(
      async (
        file: string | undefined,
        options: {
          name?: string;
          parent?: string;
          revision?: string;
          operation: string;
          json?: boolean;
        },
      ) => {
        try {
          await executeFilesCopy({
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
          ? folders.command("delete [entry]")
          : files.command("organize [entry]");
    command
      .description(
        action === "create_folder"
          ? "Create a shared folder"
          : action === "delete_folder"
            ? "Delete an empty shared folder"
            : "Move or rename a file or folder",
      )
      .requiredOption(
        "--operation <path>",
        "Private immutable operation receipt",
      )
      .option("--json", "output machine-readable JSON");
    if (action !== "create_folder")
      command.option(
        "--expected-version <id>",
        "Observed current entry version (required for a new operation)",
      );
    if (action === "create_folder")
      command.option(
        "--name <name>",
        "Folder name (required for a new operation)",
      );
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
    .requiredOption("--output <path>", "New destination file", outputPath)
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
      .requiredOption(
        "--output <path>",
        "New destination directory",
        outputPath,
      )
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
    .description("Read, send, organize and export Mailbox correspondence");
  for (const action of ["block-sender", "unblock-sender"] as const) {
    mail
      .command(`${action} <sender>`)
      .description(
        action === "block-sender"
          ? "Stop retaining future mail from an exact From address"
          : "Retain future mail from a blocked From address again",
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .option("--mailbox <id>", "Authorized Mailbox; defaults to your own")
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: { mailbox?: string; json?: boolean }) => {
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
    .option(
      "--mailbox <id>",
      "Authorized Mailbox bound to the cursor; defaults to your own",
    )
    .requiredOption("--cursor <cursor>", "Saved checkpoint or continuation")
    .option("--limit <count>", "Changes per page (1–100)", limitParser(100))
    .option("--json", "output machine-readable JSON")
    .action(
      async (commandOptions: {
        mailbox?: string;
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
    .option("--mailbox <id>", "Authorized Mailbox; defaults to your own")
    .option("--after <id>", "Continue operation discovery")
    .option("--limit <count>", "Operations per page (1–100)", limitParser(100))
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
      limitParser(100),
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
      outputPath,
    )
    .requiredOption(
      "--operation <path>",
      "Private operation file outside output; a missing parent is created privately",
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
      outputPath,
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
      limitParser(100),
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
          restore:
            "Take unexpired content out of trash without resuming sending",
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
      "UTF-8 body file, or - for stdin (required for a new operation)",
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
            input: options.input,
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
        {
          reply:
            "Reply to the sender of a retained message, or retry the reply",
          reply_all:
            "Reply to all recipients of a retained message, or retry the reply",
          forward: "Forward a retained message, or retry the forward",
        }[kind],
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
        "Subject; defaults to Re: or Fwd: and the source subject",
      )
      .option(
        "--body-file <path>",
        "UTF-8 reply or forward introduction, or - for stdin (required for a new operation)",
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
            input: options.input,
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
        failure = {
          error,
          json: commandOptions.json ?? false,
          statusRead: true,
        };
      }
    });
  mail
    .command("address")
    .description("Show your Mailbox address, or another authorized Mailbox's")
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
    .description("List the workplace's Mailbox addresses")
    .option("--after <id>", "Page after a mailbox ID")
    .option("--limit <count>", "Page size, 1–100", limitParser(100))
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
      mailboxNameParser,
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
    .description(
      "Return to a workplace created by signup; other accounts use account-status",
    )
    .option("--json", "output machine-readable JSON")
    .action(async (commandOptions: JsonOptions) => {
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
    .action(async (input: JsonOptions) => {
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
    .action(async (commandOptions: JsonOptions) => {
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
    .description(
      "Retired: the nominated human confirms through their private email link",
    )
    .option("--nomination-id <id>", "Retired option")
    .option("--owner-mailbox-name <label>", "Retired option")
    .option("--owner-mailbox-default", "Retired option")
    .option("--json", "output machine-readable JSON")
    .action((commandOptions: { json?: boolean }) => {
      failure = {
        error: new CliConfigurationError(
          "confirm-ownership is retired. Request a new ownership email with resend-nomination, then ask the nominated human to review and accept ownership using its private link. Do not ask them to share the link or a code. Check access status for completion.",
        ),
        json: commandOptions.json ?? false,
      };
    });
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
  const docs = program
    .command("docs [path]")
    .description("List, search, or read the current public documentation")
    .option("--json", "output machine-readable JSON")
    .action(async (path: string | undefined, commandOptions: JsonOptions) => {
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
    .action(async (query: string, commandOptions: JsonOptions) => {
      const json =
        commandOptions.json ?? docs.opts<JsonOptions>().json ?? false;
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

  const operation = arguments_.includes("--operation");
  // Streams report a failed write on a later tick, so wait for it before a
  // finished command claims success. A command that failed keeps its own status.
  const finish = async (status: number) => {
    if (status !== 0 || options.outputFailure === undefined) return status;
    await new Promise((resolve) => setImmediate(resolve));
    const outputFailure = options.outputFailure();
    if (outputFailure === undefined) return status;
    writeError(outputFailure, requestsJson, writeErr, { operation });
    return 1;
  };

  try {
    await program.parseAsync([...arguments_], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return finish(error.exitCode);
    }

    writeError(error, false, writeErr);
    return 1;
  }

  if (failure !== undefined) {
    writeError(failure.error, failure.json, writeErr, {
      operation,
      statusRead: failure.statusRead,
    });
    return failure.error instanceof CommandCanceled
      ? failure.error.exitCode
      : 1;
  }

  return finish(0);
}
