import { CliConfigurationError } from "../errors.js";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";

export async function executeWorkplaceRead(options: AccessCommandOptions) {
  await executeSavedOperation(options, (client, key) =>
    client.getWorkplaceSettings({ apiKey: key }),
  );
}
export async function executeWorkplaceUpdate(
  options: AccessCommandOptions & {
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
  await executeSavedOperation(options, (client, key) =>
    client.updateWorkplaceSettings(
      { apiKey: key },
      {
        expectedRevision: options.revision,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.clearDescription
          ? { description: null }
          : options.description === undefined
            ? {}
            : { description: options.description }),
      },
    ),
  );
}

export async function executeBillingStatus(options: AccessCommandOptions) {
  await executeSavedOperation(options, (client, key) =>
    client.getBillingStatus({ apiKey: key }),
  );
}

export async function executeBillingCommand(
  options: AccessCommandOptions & {
    action: "cancel" | "resume";
    commandId: string;
    revision: string;
  },
) {
  await executeSavedOperation(options, (client, key) =>
    client.requestBillingCommand(
      { apiKey: key },
      {
        id: options.commandId,
        expectedRevision: options.revision,
        action: options.action,
      },
    ),
  );
}
export async function executeBillingCommandRead(
  options: AccessCommandOptions & { commandId: string },
) {
  await executeSavedOperation(options, (client, key) =>
    client.getBillingCommand({ apiKey: key }, options.commandId),
  );
}

export async function executeBillingPurchase(
  options: AccessCommandOptions & { purchaseId: string; inspect?: boolean },
) {
  await executeSavedOperation(options, (client, key) =>
    options.inspect
      ? client.getBillingPurchase({ apiKey: key }, options.purchaseId)
      : client.requestBillingPurchase(
          { apiKey: key },
          { id: options.purchaseId },
        ),
  );
}

export async function executeBillingPayment(
  options: AccessCommandOptions & { purchaseId?: string },
) {
  await executeSavedOperation(options, (client, key) =>
    client.getBillingPaymentAction(
      { apiKey: key },
      options.purchaseId ? { purchaseId: options.purchaseId } : {},
    ),
  );
}

export async function executeBillingInvoices(
  options: AccessCommandOptions & { after?: string },
) {
  await executeSavedOperation(options, (client, key) =>
    client.listBillingInvoices(
      { apiKey: key },
      options.after ? { after: options.after } : {},
    ),
  );
}
export async function executeBillingInvoiceLink(
  options: AccessCommandOptions & { reference: string },
) {
  await executeSavedOperation(options, (client, key) =>
    client.getBillingInvoiceLink({ apiKey: key }, options.reference),
  );
}
