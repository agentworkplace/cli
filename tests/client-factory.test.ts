import { AgentWorkplace } from "@agent-workplace/sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const origin = "https://api.example.test";
const id = randomUUID();
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Each command must reach the supplied SDK transport, including commands with
// their own constructors. Successful product behavior is covered separately.
const commands = [
  ["signup", "--name", "Agent", "--owner-email", "owner@example.test"],
  ["status"],
  ["account-status"],
  ["workplace", "billing", "status"],
  [
    "workplace",
    "billing",
    "cancel",
    "--command-id",
    "11111111-1111-4111-8111-111111111111",
    "--revision",
    "11111111-1111-4111-8111-111111111111",
  ],
  [
    "workplace",
    "billing",
    "resume",
    "--command-id",
    "11111111-1111-4111-8111-111111111111",
    "--revision",
    "11111111-1111-4111-8111-111111111111",
  ],
  ["workplace", "billing", "command", "11111111-1111-4111-8111-111111111111"],
  ["resend-nomination"],
  [
    "correct-nomination",
    "--nomination-id",
    id,
    "--owner-email",
    "other@example.test",
  ],
  ["cancel-nomination", "--nomination-id", id],
  ["confirm-ownership", "--nomination-id", id],
  ["accounts"],
  ["leave"],
  ["remove-account", "--account-id", id],
  ["keys"],
  ["rename-key", "--key-id", id, "--name", "New name"],
  ["revoke-key", "--key-id", id],
  ["rotate-key", "--name", "Rotation"],
  ["create-key", "--name", "Key", "--save-to", "unused.json"],
  ["recover-keys", "--name", "Recovery", "--save-to", "unused.json"],
  ["mail", "address"],
  ["mail", "mailboxes"],
  ["mail", "list"],
  ["mail", "read", id],
  ["mail", "omissions"],
  ["mail", "send", "--operation", "unused.json"],
  ["mail", "status", "--operation", "unused.json"],
  ["mail", "trash", id],
  ["mail", "restore", id],
  ["mail", "purge", id],
  ["deletion-status", "--receipt", "-"],
];

test.each(commands.map((args) => ({ name: args.join(" "), args })))(
  "supplied SDK transport owns $name",
  async ({ args }) => {
    const directory = await mkdtemp(join(tmpdir(), "awp-cli-factory-"));
    directories.push(directory);
    const credentials = join(directory, "credentials.json");
    const key = "fixture-only-product-key";
    if (args[0] !== "signup")
      await withCredentials(credentials, (store) =>
        store.write({
          version: 1,
          kind: "account",
          origin,
          credential: { accountId: id, workplaceId: randomUUID(), key },
        }),
      );
    const defaultFetch = vi.fn(() => {
      throw new Error("Default transport escaped");
    });
    vi.stubGlobal("fetch", defaultFetch);
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("X-Request-ID")).toBeTruthy();
      if (!["signup", "deletion-status"].includes(args[0]!))
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${key}`,
        );
      return new Response("", { status: 403 });
    });
    const factory = vi.fn(
      (baseUrl: string) => new AgentWorkplace({ baseUrl, fetch: request }),
    );
    const proof = randomBytes(32).toString("base64url");
    let stdout = "",
      stderr = "";
    const exitCode = await runCli(
      ["--base-url", origin, "--credentials", credentials, ...args, "--json"],
      {
        version: "0.0.0",
        createProductClient: factory,
        input: (async function* () {
          yield args[0] === "deletion-status"
            ? JSON.stringify({
                version: 1,
                apiOrigin: origin,
                accountId: id,
                workplaceId: randomUUID(),
                proof,
              })
            : "123456\n";
        })(),
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(factory).toHaveBeenCalledExactlyOnceWith(origin);
    expect(request).toHaveBeenCalledTimes(1);
    expect(defaultFetch).not.toHaveBeenCalled();
    expect(stdout).toBe("");
    expect(stderr).toContain("403");
    expect(stderr).not.toContain(key);
    expect(stderr).not.toContain(proof);
  },
);

test("health remains distinct and local commands never construct product clients", async () => {
  const product = vi.fn(() => {
    throw new Error("Product factory must not run");
  });
  const health = vi.fn(() => ({
    health: async () => ({ status: "ok" as const }),
  }));
  for (const args of [
    ["--help"],
    ["--version"],
    ["--base-url", origin, "health", "--json"],
  ]) {
    expect(
      await runCli(args, {
        version: "0.0.0",
        createProductClient: product,
        createClient: health,
        writeOut: () => {},
        writeErr: () => {},
      }),
    ).toBe(0);
  }
  expect(product).not.toHaveBeenCalled();
  expect(health).toHaveBeenCalledExactlyOnceWith(origin);
});

test("conflicting deletion factories fail before reading a receipt or sending", async () => {
  const product = vi.fn(() => {
    throw new Error("Must not construct");
  });
  const deletion = vi.fn(() => {
    throw new Error("Must not construct");
  });
  const input = {
    [Symbol.asyncIterator]: vi.fn(() => {
      throw new Error("Must not read");
    }),
  };
  let stderr = "";
  expect(
    await runCli(
      ["--base-url", origin, "deletion-status", "--receipt", "-", "--json"],
      {
        version: "0.0.0",
        createProductClient: product,
        createDeletionClient: deletion,
        input,
        writeOut: () => {},
        writeErr: (value) => {
          stderr += value;
        },
      },
    ),
  ).toBe(1);
  expect(stderr).toContain(
    "Choose either createProductClient or createDeletionClient",
  );
  expect(product).not.toHaveBeenCalled();
  expect(deletion).not.toHaveBeenCalled();
  expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
});
