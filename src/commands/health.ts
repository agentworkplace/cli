import { AgentWorkplace } from "@agent-workplace/sdk";
import type { HealthResponse } from "@agent-workplace/sdk";

import { productionApiOrigin } from "../client.js";
import { CliConfigurationError } from "../errors.js";
import { writeHealthResult } from "../output.js";
import type { WriteOutput } from "../output.js";

export interface HealthClient {
  health(): Promise<HealthResponse>;
}

export type CreateHealthClient = (baseUrl: string) => HealthClient;

export interface ExecuteHealthOptions {
  baseUrl?: string;
  json: boolean;
  createClient?: CreateHealthClient;
  write: WriteOutput;
}

const defaultCreateClient: CreateHealthClient = (baseUrl) =>
  new AgentWorkplace({ baseUrl });

export async function executeHealth(
  options: ExecuteHealthOptions,
): Promise<void> {
  const baseUrl = options.baseUrl ?? productionApiOrigin;
  const createClient = options.createClient ?? defaultCreateClient;
  let client: HealthClient;

  try {
    client = createClient(baseUrl);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CliConfigurationError(error.message, { cause: error });
    }

    throw error;
  }

  const result = await client.health();
  writeHealthResult(result, options.json, options.write);
}
