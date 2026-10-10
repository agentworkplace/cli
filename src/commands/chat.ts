import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type {
  ChatAddRequest,
  ChatCreateRequest,
  ChatLeaveRequest,
  ChatPostRequest,
  ChatRemoveRequest,
} from "@agent-workplace/sdk";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import { CliConfigurationError } from "../errors.js";

interface ChatInputOptions extends AccessCommandOptions {
  file: string;
  input?: AsyncIterable<string | Uint8Array>;
}
/** Every mutation request includes an explicit operationId in its input. The CLI
 * never generates or changes it, including after interruption or a lost response. */
async function chatInput<T>(options: ChatInputOptions): Promise<T> {
  const maximum = 400_000;
  try {
    let bytes: Uint8Array;
    if (options.file === "-") {
      if (!options.input && process.stdin.isTTY)
        throw new Error("Interactive input unavailable");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of options.input ?? process.stdin) {
        const next = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        length += next.byteLength;
        if (length > maximum) throw new Error("Input too large");
        chunks.push(next);
      }
      bytes = Buffer.concat(chunks);
    } else {
      const file = await open(
        options.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maximum)
          throw new Error("Invalid file");
        const buffer = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > maximum) throw new Error("Input too large");
        bytes = buffer.subarray(0, length);
      } finally {
        await file.close();
      }
    }
    // SDK owns request validation; syntax errors must never expose private text.
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as T;
  } catch {
    throw new CliConfigurationError(
      "Provide UTF-8 JSON of at most 400000 bytes with an explicit operationId; use --file - for stdin",
    );
  }
}
export function executeChatList(
  options: AccessCommandOptions & { after?: string; limit?: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.listChatConversations(
      { apiKey: key },
      {
        ...(options.after === undefined ? {} : { after: options.after }),
        ...(options.limit === undefined
          ? {}
          : { limit: Number(options.limit) }),
      },
    ),
  );
}
export function executeChatRead(
  options: AccessCommandOptions & { id: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.getChatConversation({ apiKey: key }, options.id),
  );
}
export function executeChatEntries(
  options: AccessCommandOptions & {
    id: string;
    after?: string;
    limit?: string;
  },
) {
  return executeSavedOperation(options, (client, key) =>
    client.readChatEntries({ apiKey: key }, options.id, {
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
    }),
  );
}
export async function executeChatCreate(options: ChatInputOptions) {
  const request = await chatInput<ChatCreateRequest>(options);
  return executeSavedOperation(options, (client, key) =>
    client.createChatConversation({ apiKey: key }, request),
  );
}
export async function executeChatPost(
  options: ChatInputOptions & { id: string },
) {
  const request = await chatInput<ChatPostRequest>(options);
  return executeSavedOperation(options, (client, key) =>
    client.postChatMessage({ apiKey: key }, options.id, request),
  );
}
export async function executeChatAdd(
  options: ChatInputOptions & { id: string },
) {
  const request = await chatInput<ChatAddRequest>(options);
  return executeSavedOperation(options, (client, key) =>
    client.addChatParticipants({ apiKey: key }, options.id, request),
  );
}
export async function executeChatLeave(
  options: ChatInputOptions & { id: string },
) {
  const request = await chatInput<ChatLeaveRequest>(options);
  return executeSavedOperation(options, (client, key) =>
    client.leaveChatConversation({ apiKey: key }, options.id, request),
  );
}
export async function executeChatRemove(
  options: ChatInputOptions & { id: string },
) {
  const request = await chatInput<ChatRemoveRequest>(options);
  return executeSavedOperation(options, (client, key) =>
    client.removeChatParticipant({ apiKey: key }, options.id, request),
  );
}
export function executeChatDelete(
  options: AccessCommandOptions & { id: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.deleteChatConversation({ apiKey: key }, options.id),
  );
}
