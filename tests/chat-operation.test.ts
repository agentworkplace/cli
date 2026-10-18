import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const accountId = "11111111-1111-4111-8111-111111111111";
const workplaceId = "22222222-2222-4222-8222-222222222222";
const conversationId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const thirdId = "66666666-6666-4666-8666-666666666666";
const origin = "https://api.example.test";
const createdAt = "2026-10-11T00:00:00.000Z";
const membership = { conversationId, changed: false, entry: null };
type Call = { path: string; method: string; body?: unknown };

async function fixture(account = accountId) {
  const root = await mkdtemp(join(tmpdir(), "awp-chat-operation-"));
  directories.push(root);
  const credentials = join(root, `credentials-${account}.json`);
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin,
      credential: { accountId: account, workplaceId, key: "private-key" },
    }),
  );
  const text = join(root, "reply.txt");
  await writeFile(text, "é reply\n", { mode: 0o600 });
  return { root, credentials, text, operation: join(root, "operation.json") };
}

async function run(
  credentials: string,
  args: string[],
  options: {
    account?: string;
    respond?: (call: Call) => Promise<Response | undefined>;
  } = {},
) {
  let stdout = "",
    stderr = "";
  const calls: Call[] = [];
  const code = await runCli(
    ["--credentials", credentials, "chat", ...args, "--json"],
    {
      version: "0.0.0",
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
      createProductClient: (baseUrl) =>
        new AgentWorkplace({
          baseUrl,
          fetch: async (url, init) => {
            const path = new URL(String(url)).pathname;
            const call: Call = {
              path,
              method: init?.method ?? "GET",
              ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            };
            calls.push(call);
            if (path === "/v1/access/account")
              return Response.json({
                accountId: options.account ?? accountId,
                workplaceId,
                kind: "agent",
                role: "member",
                state: "active",
                workplaceState: "unconfirmed",
                cleanupAt: "2026-10-21T00:00:00.000Z",
                cleanupWarning: null,
                free: null,
                starter: {
                  outboundLimit: 2,
                  inboundLimit: 20,
                  storageLimit: "100 MB",
                  outboundUsed: 0,
                  inboundUsed: 0,
                  storageUsedBytes: 0,
                },
              });
            const response = await options.respond?.(call);
            if (response) return response;
            const body = call.body as { operationId: string; text?: string };
            if (path.endsWith("/messages"))
              return Response.json({
                state: "posted",
                entry: {
                  entryId: body.operationId,
                  conversationId,
                  sequence: "2",
                  actorId: accountId,
                  createdAt,
                  kind: "message",
                  text: body.text,
                  references: [],
                },
              });
            if (path === "/v1/chat/conversations")
              return Response.json({
                state: "created",
                conversationId,
                sequence: "1",
              });
            return Response.json(membership);
          },
        }),
    },
  );
  return {
    code,
    stdout,
    stderr,
    chatCalls: calls.filter((call) => call.path.startsWith("/v1/chat")),
  };
}
async function saved(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    request: { operationId: string };
  } & Record<string, unknown>;
}
function error(message: string) {
  return `${JSON.stringify({ error: { message } })}\n`;
}

