import { CliConfigurationError } from "../errors.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";

export async function executeProfileRead(
  options: AccessCommandOptions & { account?: string },
) {
  await executeSavedOperation(options, (client, key, status) =>
    client.getProfile({ apiKey: key }, options.account ?? status.accountId),
  );
}
export async function executeProfileUpdate(
  options: AccessCommandOptions & {
    account?: string;
    revision: string;
    name?: string;
    description?: string;
    clearDescription?: boolean;
  },
) {
  if (options.clearDescription && options.description !== undefined)
    throw new CliConfigurationError(
      "Choose --description or --clear-description",
    );
  if (
    options.name === undefined &&
    options.description === undefined &&
    !options.clearDescription
  )
    throw new CliConfigurationError("Specify a name or description change");
  await executeSavedOperation(options, (client, key, status) =>
    client.updateProfile({ apiKey: key }, options.account ?? status.accountId, {
      expectedRevision: options.revision,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.clearDescription
        ? { description: null }
        : options.description === undefined
          ? {}
          : { description: options.description }),
    }),
  );
}
