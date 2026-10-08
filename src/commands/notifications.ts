import { setTimeout as sleep } from "node:timers/promises";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  AgentWorkplaceError,
  compareNotificationPositions,
  type NotificationStatus,
  type NotificationEndpointRegisterRequest,
} from "@agent-workplace/sdk";
import { executeSavedOperation, type AccessCommandOptions } from "./access.js";
import { accessOrigin, withCredentials } from "../credentials.js";
import { productClient } from "../client.js";
import { CliConfigurationError } from "../errors.js";

async function endpointRegistrationInput(
  path: string,
  input?: AsyncIterable<string | Uint8Array>,
): Promise<NotificationEndpointRegisterRequest> {
  try {
    const maximum = 8192;
    let bytes: Uint8Array;
    if (path === "-") {
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
    } else {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maximum)
          throw new Error("Invalid file");
        // A file can grow after stat. Read only the limit plus one byte.
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
    // The SDK validates the request shape. No response parsing or HTTP here.
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as NotificationEndpointRegisterRequest;
  } catch {
    // JSON syntax errors can include secret fragments; file errors include paths.
    throw new CliConfigurationError(
      "Provide a valid UTF-8 JSON registration file of at most 8192 bytes, or use --file - for stdin",
    );
  }
}

export async function executeNotificationEndpointRegister(
  options: AccessCommandOptions & {
    file: string;
    input?: AsyncIterable<string | Uint8Array>;
  },
) {
  const request = await endpointRegistrationInput(options.file, options.input);
  return executeSavedOperation(options, (client, key) =>
    client.registerNotificationEndpoint({ apiKey: key }, request),
  );
}

export function executeNotificationEndpointList(
  options: AccessCommandOptions & { account?: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.listNotificationEndpoints(
      { apiKey: key },
      options.account ? { accountId: options.account } : {},
    ),
  );
}

export function executeNotificationEndpointInspect(
  options: AccessCommandOptions & { id: string; account?: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.inspectNotificationEndpoint(
      { apiKey: key },
      options.id,
      options.account ? { accountId: options.account } : {},
    ),
  );
}

export function executeNotificationEndpointTest(
  options: AccessCommandOptions & { id: string; account?: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.testNotificationEndpoint(
      { apiKey: key },
      options.id,
      options.account ? { accountId: options.account } : {},
    ),
  );
}

export function executeNotificationEndpointRemove(
  options: AccessCommandOptions & { id: string; account?: string },
) {
  return executeSavedOperation(options, async (client, key) => {
    await client.removeNotificationEndpoint(
      { apiKey: key },
      options.id,
      options.account ? { accountId: options.account } : {},
    );
    return { removed: true, endpointId: options.id };
  });
}

export class NotificationWaitCanceled extends CliConfigurationError {
  constructor(readonly exitCode: 130 | 143) {
    super("Notification wait canceled");
  }
}
export function executeNotificationList(
  options: AccessCommandOptions & {
    account?: string;
    all?: boolean;
    after?: string;
    limit?: string;
  },
) {
  return executeSavedOperation(options, (client, key) =>
    client.listNotifications(
      { apiKey: key },
      {
        ...(options.account ? { accountId: options.account } : {}),
        filter: options.all ? "all" : "unread",
        ...(options.after ? { after: options.after } : {}),
        ...(options.limit === undefined
          ? {}
          : { limit: Number(options.limit) }),
      },
    ),
  );
}
export function executeNotificationStatus(
  options: AccessCommandOptions & { account?: string },
) {
  return executeSavedOperation(options, (client, key) =>
    client.getNotificationStatus(
      { apiKey: key },
      options.account ? { accountId: options.account } : {},
    ),
  );
}
export function executeNotificationRead(
  options: AccessCommandOptions & {
    through: string;
    id?: string;
    all?: boolean;
  },
) {
  if (!!options.id === !!options.all)
    throw new CliConfigurationError("Choose one notification ID or --all");
  return executeSavedOperation(options, (client, key) =>
    options.id
      ? client.markNotificationRead({ apiKey: key }, options.id, {
          through: options.through,
        })
      : client.markNotificationsRead(
          { apiKey: key },
          { through: options.through },
        ),
  );
}

/** In-memory polling only. Inject waits for deterministic tests; never run a subprocess. */
export async function pollNotifications(options: {
  watch: boolean;
  after?: string;
  read(): Promise<NotificationStatus>;
  emit(status: NotificationStatus): void;
  wait(milliseconds: number): Promise<void>;
}) {
  let marker = options.after;
  let initialized = false;
  let failures = 0;
  for (;;) {
    let status: NotificationStatus;
    try {
      status = await options.read();
    } catch (error) {
      const retryable =
        error instanceof AgentWorkplaceError
          ? error.status === 429 || error.status >= 500
          : error instanceof TypeError ||
            (error instanceof Error && error.name === "AbortError");
      if (!retryable) throw error;
      const retryAfter =
        error instanceof AgentWorkplaceError
          ? (error.retryAfterSeconds ?? 0) * 1000
          : 0;
      await options.wait(
        Math.min(
          300_000,
          Math.max(15_000 * 2 ** Math.min(failures++, 5), retryAfter),
        ),
      );
      continue;
    }
    failures = 0;
    if (
      !initialized &&
      marker !== undefined &&
      compareNotificationPositions(marker, status.position) > 0
    )
      throw new CliConfigurationError(
        "Notification marker is ahead of the account position",
      );
    initialized = true;
    if (
      status.unreadCount > 0 &&
      (marker === undefined ||
        compareNotificationPositions(status.position, marker) > 0)
    ) {
      options.emit(status);
      marker = status.position;
      if (!options.watch) return;
      await options.wait(60_000);
    } else await options.wait(15_000);
  }
}

export async function executeNotificationWait(
  options: AccessCommandOptions & { after?: string; watch: boolean },
) {
  // Read and release the credential-file lock before a potentially unbounded wait.
  const state = await withCredentials(options.credentials, (store) =>
    store.read(),
  );
  if (!state?.credential)
    throw new CliConfigurationError(
      "No saved credentials; save an account key or complete signup first",
    );
  if (
    options.baseUrl !== undefined &&
    accessOrigin(options.baseUrl) !== state.origin
  )
    throw new CliConfigurationError(
      "Saved credentials belong to another API origin",
    );
  const credential = state.credential;
  const client = productClient(options, state.origin);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new NotificationWaitCanceled(130));
  const terminate = () => controller.abort(new NotificationWaitCanceled(143));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    await pollNotifications({
      watch: options.watch,
      ...(options.after === undefined ? {} : { after: options.after }),
      async read() {
        controller.signal.throwIfAborted();
        const attempt = new AbortController();
        const stop = () => attempt.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", stop, { once: true });
        const timeout = setTimeout(() => attempt.abort(), 30_000);
        try {
          const status = await client.getNotificationStatus(
            { apiKey: credential.key },
            {},
            { signal: attempt.signal },
          );
          controller.signal.throwIfAborted();
          // Positions bind globally unique account identity; credentials cannot silently switch accounts.
          try {
            compareNotificationPositions(
              status.position,
              `np1.${credential.accountId}.0`,
            );
          } catch {
            throw new CliConfigurationError(
              "Saved credential account does not match the notification response",
            );
          }
          return status;
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", stop);
        }
      },
      emit(status) {
        options.write(`${JSON.stringify(status)}\n`);
      },
      async wait(milliseconds) {
        await sleep(milliseconds, undefined, { signal: controller.signal });
      },
    });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
