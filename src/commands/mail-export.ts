import type { MailExportScope } from "@agent-workplace/sdk";
import { CliConfigurationError } from "../errors.js";
import { exportMailLocally } from "../mail-export.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";

export async function executeMailExport(
  options: AccessCommandOptions & {
    mailbox: string;
    scope: string;
    message?: string;
    output: string;
    operation: string;
  },
) {
  let scope: MailExportScope;
  if (options.scope === "mailbox" && !options.message)
    scope = { kind: "mailbox" };
  else if (
    (options.scope === "message" || options.scope === "thread") &&
    options.message
  )
    scope = { kind: options.scope, messageId: options.message.toLowerCase() };
  else
    throw new CliConfigurationError(
      "Choose --scope mailbox, or --scope message|thread with --message UUID",
    );
  let partial = false;
  await executeSavedOperation(options, async (client, key, status, origin) => {
    const result = await exportMailLocally(
      client,
      key,
      { origin, accountId: status.accountId, workplaceId: status.workplaceId },
      {
        mailboxId: options.mailbox,
        scope,
        output: options.output,
        operation: options.operation,
      },
    );
    partial = result.state === "partial";
    return result;
  });
  if (partial)
    throw new CliConfigurationError(
      "Mail export is partial; inspect its manifest. Retry the same operation to recover pinned content, or choose a new operation and destination to discover changes",
    );
}
