import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-input-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "private" },
    }),
  );
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
    mailbox: {
      mailboxId: randomUUID(),
      accountId,
      address: "sample@awmail.ai",
    },
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  return { directory, credentials };
}

async function run(arguments_: string[]) {
  let stdout = "",
    stderr = "";
  const code = await runCli(arguments_, {
    version: "0.0.0",
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

test("page sizes are checked locally against each command's range", async () => {
  const { credentials } = await fixture();
  const list = vi.spyOn(AgentWorkplace.prototype, "listMailMessages");
  for (const [value, maximum] of [
    ["500", 100],
    ["abc", 100],
    ["0", 100],
    ["2.5", 100],
  ] as const)
    expect(
      await run([
        ...["--credentials", credentials, "mail", "list"],
        ...["--limit", value],
      ]),
    ).toEqual({
      code: 1,
      stdout: "",
      stderr: `error: option '--limit <count>' argument '${value}' is invalid. Use a whole number from 1 to ${maximum}.\n`,
    });
  expect(list).not.toHaveBeenCalled();
});

test("malformed IDs name the option or argument before any request", async () => {
  const { credentials } = await fixture();
  expect(
    await run(["--credentials", credentials, "mail", "read", "nope"]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "error: command-argument <messageId> value 'nope' is invalid. Use a UUID.\n",
  });
  expect(
    await run([
      ...["--credentials", credentials, "role", "show"],
      ...["--account", "nope"],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "error: option '--account <uuid>' argument 'nope' is invalid. Use a UUID.\n",
  });
  const tree = vi
    .spyOn(AgentWorkplace.prototype, "listFilesTree")
    .mockResolvedValue({ entries: [], nextCursor: null } as unknown as Awaited<
      ReturnType<AgentWorkplace["listFilesTree"]>
    >);
  expect(
    await run([
      ...["--credentials", credentials, "files", "tree"],
      ...["--parent", "root", "--json"],
    ]),
  ).toMatchObject({ code: 0, stderr: "" });
  expect(tree).toHaveBeenCalledOnce();
});

test("SDK input errors are presented with their message and code", async () => {
  const { credentials, directory } = await fixture();
  expect(
    await run([
      ...["--credentials", credentials, "files", "get", "not-a-reference"],
      ...["--output", join(directory, "out"), "--json"],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: `${JSON.stringify({ error: { message: "Invalid file reference", code: "invalid_input" } })}\n`,
  });
});

test("an invalid recipient names its option and saves no operation", async () => {
  const { credentials, directory } = await fixture();
  const operations = join(directory, "operations");
  const body = join(directory, "body.txt");
  await writeFile(body, "Hello\n");
  const send = vi.spyOn(AgentWorkplace.prototype, "sendMail");
  for (const [flag, recipients] of [
    ["--to", ["--to", "not-an-email"]],
    ["--cc", ["--to", "a@example.test", "--cc", "not-an-email"]],
  ] as const)
    expect(
      await run([
        ...["--credentials", credentials, "mail", "send"],
        ...["--operation", join(operations, "send.json")],
        ...recipients,
        ...["--subject", "Hello", "--body-file", body],
      ]),
    ).toEqual({
      code: 1,
      stdout: "",
      stderr: `Error: Invalid ${flag} address: not-an-email\n`,
    });
  expect(send).not.toHaveBeenCalled();
  await expect(readdir(operations)).resolves.toEqual([]);
});

test("signup rejects an unusable mailbox name before saving state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-input-"));
  directories.push(directory);
  const credentials = join(directory, "signup", "credentials.json");
  const signup = vi.spyOn(AgentWorkplace.prototype, "signup");
  expect(
    await run([
      ...["--credentials", credentials, "signup", "--name", "Agent"],
      ...["--owner-email", "owner@example.test"],
      ...["--mailbox-name", "x".repeat(49)],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: `error: option '--mailbox-name <label>' argument '${"x".repeat(49)}' is invalid. Use 3 to 48 characters.\n`,
  });
  expect(signup).not.toHaveBeenCalled();
  await expect(readdir(directory)).resolves.toEqual([]);
});

test("feedback offers a retry only after a submission was sent", async () => {
  const { credentials, directory } = await fixture();
  const submit = vi.spyOn(AgentWorkplace.prototype, "submitFeedback");
  expect(
    await run([
      ...["--credentials", credentials, "feedback", "send"],
      ...["--message-file", join(directory, "missing.txt")],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: "Error: Unable to read the feedback message file\n",
  });
  expect(
    await run([
      ...["--credentials", credentials, "feedback", "send"],
      ...["--message", "Hello", "--submission-id", "not-a-uuid"],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "error: option '--submission-id <id>' argument 'not-a-uuid' is invalid. Use a UUID.\n",
  });
  expect(submit).not.toHaveBeenCalled();
});

test("the owner handoff names an invalid dashboard URL", async () => {
  expect(
    await run([
      ...["owner-email-handoff", "--dashboard-url", "https://app.example/x"],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "Error: --dashboard-url must be an HTTPS dashboard origin with no path, or HTTP on loopback\n",
  });
});

test("organizing requires a change and a folder requires a name", async () => {
  const { credentials, directory } = await fixture();
  const organize = vi.spyOn(AgentWorkplace.prototype, "organizeFiles");
  const operation = join(directory, "operations", "organize.json");
  expect(
    await run([
      ...["--credentials", credentials, "files", "organize", randomUUID()],
      ...["--expected-version", randomUUID(), "--operation", operation],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: "Error: Provide --name, --parent or both to organize an entry\n",
  });
  expect(
    await run([
      ...["--credentials", credentials, "files", "folders", "create"],
      ...["--name", " ", "--operation", operation],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: "Error: Provide a folder --name\n",
  });
  expect(organize).not.toHaveBeenCalled();
});

test("a shared operation directory names its path and the fix", async () => {
  const { credentials, directory } = await fixture();
  const shared = join(directory, "shared");
  await mkdir(shared);
  await chmod(shared, 0o755);
  const body = join(directory, "body.txt");
  await writeFile(body, "Hello\n");
  expect(
    await run([
      ...["--credentials", credentials, "mail", "send"],
      ...["--operation", join(shared, "send.json"), "--to", "a@example.test"],
      ...["--subject", "Hello", "--body-file", body],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: `Error: Mail operation files and directories must be owned by you and accessible only to you; make ${shared} yours and run chmod 700 on it\n`,
  });
});
