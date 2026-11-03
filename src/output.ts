import { presentError } from "./errors.js";

export type WriteOutput = (value: string) => void;

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
  if (presented.scopes?.length)
    write(`Required scopes: ${presented.scopes.join(", ")}\n`);
  if (presented.retryAfterSeconds !== undefined)
    write(`Retry after ${presented.retryAfterSeconds} seconds\n`);
  if (presented.requestId) write(`Request ID: ${presented.requestId}\n`);
  if (presented.submissionId)
    write(`Retry with --submission-id ${presented.submissionId}\n`);
}

/**
 * Present a Commander usage error. With `--json` it is a JSON error like any
 * other failure, so scripts can parse every failure in one format.
 */
export function writeUsageError(
  message: string,
  json: boolean,
  write: WriteOutput,
): void {
  if (!json) {
    write(message);
    return;
  }
  const text = message.replace(/^error: /, "").trimEnd();
  write(`${JSON.stringify({ error: { message: text, code: "usage" } })}\n`);
}
