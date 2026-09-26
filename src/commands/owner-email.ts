import { accessOrigin } from "../credentials.js";
import { CliConfigurationError } from "../errors.js";
import {
  productClient,
  productionApiOrigin,
  type ProductClientOptions,
} from "../client.js";
import type { WriteOutput } from "../output.js";
import { readPrivateReceipt } from "../private-receipt.js";

const invalid = () =>
  new CliConfigurationError(
    "Expected a private owner email receipt for the selected API origin; set AGENT_WORKPLACE_API_URL for another environment",
  );

export async function executeOwnerEmailStatus(
  options: ProductClientOptions & {
    baseUrl?: string;
    receipt: string;
    input: AsyncIterable<string | Uint8Array>;
    json: boolean;
    write: WriteOutput;
  },
) {
  const origin = accessOrigin(options.baseUrl ?? productionApiOrigin);
  const text = await readPrivateReceipt(
    options.receipt,
    options.input,
    invalid,
  );
  let proof: string;
  let operationId: string | undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !value ||
      value.version !== 1 ||
      value.kind !== "owner-email-change" ||
      value.apiOrigin !== origin ||
      typeof value.accountId !== "string" ||
      !uuid.test(value.accountId) ||
      typeof value.workplaceId !== "string" ||
      !uuid.test(value.workplaceId) ||
      typeof value.proof !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.proof) ||
      (value.operationId !== undefined &&
        (typeof value.operationId !== "string" ||
          !uuid.test(value.operationId))) ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "kind",
            "apiOrigin",
            "accountId",
            "workplaceId",
            "proof",
            "operationId",
          ].includes(key),
      )
    )
      throw invalid();
    proof = value.proof;
    operationId = value.operationId as string | undefined;
  } catch {
    throw invalid();
  }
  const result = await productClient(options, origin).ownerEmailChangeStatus(
    proof,
  );
  if (
    result.operation &&
    operationId &&
    result.operation.operationId !== operationId
  )
    throw new CliConfigurationError(
      "Owner email status does not match the saved operation",
    );
  const operation = result.operation;
  // Do not echo proof, account identities or transport data from imported input.
  const output = {
    operation: operation
      ? {
          operationId: operation.operationId,
          state: operation.state,
          generation: operation.generation,
          createdAt: operation.createdAt,
          expiresAt: operation.expiresAt,
          receiptExpiresAt: operation.receiptExpiresAt,
          finishedAt: operation.finishedAt,
        }
      : null,
  };
  options.write(
    options.json
      ? `${JSON.stringify(output)}\n`
      : operation
        ? `Owner email: ${operation.state}\nOperation expires: ${operation.expiresAt}\nReceipt expires: ${operation.receiptExpiresAt}\n`
        : "Owner email: unavailable. This does not mean the change never completed. Do not automatically start another operation.\n",
  );
}

/** A navigation handoff contains no receipt, identity or login credential. */
export function executeOwnerEmailHandoff(options: {
  dashboardUrl: string;
  json: boolean;
  write: WriteOutput;
}) {
  const url = `${accessOrigin(options.dashboardUrl)}/#owner-email`;
  options.write(
    options.json
      ? `${JSON.stringify({ url })}\n`
      : `Open ${url} and sign in as the workplace owner. Complete both mailbox proofs in the browser and save the private receipt for status recovery.\n`,
  );
}
