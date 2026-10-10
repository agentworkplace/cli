import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
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
const operationId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const createdAt = "2026-10-09T00:00:00.000Z";
const conversation = {
  conversationId,
  topic: null,
  createdAt,
  participants: [{ accountId, joinedSequence: "1" }],
  latestSequence: "9007199254740993",
};
const entry = {
  entryId: operationId,
  conversationId,
  sequence: "9007199254740993",
  actorId: accountId,
  createdAt,
  kind: "message",
  text: "é\nmessage",
  references: [],
};
const membership = { conversationId, changed: false, entry: null };
const deleted = {
  state: "deleted",
  conversationId,
  deletedAt: createdAt,
  storageReleased: true,
  cleanup: "pending",
};
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "awp-chat-cli-"));
  directories.push(path);
  return path;
}
async function run(
  args: string[],
  input?: AsyncIterable<string | Uint8Array>,
  failure?: { status: number; code: string },
) {
  const credentials = join(await directory(), "credentials.json");
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "fixture-key" },
    }),
  );
  let stdout = "",
    stderr = "";
  const calls: {
    path: string;
    method: string;
    body?: unknown;
    query: Record<string, string>;
  }[] = [];
  const code = await runCli(["--credentials", credentials, "chat", ...args], {
    version: "0.0.0",
    input,
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
          const parsed = new URL(String(url)),
            path = parsed.pathname,
            method = init?.method ?? "GET";
          const body: unknown = init?.body
            ? JSON.parse(String(init.body))
            : undefined;
          calls.push({
            path,
            method,
            body,
            query: Object.fromEntries(parsed.searchParams),
          });
          if (path === "/v1/access/account")
            return Response.json({
              accountId,
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
          if (failure)
            return Response.json(
              { error: { code: failure.code, message: "Request rejected" } },
              { status: failure.status },
            );
          if (method === "DELETE") return Response.json(deleted);
          if (path.endsWith("/entries"))
            return Response.json({
              entries: [entry],
              nextAfter: null,
              latestSequence: entry.sequence,
            });
          if (path.endsWith("/messages"))
            return Response.json({ state: "posted", entry });
          if (
            ["/participants", "/leave", "/remove"].some((suffix) =>
              path.endsWith(suffix),
            )
          )
            return Response.json(membership);
          if (path === "/v1/chat/conversations")
            return Response.json(
              method === "POST"
                ? { state: "created", conversationId, sequence: "1" }
                : { conversations: [conversation], nextCursor: null },
            );
          return Response.json(conversation);
        },
      }),
  });
  return { code, stdout, stderr, calls };
}
async function* json(value: unknown) {
  yield JSON.stringify(value);
}

test("every Chat command uses the SDK and prints exactly its JSON result", async () => {
  for (const [command, request, expected, suffix] of [
    [
      "create",
      { operationId, accountIds: [accountId, workplaceId] },
      { state: "created", conversationId, sequence: "1" },
      "",
    ],
    [
      "post",
      { operationId, text: entry.text },
      { state: "posted", entry },
      `/${conversationId}/messages`,
    ],
    [
      "add",
      { operationId, accountIds: [workplaceId] },
      membership,
      `/${conversationId}/participants`,
    ],
    ["leave", { operationId }, membership, `/${conversationId}/leave`],
    [
      "remove",
      { operationId, accountId: workplaceId },
      membership,
      `/${conversationId}/remove`,
    ],
  ] as const) {
    const result = await run(
      [
        command,
        ...(command === "create" ? [] : ["--id", conversationId]),
        "--file",
        "-",
        "--json",
      ],
      json(request),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
    expect(result.calls.at(-1)).toMatchObject({
      path: `/v1/chat/conversations${suffix}`,
      method: "POST",
      body: request,
    });
    expect(
      result.calls.filter((call) => call.path.startsWith("/v1/notifications")),
    ).toHaveLength(0);
  }
  for (const [args, expected] of [
    [
      ["list", "--limit", "1"],
      { conversations: [conversation], nextCursor: null },
    ],
    [["read", "--id", conversationId], conversation],
    [
      ["entries", "--id", conversationId, "--after", "9007199254740992"],
      { entries: [entry], nextAfter: null, latestSequence: entry.sequence },
    ],
    [["delete", "--id", conversationId], deleted],
  ] as const) {
    const result = await run([...args, "--json"]);
    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      stdout: `${JSON.stringify(expected)}\n`,
    });
    if (args[0] === "entries")
      expect(result.calls.at(-1)?.query.after).toBe("9007199254740992");
  }
});

test("saved JSON reuses the exact operation ID across separate invocations", async () => {
  const file = join(await directory(), "request.json");
  const request = { operationId, text: entry.text };
  await writeFile(file, JSON.stringify(request), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run([
      "post",
      "--id",
      conversationId,
      "--file",
      file,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.calls.at(-1)?.body).toMatchObject(request);
  }
});

test("malformed, oversized and invalid UTF-8 input fails privately before any network request", async () => {
  for (const chunk of [
    '{"private message":',
    " ".repeat(400001),
    new Uint8Array([0xff]),
  ]) {
    const result = await run(
      ["post", "--id", conversationId, "--file", "-", "--json"],
      (async function* () {
        yield chunk;
      })(),
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        message:
          "Provide UTF-8 JSON of at most 400000 bytes with an explicit operationId; use --file - for stdin",
      },
    });
    expect(result.calls).toEqual([]);
  }
});

test("file input rejects symlinks and oversized files without revealing their paths", async () => {
  const root = await directory(),
    file = join(root, "private-text.json"),
    link = join(root, "link.json");
  await writeFile(file, " ".repeat(400001));
  await symlink(file, link);
  for (const path of [file, link, root]) {
    const result = await run([
      "post",
      "--id",
      conversationId,
      "--file",
      path,
      "--json",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(root);
    expect(result.calls).toEqual([]);
  }
});

test("missing caller identity never becomes a newly generated operation", async () => {
  const result = await run(
    ["post", "--id", conversationId, "--file", "-", "--json"],
    json({ text: "message" }),
  );
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(
    result.calls.filter((call) => call.path.startsWith("/v1/chat")),
  ).toHaveLength(0);
});

test("server conflict and lost authority remain failures with machine-readable codes", async () => {
  for (const failure of [
    { status: 409, code: "conflict" },
    { status: 404, code: "not_found" },
  ]) {
    const result = await run(
      ["post", "--id", conversationId, "--file", "-", "--json"],
      json({ operationId, text: "message" }),
      failure,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: { message: "Request rejected", ...failure },
    });
    expect(
      result.calls.filter((call) => call.path.startsWith("/v1/chat")),
    ).toHaveLength(1);
  }
});
