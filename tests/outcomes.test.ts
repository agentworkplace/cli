import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

const id = "11111111-1111-4111-8111-111111111111";
const version = "33333333-3333-4333-8333-333333333333";

/** Runs one command whose SDK call resolves to `{ state }`. */
async function run(
  method: keyof AgentWorkplace,
  state: string,
  args: (directory: string) => string[],
) {
  const directory = await mkdtemp(join(tmpdir(), "awp-outcomes-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://fixture.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  await writeFile(join(directory, "body.txt"), "Hello");
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
    mailbox: { mailboxId: id, accountId, address: "agent@example.test" },
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const call = vi
    .spyOn(AgentWorkplace.prototype, method as "getFileUpload")
    .mockResolvedValue({ state, uploadId: id } as Awaited<
      ReturnType<AgentWorkplace["getFileUpload"]>
    >);
  let stdout = "",
    stderr = "";
  const code = await runCli(
    ["--credentials", credentials, ...args(directory), "--json"],
    {
      version: "0.0.0",
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    },
  );
  expect(call).toHaveBeenCalledOnce();
  return { code, stdout, stderr };
}

const upload = (directory: string) => [
  "files",
  "text",
  "--source-file",
  join(directory, "body.txt"),
  "--operation",
  join(directory, "private", "operation.json"),
  "--name",
  "note.txt",
];
const organize = (directory: string) => [
  "files",
  "organize",
  id,
  "--name",
  "renamed.txt",
  "--expected-version",
  version,
  "--operation",
  join(directory, "private", "operation.json"),
];
const restore = (directory: string) => [
  "files",
  "restore",
  id,
  "--revision",
  version,
  "--expected-version",
  version,
  "--operation",
  join(directory, "private", "operation.json"),
];
const change = (command: string) => (directory: string) => [
  "files",
  command,
  id,
  "--expected-version",
  version,
  "--operation",
  join(directory, "private", "operation.json"),
];
const sendMail = (directory: string) => [
  "mail",
  "send",
  "--operation",
  join(directory, "private", "operation.json"),
  "--to",
  "someone@example.test",
  "--subject",
  "Hello",
  "--body-file",
  join(directory, "body.txt"),
];
const billing = (command: string) => () => [
  "workplace",
  "billing",
  command,
  "--command-id",
  id,
  "--revision",
  version,
];
const purchase = () => ["workplace", "billing", "upgrade", "--purchase-id", id];

type Case = readonly [
  name: string,
  method: keyof AgentWorkplace,
  args: (directory: string) => string[],
  completed: string[],
  notCompleted: string[],
];

const cases: Case[] = [
  [
    "files text",
    "uploadFileFromSource",
    upload,
    ["published", "pending"],
    [
      "limited",
      "conflict",
      "cancelled",
      "expired",
      "invalid",
      "revoked",
      "evidence_expired",
    ],
  ],
  [
    "files finalize",
    "finalizeFileUpload",
    () => ["files", "finalize", id],
    ["published", "pending"],
    ["limited", "conflict", "invalid", "evidence_expired"],
  ],
  [
    "files cancel",
    "cancelFileUpload",
    () => ["files", "cancel", id],
    ["cancelled", "expired", "pending"],
    ["published", "limited", "conflict", "invalid", "revoked"],
  ],
  [
    "files restore",
    "restoreFileRevision",
    restore,
    ["restored"],
    ["limited", "conflict", "evidence_expired"],
  ],
  [
    "files trash",
    "changeFileTrash",
    change("trash"),
    ["trashed"],
    ["conflict", "evidence_expired"],
  ],
  [
    "files restore-trash",
    "changeFileTrash",
    change("restore-trash"),
    ["restored"],
    ["conflict", "evidence_expired"],
  ],
  [
    "files organize",
    "organizeFiles",
    organize,
    ["applied"],
    ["evidence_expired"],
  ],
  [
    "files purge",
    "beginFileDeletion",
    change("purge"),
    ["pending", "complete"],
    ["conflict", "evidence_expired"],
  ],
  [
    "mail send",
    "sendMail",
    sendMail,
    ["queued", "uncertain", "accepted"],
    ["failed", "canceled"],
  ],
  [
    "workplace billing cancel",
    "requestBillingCommand",
    billing("cancel"),
    ["pending", "completed"],
    ["failed", "superseded"],
  ],
  [
    "workplace billing upgrade",
    "requestBillingPurchase",
    purchase,
    ["pending", "ready", "processing", "succeeded"],
    ["failed", "expired", "superseded"],
  ],
];

describe.each(cases)("%s", (_name, method, args, completed, notCompleted) => {
  test.each(completed)("exits 0 on %s", async (state) => {
    const result = await run(method, state, args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).state).toBe(state);
  });

  test.each(notCompleted)(
    "keeps the result and exits 1 on %s",
    async (state) => {
      const result = await run(method, state, args);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).state).toBe(state);
      expect(JSON.parse(result.stderr).error).toMatchObject({
        code: "operation_not_completed",
        state,
      });
    },
  );
});

test.each([
  ["files status", "getFileUpload", ["files", "status", id]],
  [
    "billing purchase",
    "getBillingPurchase",
    ["workplace", "billing", "purchase", id],
  ],
] as const)(
  "%s succeeds at reading a failed outcome",
  async (_name, method, args) => {
    const result = await run(method, "failed", () => [...args]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  },
);
