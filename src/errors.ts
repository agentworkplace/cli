import {
  AgentWorkplaceError,
  AgentWorkplaceInputError,
  AgentWorkplaceNetworkError,
  DocumentationError,
} from "@agent-workplace/sdk";
import { OperationNotCompletedError } from "./outcomes.js";

/** A failure this CLI found itself, before or instead of an API response. */
export class CliConfigurationError extends Error {
  readonly code: string;

  constructor(message: string, options?: ErrorOptions & { code?: string }) {
    super(message, options);
    this.name = "CliConfigurationError";
    this.code = options?.code ?? "cli_error";
  }
}

/** Stopped by SIGINT or SIGTERM, with the conventional exit code for each. */
export class CommandCanceled extends CliConfigurationError {
  constructor(
    message: string,
    readonly exitCode: 130 | 143,
  ) {
    super(message, { code: "canceled" });
  }
}

/** The message for a retry whose inputs differ from its saved operation. */
export function changedOperationMessage(
  label: string,
  retry = "retry with its original inputs",
) {
  return `${label} operation file holds a different request; ${retry}, or use a new --operation path for a new request`;
}

export class FeedbackCommandError extends Error {
  constructor(
    readonly submissionId: string,
    readonly original: unknown,
  ) {
    super("Feedback submission failed");
    this.name = "FeedbackCommandError";
  }
}

export interface PresentedError {
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  scopes?: string[];
  submissionId?: string;
  state?: string;
  hint?: string;
}

export interface PresentationContext {
  /** The command saved its request in an operation file. */
  operation?: boolean;
}

const localFailures = new Map([
  ["EACCES", "Permission denied"],
  ["EEXIST", "Path already exists"],
  ["EISDIR", "Path is a directory"],
  ["ENOENT", "No such file or directory"],
  ["ENOSPC", "No space left on the device"],
  ["ENOTDIR", "A parent of the path is not a directory"],
  ["EPERM", "Permission denied"],
  ["EROFS", "Read-only file system"],
]);

/** The next step after a refused request, from its status and code alone. */
function nextStep(
  error: AgentWorkplaceError,
  { operation }: PresentationContext,
) {
  const again = operation ? ", then use a new --operation path" : "";
  if (error.status === 401)
    return "The key is invalid or revoked; check --credentials, or ask an administrator to recover this account's keys";
  if (error.code === "not_found")
    return `Check the ID, and that this account can reach it${again}`;
  if (error.code === "conflict")
    return `It changed since you read it; read it again${again}`;
  if (operation && error.status >= 400 && error.status < 500)
    return error.status === 408 || error.status === 429
      ? undefined
      : "The request was refused; correct it, then use a new --operation path";
  return undefined;
}

export function presentError(
  error: unknown,
  context: PresentationContext = {},
): PresentedError {
  if (error instanceof FeedbackCommandError)
    return {
      ...presentError(error.original, context),
      submissionId: error.submissionId,
    };
  if (error instanceof CliConfigurationError)
    return { message: error.message, code: error.code };
  if (error instanceof OperationNotCompletedError)
    return {
      message: error.message,
      code: "operation_not_completed",
      state: error.state,
    };

  if (error instanceof AgentWorkplaceError) {
    // Request IDs, retry timing and missing scope names are safe to show and
    // let users follow up (for example with feedback send --request-id).
    return {
      message: error.message,
      status: error.status,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.scopes === undefined ? {} : { scopes: error.scopes }),
      ...withHint(nextStep(error, context)),
    };
  }

  if (error instanceof AgentWorkplaceNetworkError)
    return {
      message: `${error.message}; the request may or may not have been received`,
      code: error.code,
      ...withHint(
        context.operation
          ? "Retry with the same --operation, which can't apply twice"
          : undefined,
      ),
    };

  // The SDK's input errors carry fixed messages that name the rejected input.
  if (error instanceof AgentWorkplaceInputError)
    return { message: error.message, code: error.code };

  if (error instanceof DocumentationError) {
    return {
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      code: error.code,
    };
  }

  const local = localFailure(error);
  if (local) return local;

  return { message: "Unable to complete the request", code: "unexpected" };
}

function withHint(hint: string | undefined) {
  return hint === undefined ? {} : { hint };
}

/** Name a local file failure and the path the caller chose. */
function localFailure(error: unknown): PresentedError | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const description = localFailures.get(String(error.code));
  if (!description) return undefined;
  const path = "path" in error ? error.path : undefined;
  return {
    message: typeof path === "string" ? `${description}: ${path}` : description,
    code: "local_file",
  };
}
