import { randomUUID } from "node:crypto";
import type {
  AgentWorkplace,
  ChatAddRequest,
  ChatCreateRequest,
  ChatLeaveRequest,
  ChatPostRequest,
  ChatRemoveRequest,
} from "@agent-workplace/sdk";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import { readBoundedFile } from "../bounded-file.js";
import {
  isChatAccountList,
  isChatId,
  isChatTopic,
  readChatText,
  withChatOperation,
  type ChatAction,
  type SavedChatOperation,
} from "../chat-operation.js";
import { CliConfigurationError } from "../errors.js";

/** File input carries the caller's explicit operationId. The CLI never generates
 * or changes it, including after interruption or a lost response. */
async function chatInput(
  file: string,
  input?: AsyncIterable<string | Uint8Array>,
): Promise<unknown> {
  const maximum = 400_000;
  try {
    let bytes: Uint8Array;
    if (file === "-") {
      if (!input && process.stdin.isTTY)
        throw new Error("Interactive input unavailable");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of input ?? process.stdin) {
        const next = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        length += next.byteLength;
        if (length > maximum) throw new Error("Input too large");
        chunks.push(next);
      }
      bytes = Buffer.concat(chunks);
    } else bytes = await readBoundedFile(file, maximum);
    // SDK owns request validation; syntax errors must never expose private text.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CliConfigurationError(
      "Provide UTF-8 JSON of at most 400000 bytes with an explicit operationId; use --file - for stdin",
    );
  }
}

export interface ChatMutationOptions extends AccessCommandOptions {
  id?: string;
  file?: string;
  operation?: string;
  account?: string[];
  topic?: string;
  textFile?: string;
  input?: AsyncIterable<string | Uint8Array>;
}
type ChatSend = (
  client: AgentWorkplace,
  key: string,
  conversationId: string,
  request: unknown,
) => Promise<object>;
type ChatIntent = {
  conversationId?: string;
  accounts?: string[];
  topic?: string;
  text?: string;
};
const newOperationInputs: Record<ChatAction, string> = {
  create: "A new Chat creation requires --account",
  post: "A new Chat post requires --id and --text-file",
  add: "A new Chat addition requires --id and --account",
  leave: "A new Chat leave requires --id",
  remove: "A new Chat removal requires --id and --account",
};

function chatId(value: string) {
  const id = value.toLowerCase();
  if (!isChatId(id))
    throw new CliConfigurationError(
      "Chat --id and --account values must be UUIDs",
    );
  return id;
}
/** Supplied inputs must equal the saved request; omitted inputs are not compared. */
function sameIntent(saved: SavedChatOperation, intent: ChatIntent) {
  const accounts =
    saved.action === "remove"
      ? [saved.request.accountId]
      : "accountIds" in saved.request
        ? saved.request.accountIds
        : undefined;
  return (
    (intent.conversationId === undefined ||
      (saved.action !== "create" &&
        saved.conversationId === intent.conversationId)) &&
    (intent.accounts === undefined ||
      JSON.stringify(intent.accounts) === JSON.stringify(accounts)) &&
    (intent.topic === undefined ||
      (saved.action === "create" && saved.request.topic === intent.topic)) &&
    (intent.text === undefined ||
      (saved.action === "post" && saved.request.text === intent.text))
  );
}
function newOperation(
  action: ChatAction,
  intent: ChatIntent,
  owner: Pick<
    SavedChatOperation,
    "version" | "origin" | "workplaceId" | "accountId"
  >,
): SavedChatOperation {
  const missing = new CliConfigurationError(newOperationInputs[action]);
  const operationId = randomUUID();
  const { conversationId, accounts, topic, text } = intent;
  if (action === "create") {
    if (!accounts) throw missing;
    if (!isChatAccountList(accounts, 2))
      throw new CliConfigurationError(
        "A Chat conversation requires 2 to 100 unique agent accounts, including yourself",
      );
    return {
      ...owner,
      action,
      request: {
        operationId,
        accountIds: accounts,
        ...(topic === undefined ? {} : { topic }),
      },
    };
  }
  if (!conversationId) throw missing;
  switch (action) {
    case "post":
      if (text === undefined) throw missing;
      return {
        ...owner,
        action,
        conversationId,
        request: { operationId, text },
      };
    case "add":
      if (!accounts) throw missing;
      return {
        ...owner,
        action,
        conversationId,
        request: { operationId, accountIds: accounts },
      };
    case "leave":
      return { ...owner, action, conversationId, request: { operationId } };
    case "remove":
      if (!accounts) throw missing;
      return {
        ...owner,
        action,
        conversationId,
        request: { operationId, accountId: accounts[0]! },
      };
  }
}

/** With --operation, the CLI generates the operationId and durably saves the
 * complete request before the first attempt; retries replay it unchanged. */
