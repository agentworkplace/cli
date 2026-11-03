import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { readCredentials, withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function savedAccount() {
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-lock-"));
  directories.push(directory);
  const path = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(path, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  const mailbox = {
    mailboxId: randomUUID(),
    accountId,
    address: "sample@mail.agentworkplace.dev",
  };
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
    mailbox,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  return { path, mailbox };
}

function run(arguments_: string[]) {
  let stdout = "",
    stderr = "";
  return runCli(arguments_, {
    version: "0.0.0",
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  }).then((code) => ({ code, stdout, stderr }));
}

test("a slow command does not hold the credential lock from other commands", async () => {
  const { path, mailbox } = await savedAccount();
  let finishListing!: () => void;
  const listing = new Promise<void>((resolve) => {
    finishListing = resolve;
  });
  let listingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    listingStarted = resolve;
  });
  vi.spyOn(AgentWorkplace.prototype, "listFiles").mockImplementation(
    async () => {
      listingStarted();
      await listing;
      return { files: [], nextCursor: null } as unknown as Awaited<
        ReturnType<AgentWorkplace["listFiles"]>
      >;
    },
  );
  const slow = run(["--credentials", path, "files", "list", "--json"]);
  await started;
  // With the lock held throughout, this would wait and fail as busy.
  const started_ = Date.now();
  await expect(
    run(["--credentials", path, "mail", "address", "--json"]),
  ).resolves.toEqual({
    code: 0,
    stdout: JSON.stringify(mailbox) + "\n",
    stderr: "",
  });
  expect(Date.now() - started_).toBeLessThan(900);
  finishListing();
  await expect(slow).resolves.toMatchObject({ code: 0, stderr: "" });
});

test("reading credentials waits for a writer and sees its replacement", async () => {
  const { path } = await savedAccount();
  const replacement = {
    version: 1 as const,
    kind: "account" as const,
    origin: "https://api.example.test",
    credential: {
      accountId: randomUUID(),
      workplaceId: randomUUID(),
      key: "replacement",
    },
  };
  let writing!: () => void;
  const held = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const writer = withCredentials(path, async (store) => {
    writing();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await store.write(replacement);
  });
  await held;
  await expect(readCredentials(path)).resolves.toEqual(replacement);
  await writer;
}, 10_000);