test("saves the generated request before a lost response and retries with only the operation file", async () => {
  const f = await fixture();
  let beforeRequest: { text: string; mode: number } | undefined;
  const first = await run(
    f.credentials,
    [
      "post",
      "--id",
      conversationId.toUpperCase(),
      "--operation",
      f.operation,
      "--text-file",
      f.text,
    ],
    {
      respond: async () => {
        beforeRequest = {
          text: await readFile(f.operation, "utf8"),
          mode: (await stat(f.operation)).mode & 0o777,
        };
        throw new Error("lost response with private details");
      },
    },
  );
  expect(first.code).not.toBe(0);
  expect(first.stdout).toBe("");
  expect(first.stderr).not.toContain("private details");
  const stored = await readFile(f.operation, "utf8");
  const record = await saved(f.operation);
  // The durable record precedes the first request and matches its body.
  expect(beforeRequest).toEqual({ text: stored, mode: 0o600 });
  expect(first.chatCalls[0]!.body).toEqual({
    ...record.request,
    references: [],
  });
  expect(record).toEqual({
    version: 1,
    origin,
    workplaceId,
    accountId,
    action: "post",
    conversationId,
    request: { operationId: record.request.operationId, text: "é reply\n" },
  });
  expect(stored).not.toContain("private-key");

  await rm(f.text);
  const retried = await run(f.credentials, [
    "post",
    "--operation",
    f.operation,
  ]);
  expect(retried.code).toBe(0);
  expect(retried.stderr).toBe("");
  expect(retried.chatCalls).toEqual([
    {
      path: `/v1/chat/conversations/${conversationId}/messages`,
      method: "POST",
      body: { ...record.request, references: [] },
    },
  ]);
  expect(first.chatCalls[0]!.body).toEqual(retried.chatCalls[0]!.body);
  expect(JSON.parse(retried.stdout)).toMatchObject({
    state: "posted",
    entry: { entryId: record.request.operationId, text: "é reply\n" },
  });
  expect(await readFile(f.operation, "utf8")).toBe(stored);
});

test("every mutation builds its request from options and prints the SDK result", async () => {
  const f = await fixture();
  for (const [args, path, body, result] of [
    [
      ["create", "--account", otherId, "--topic", "Release"],
      "/v1/chat/conversations",
      { accountIds: [accountId, otherId], topic: "Release" },
      { state: "created", conversationId, sequence: "1" },
    ],
    [
      [
        "add",
        "--id",
        conversationId,
        "--account",
        otherId,
        "--account",
        thirdId,
      ],
      `/v1/chat/conversations/${conversationId}/participants`,
      { accountIds: [otherId, thirdId] },
      membership,
    ],
    [
      ["leave", "--id", conversationId],
      `/v1/chat/conversations/${conversationId}/leave`,
      {},
      membership,
    ],
    [
      ["remove", "--id", conversationId, "--account", otherId],
      `/v1/chat/conversations/${conversationId}/remove`,
      { accountId: otherId },
      membership,
    ],
  ] as const) {
    const operation = join(f.root, `${args[0]}.json`);
    const outcome = await run(f.credentials, [
      ...args,
      "--operation",
      operation,
    ]);
    const { request } = await saved(operation);
    expect(outcome).toEqual({
      code: 0,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: "",
      chatCalls: [
        {
          path,
          method: "POST",
          body: { operationId: request.operationId, ...body },
        },
      ],
    });
  }
});

test("creation lists the caller first whether or not it was supplied, so equivalent retries match", async () => {
  const f = await fixture();
  const initial = await run(f.credentials, [
    "create",
    "--operation",
    f.operation,
    "--account",
    otherId,
    "--account",
    accountId.toUpperCase(),
  ]);
  expect(initial.code).toBe(0);
  expect((await saved(f.operation)).request).toMatchObject({
    accountIds: [accountId, otherId],
  });
  for (const accounts of [[otherId], [accountId, otherId]]) {
    const retry = await run(f.credentials, [
      "create",
      "--operation",
      f.operation,
      ...accounts.flatMap((account) => ["--account", account]),
    ]);
    expect(retry.code).toBe(0);
    expect(retry.chatCalls[0]!.body).toEqual(initial.chatCalls[0]!.body);
  }
  const alone = await run(f.credentials, [
    "create",
    "--operation",
    join(f.root, "alone.json"),
    "--account",
    accountId,
  ]);
  expect(alone.stderr).toBe(
    error(
      "A Chat conversation requires 2 to 100 unique agent accounts, including yourself",
    ),
  );
  expect(alone.chatCalls).toEqual([]);
});