async function executeChatMutation(
  action: ChatAction,
  options: ChatMutationOptions,
  send: ChatSend,
) {
  const operationInput =
    options.account !== undefined ||
    options.topic !== undefined ||
    options.textFile !== undefined;
  if (options.operation === undefined) {
    if (options.file === undefined)
      throw new CliConfigurationError(
        "Provide --operation for a CLI-managed operation file, or --file JSON with an explicit operationId",
      );
    if (operationInput)
      throw new CliConfigurationError(
        "--account, --topic and --text-file require --operation",
      );
    if (action !== "create" && options.id === undefined)
      throw new CliConfigurationError("Provide --id with --file");
    const request = await chatInput(options.file, options.input);
    return executeSavedOperation(options, (client, key) =>
      send(client, key, options.id ?? "", request),
    );
  }
  if (options.file !== undefined)
    throw new CliConfigurationError(
      "Use either --operation or --file, not both",
    );
  const operation = options.operation;
  const conversationId =
    options.id === undefined ? undefined : chatId(options.id);
  const accounts = options.account?.map(chatId);
  if (accounts && !isChatAccountList(accounts, 1))
    throw new CliConfigurationError(
      "Chat --account values must be unique, at most 100",
    );
  if (action === "remove" && accounts && accounts.length !== 1)
    throw new CliConfigurationError(
      "A Chat removal takes exactly one --account",
    );
  if (options.topic !== undefined && !isChatTopic(options.topic))
    throw new CliConfigurationError(
      "Chat topic must be 1 to 1000 UTF-8 bytes without NUL characters",
    );
  const text =
    options.textFile === undefined
      ? undefined
      : await readChatText(options.textFile);
  return executeSavedOperation(options, (client, key, status, origin) =>
    withChatOperation(operation, async (store) => {
      const self = status.accountId.toLowerCase();
      // The contract counts the creator as a participant. Listing it first,
      // whether or not it was supplied, keeps equivalent retries identical.
      const intent: ChatIntent = {
        conversationId,
        accounts:
          action === "create" && accounts
            ? [self, ...accounts.filter((account) => account !== self)]
            : accounts,
        topic: options.topic,
        text,
      };
      let saved = await store.read();
      if (saved) {
        if (saved.action !== action)
          throw new CliConfigurationError(
            "Use the original Chat command to retry this operation",
          );
        if (
          saved.origin !== origin ||
          saved.workplaceId !== status.workplaceId ||
          saved.accountId !== status.accountId
        )
          throw new CliConfigurationError(
            "Chat operation belongs to another server, workplace or account",
          );
        if (!sameIntent(saved, intent))
          throw new CliConfigurationError(
            "Chat operation is immutable; retry with its original inputs",
          );
      } else {
        saved = newOperation(action, intent, {
          version: 1,
          origin,
          workplaceId: status.workplaceId,
          accountId: status.accountId,
        });
        // The immutable ID and request are durable before the first request.
        await store.write(saved);
      }
      return send(
        client,
        key,
        saved.action === "create" ? "" : saved.conversationId,
        saved.request,
      );
    }),
  );
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
  options: AccessCommandOptions & { id: string; include?: "accounts" },
) {
  return executeSavedOperation(options, (client, key) =>
    client.getChatConversation(
      { apiKey: key },
      options.id,
      options.include === undefined ? {} : { include: options.include },
    ),
  );
}
export function executeChatEntries(
  options: AccessCommandOptions & {
    id: string;
    after?: string;
    limit?: string;
    include?: "accounts";
  },
) {
  return executeSavedOperation(options, (client, key) =>
    client.readChatEntries({ apiKey: key }, options.id, {
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
      ...(options.include === undefined ? {} : { include: options.include }),
    }),
  );
}
export function executeChatCreate(options: ChatMutationOptions) {
  return executeChatMutation("create", options, (client, key, _id, request) =>
    client.createChatConversation(
      { apiKey: key },
      request as ChatCreateRequest,
    ),
  );
}
export function executeChatPost(options: ChatMutationOptions) {
  return executeChatMutation("post", options, (client, key, id, request) =>
    client.postChatMessage({ apiKey: key }, id, request as ChatPostRequest),
  );
}
export function executeChatAdd(options: ChatMutationOptions) {
  return executeChatMutation("add", options, (client, key, id, request) =>
    client.addChatParticipants({ apiKey: key }, id, request as ChatAddRequest),
  );
}
export function executeChatLeave(options: ChatMutationOptions) {
  return executeChatMutation("leave", options, (client, key, id, request) =>
    client.leaveChatConversation(
      { apiKey: key },
      id,
      request as ChatLeaveRequest,
    ),
  );
}
export function executeChatRemove(options: ChatMutationOptions) {
  return executeChatMutation("remove", options, (client, key, id, request) =>
    client.removeChatParticipant(
      { apiKey: key },
      id,
      request as ChatRemoveRequest,
    ),
  );
}
export function executeChatDelete(
  options: AccessCommandOptions & { id: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.deleteChatConversation({ apiKey: key }, options.id),
  );
}
