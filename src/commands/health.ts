import { AgentWorkplace } from "@agent-workplace/sdk";
import type { HealthResponse } from "@agent-workplace/sdk";

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
  if (options.baseUrl === undefined) {
    throw new CliConfigurationError(
      "API base URL is required. Pass --base-url or set AGENT_WORKPLACE_API_URL.",
    );
  }

  const createClient = options.createClient ?? defaultCreateClient;
  let client: HealthClient;

  try {
    client = createClient(options.baseUrl);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CliConfigurationError(error.message, { cause: error });
    }

    throw error;
  }

  const result = await client.health();
  writeHealthResult(result, options.json, options.write);
}
