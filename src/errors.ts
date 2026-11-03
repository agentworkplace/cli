import {
  AgentWorkplaceError,
  AgentWorkplaceInputError,
  DocumentationError,
} from "@agent-workplace/sdk";

export class CliConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliConfigurationError";
  }
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
}

export function presentError(error: unknown): PresentedError {
  if (error instanceof FeedbackCommandError)
    return {
      ...presentError(error.original),
      submissionId: error.submissionId,
    };
  if (error instanceof CliConfigurationError) {
    return { message: error.message };
  }

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
    };
  }

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

  return { message: "Unable to complete the request" };
}
