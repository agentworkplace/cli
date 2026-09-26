import { readPrivateReceipt } from "../private-receipt.js";
import { AgentWorkplace, type DeletionStatus } from "@agent-workplace/sdk";
import { productionApiOrigin } from "../client.js";
import { accessOrigin } from "../credentials.js";
import { CliConfigurationError } from "../errors.js";
import type { WriteOutput } from "../output.js";

export type CreateDeletionClient = (
  baseUrl: string,
) => Pick<AgentWorkplace, "workplaceDeletionStatus">;
const invalid = () =>
  new CliConfigurationError(
    "Expected a private deletion receipt for the selected API origin; set AGENT_WORKPLACE_API_URL for another environment",
  );
export async function executeDeletionStatus(options: {
  baseUrl?: string;
  receipt: string;
  input: AsyncIterable<string | Uint8Array>;
  json: boolean;
  write: WriteOutput;
  createClient?: CreateDeletionClient;
}) {
  const origin = accessOrigin(options.baseUrl ?? productionApiOrigin);
  const text = await readPrivateReceipt(
    options.receipt,
    options.input,
    invalid,
  );
  let proof: string;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !value ||
      value.version !== 1 ||
      value.apiOrigin !== origin ||
      typeof value.accountId !== "string" ||
      !uuid.test(value.accountId) ||
      typeof value.workplaceId !== "string" ||
      !uuid.test(value.workplaceId) ||
      typeof value.proof !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.proof) ||
      (value.challengeId !== undefined &&
        (typeof value.challengeId !== "string" ||
          !uuid.test(value.challengeId))) ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "apiOrigin",
            "accountId",
            "workplaceId",
            "proof",
            "challengeId",
          ].includes(key),
      )
    )
      throw invalid();
    proof = value.proof;
  } catch {
    throw invalid();
  }
  const client =
    options.createClient?.(origin) ?? new AgentWorkplace({ baseUrl: origin });
  const result: DeletionStatus = await client.workplaceDeletionStatus(proof);
  // Select only the status contract; never echo imported identities or proof.
  const output = {
    state: result.state,
    initiatedAt: result.initiatedAt,
    receiptExpiresAt: result.receiptExpiresAt,
  };
  options.write(
    options.json
      ? `${JSON.stringify(output)}\n`
      : `Deletion: ${output.state}\nInitiated: ${output.initiatedAt}\nReceipt expires: ${output.receiptExpiresAt}\n`,
  );
}
