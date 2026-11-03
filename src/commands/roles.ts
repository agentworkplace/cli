import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
export async function executeRoleRead(
  options: AccessCommandOptions & { account?: string },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.getParticipantRole(
      { apiKey: key },
      options.account ?? status.accountId,
    ),
  );
}
export async function executeRoleUpdate(
  options: AccessCommandOptions & {
    account: string;
    revision: string;
    role: "admin" | "member";
  },
) {
  await executeSavedOperation(options, (client, key) =>
    client.updateParticipantRole({ apiKey: key }, options.account, {
      expectedRevision: options.revision,
      role: options.role,
    }),
  );
}
