import type { HealthResponse } from "@agent-workplace/sdk";

import { presentError } from "./errors.js";

export type WriteOutput = (value: string) => void;

export function writeHealthResult(
  result: HealthResponse,
  json: boolean,
  write: WriteOutput,
): void {
  write(json ? `${JSON.stringify(result)}\n` : `Status: ${result.status}\n`);
}

export function writeError(
  error: unknown,
  json: boolean,
  write: WriteOutput,
): void {
  const presented = presentError(error);

  if (json) {
    write(`${JSON.stringify({ error: presented })}\n`);
    return;
  }

  const details = [
    ...(presented.status === undefined ? [] : [`HTTP ${presented.status}`]),
    ...(presented.code === undefined ? [] : [`code: ${presented.code}`]),
  ];
  const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;

  write(`Error: ${presented.message}${suffix}\n`);
}
