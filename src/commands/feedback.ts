import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { FeedbackCategory } from "@agent-workplace/sdk";

import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import { CliConfigurationError, FeedbackCommandError } from "../errors.js";

const maximumInputBytes = 8192;

async function readStdin(input: AsyncIterable<string | Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += bytes.length;
    if (length > maximumInputBytes)
      throw new CliConfigurationError("Feedback message file is too large");
    chunks.push(bytes);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

async function readMessage(
  options: { message?: string; messageFile?: string },
  input: AsyncIterable<string | Uint8Array> | undefined,
) {
  if ((options.message === undefined) === (options.messageFile === undefined))
    throw new CliConfigurationError(
      "Provide exactly one of --message or --message-file",
    );
  if (options.message !== undefined) return options.message;
  if (options.messageFile === "-") {
    if (!input && process.stdin.isTTY)
      throw new CliConfigurationError(
        "Provide feedback through standard input or a file",
      );
    return readStdin(input ?? process.stdin);
  }
  const path = options.messageFile!;
  const unreadable = () =>
    new CliConfigurationError("Unable to read the feedback message file");
  const info = await stat(path).catch(() => {
    throw unreadable();
  });
  if (!info.isFile()) throw unreadable();
  if (info.size > maximumInputBytes)
    throw new CliConfigurationError("Feedback message file is too large");
  const file = await open(path, "r").catch(() => {
    throw unreadable();
  });
  try {
    const bytes = await file.readFile();
    if (bytes.length > maximumInputBytes)
      throw new CliConfigurationError("Feedback message file is too large");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

export async function executeFeedbackSend(
  options: AccessCommandOptions & {
    message?: string;
    messageFile?: string;
    category?: FeedbackCategory;
    requestId?: string;
    submissionId?: string;
    input?: AsyncIterable<string | Uint8Array>;
  },
) {
  const submissionId = options.submissionId ?? randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      submissionId,
    )
  )
    throw new CliConfigurationError("Invalid submission ID");
  if (
    options.category !== undefined &&
    !["bug", "suggestion", "general"].includes(options.category)
  )
    throw new CliConfigurationError("Invalid feedback category");
  const message = await readMessage(options, options.input);
  if (!message.trim() || new TextEncoder().encode(message).length > 4096)
    throw new CliConfigurationError(
      "Feedback message must contain 1–4096 UTF-8 bytes",
    );
  await executeSavedOperation(options, async (client, key) => {
    // Only a dispatched submission has an uncertain outcome worth retrying
    // under the same ID; local failures above sent nothing.
    try {
      return await client.submitFeedback(
        { apiKey: key },
        {
          submissionId,
          message,
          ...(options.category ? { category: options.category } : {}),
          ...(options.requestId ? { relatedRequestId: options.requestId } : {}),
        },
      );
    } catch (error) {
      throw new FeedbackCommandError(submissionId, error);
    }
  });
}