test("changed inputs, another command and foreign accounts never send a request", async () => {
  const f = await fixture();
  const post = ["--operation", f.operation];
  expect(
    (
      await run(f.credentials, [
        "post",
        "--id",
        conversationId,
        "--text-file",
        f.text,
        ...post,
      ])
    ).code,
  ).toBe(0);
  const stored = await readFile(f.operation, "utf8");
  const changedText = join(f.root, "changed.txt");
  await writeFile(changedText, "é reply");
  for (const args of [
    ["post", "--id", otherId, ...post],
    ["post", "--text-file", changedText, ...post],
  ]) {
    const result = await run(f.credentials, args);
    expect(result.stderr).toBe(
      error("Chat operation is immutable; retry with its original inputs"),
    );
    expect(result.chatCalls).toEqual([]);
  }
  for (const command of ["add", "leave", "remove"]) {
    const result = await run(f.credentials, [command, ...post]);
    expect(result.stderr).toBe(
      error("Use the original Chat command to retry this operation"),
    );
    expect(result.chatCalls).toEqual([]);
  }
  const foreign = await fixture(otherId);
  const result = await run(foreign.credentials, ["post", ...post], {
    account: otherId,
  });
  expect(result.stderr).toBe(
    error("Chat operation belongs to another server, workplace or account"),
  );
  expect(result.chatCalls).toEqual([]);

  const create = join(f.root, "create.json");
  expect(
    (
      await run(f.credentials, [
        "create",
        "--operation",
        create,
        "--account",
        otherId,
        "--topic",
        "Release",
      ])
    ).code,
  ).toBe(0);
  for (const args of [
    ["--account", thirdId],
    ["--topic", "Other"],
  ]) {
    const changed = await run(f.credentials, [
      "create",
      "--operation",
      create,
      ...args,
    ]);
    expect(changed.code).not.toBe(0);
    expect(changed.chatCalls).toEqual([]);
  }
  expect(await readFile(f.operation, "utf8")).toBe(stored);
});

