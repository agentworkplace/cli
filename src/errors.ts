import { AgentWorkplaceError } from "@agent-workplace/sdk";

export class CliConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliConfigurationError";
  }
}

export interface PresentedError {
  message: string;
  status?: number;
  code?: string;
}

export function presentError(error: unknown): PresentedError {
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

  return { message: "Unable to complete the request" };
}
