import { AgentWorkplaceError, DocumentationError } from "@agent-workplace/sdk";

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
    return {
      message: error.message,
      status: error.status,
      ...(error.code === undefined ? {} : { code: error.code }),
    };
  }

  if (error instanceof DocumentationError) {
    return {
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      code: error.code,
    };
  }

  return { message: "Unable to complete the request" };
}