test("input mode and new-operation requirements fail locally before any request", async () => {
  const f = await fixture();
  for (const [args, message] of [
    [
      ["post", "--id", conversationId],
      "Provide --operation for a CLI-managed operation file, or --file JSON with an explicit operationId",
    ],
    [
      ["post", "--operation", f.operation, "--file", f.text],
      "Use either --operation or --file, not both",
    ],
    [["post", "--file", f.text], "Provide --id with --file"],
    [
      ["post", "--id", conversationId, "--file", "-", "--text-file", f.text],
      "--account, --topic and --text-file require --operation",
    ],
    [
      ["post", "--operation", f.operation, "--text-file", f.text],
      "A new Chat post requires --id and --text-file",
    ],
    [
      ["post", "--operation", f.operation, "--id", conversationId],
      "A new Chat post requires --id and --text-file",
    ],
    [
      ["create", "--operation", f.operation],
      "A new Chat creation requires --account",
    ],
    [
      ["add", "--operation", f.operation, "--id", conversationId],
      "A new Chat addition requires --id and --account",
    ],
    [["leave", "--operation", f.operation], "A new Chat leave requires --id"],
    [
      [
        "remove",
        ...["--operation", f.operation, "--id", conversationId],
        ...["--account", otherId, "--account", thirdId],
      ],
      "A Chat removal takes exactly one --account",
    ],
    [
      ["add", "--operation", f.operation, "--id", "not-a-uuid"],
      "Chat --id and --account values must be UUIDs",
    ],
    [
      [
        "add",
        ...["--operation", f.operation, "--id", conversationId],
        ...["--account", otherId, "--account", otherId.toUpperCase()],
      ],
      "Chat --account values must be unique, at most 100",
    ],
    [
      [
        "create",
        ...["--operation", f.operation, "--account", otherId],
        ...["--topic", "x".repeat(1001)],
      ],
      "Chat topic must be 1 to 1000 UTF-8 bytes without NUL characters",
    ],
  ] as const) {
    const result = await run(f.credentials, [...args]);
    expect(result).toMatchObject({ stdout: "", stderr: error(message) });
    expect(result.code).not.toBe(0);
    expect(result.chatCalls).toEqual([]);
    await expect(stat(f.operation)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("unreadable, oversized or non-text message files fail privately and save nothing", async () => {
  const f = await fixture();
  const link = join(f.root, "link.txt");
  await symlink(f.text, link);
  for (const [path, content] of [
    [f.text, ""],
    [f.text, "a".repeat(64_001)],
    [f.text, new Uint8Array([0xff])],
    [f.text, "private\0text"],
    [link, undefined],
    [f.root, undefined],
  ] as const) {
    if (content !== undefined) await writeFile(path, content);
    const result = await run(f.credentials, [
      ...["post", "--id", conversationId],
      ...["--operation", f.operation, "--text-file", path],
    ]);
    expect(result.stderr).toBe(
      error(
        "Chat text must be a readable UTF-8 plain-text file of 1 to 64000 bytes without NUL characters",
      ),
    );
    expect(result.chatCalls).toEqual([]);
    await expect(stat(f.operation)).rejects.toMatchObject({ code: "ENOENT" });
  }
  await writeFile(f.text, "é".repeat(32_000));
  expect(
    (
      await run(f.credentials, [
        ...["post", "--id", conversationId],
        ...["--operation", f.operation, "--text-file", f.text],
      ])
    ).code,
  ).toBe(0);
  // Byte-exact text keeps a leading byte-order mark rather than dropping it.
  const bom = join(f.root, "bom.txt");
  await writeFile(bom, "﻿hello\n");
  const posted = await run(f.credentials, [
    ...["post", "--id", conversationId],
    ...["--operation", join(f.root, "bom.json"), "--text-file", bom],
  ]);
  expect(posted.chatCalls[0]!.body).toMatchObject({ text: "﻿hello\n" });
});

test.skipIf(process.platform === "win32")(
  "unsafe or tampered operation files are refused without sending",
  async () => {
    const f = await fixture();
    const args = ["leave", "--operation", f.operation];
    expect(
      (await run(f.credentials, [...args, "--id", conversationId])).code,
    ).toBe(0);
    const record = await saved(f.operation);
    await chmod(f.operation, 0o644);
    expect((await run(f.credentials, args)).chatCalls).toEqual([]);
    await chmod(f.operation, 0o600);
    const link = join(f.root, "link.json");
    await symlink(f.operation, link);
    expect(
      (await run(f.credentials, ["leave", "--operation", link])).chatCalls,
    ).toEqual([]);
    for (const tampered of [
      { ...record, extra: true },
      { ...record, request: { operationId: "not-a-uuid" } },
      { ...record, conversationId: undefined },
      { ...record, request: { ...record.request, text: "smuggled" } },
    ]) {
      await writeFile(f.operation, JSON.stringify(tampered), { mode: 0o600 });
      const result = await run(f.credentials, args);
      expect(result.stderr).toBe(error("Invalid Chat operation file"));
      expect(result.chatCalls).toEqual([]);
    }
  },
);

test("concurrent first attempts on one operation file send one identical intent", async () => {
  const f = await fixture();
  const otherCredentials = join(f.root, "other-credentials.json");
  await withCredentials(otherCredentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin,
      credential: { accountId, workplaceId, key: "other-key" },
    }),
  );
  const args = [
    ...["post", "--id", conversationId],
    ...["--operation", f.operation, "--text-file", f.text],
  ];
  const results = await Promise.all([
    run(f.credentials, args),
    run(otherCredentials, args),
  ]);
  expect(results.map((result) => result.code)).toEqual([0, 0]);
  expect(results[0]!.chatCalls[0]!.body).toEqual(
    results[1]!.chatCalls[0]!.body,
  );
});
