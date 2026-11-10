import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-shortcuts-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    mailboxId = randomUUID();
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
    mailbox: { mailboxId, accountId, address: "a@awmail.ai" },
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const run = async (arguments_: string[], stdin?: string) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(["--credentials", credentials, ...arguments_], {
      version: "0.0.0",
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
      ...(stdin === undefined
        ? {}
        : {
            input: (async function* () {
              yield stdin;
            })(),
          }),
    });
    return { code, stdout, stderr };
  };
  return { directory, accountId, mailboxId, run };
}

function sourceMessage(subject: string | undefined) {
  return vi
    .spyOn(AgentWorkplace.prototype, "getMailMessage")
    .mockResolvedValue({
      display: subject === undefined ? {} : { subject },
    } as Awaited<ReturnType<AgentWorkplace["getMailMessage"]>>);
}

test("replies and forwards default their subject from the source message", async () => {
  const f = await fixture();
  const compose = vi
    .spyOn(AgentWorkplace.prototype, "composeMail")
    .mockResolvedValue({ state: "queued" } as unknown as Awaited<
      ReturnType<AgentWorkplace["composeMail"]>
    >);
  const message = randomUUID();
  for (const [command, source, expected] of [
    ["reply", "Hello", "Re: Hello"],
    ["reply-all", "RE: Hello", "RE: Hello"],
    ["forward", "Re: Hello", "Fwd: Re: Hello"],
    ["forward", "FW: Hello", "FW: Hello"],
  ] as const) {
    const read = sourceMessage(source);
    const result = await f.run(
      [
        ...["mail", command, "--message", message, "--body-file", "-"],
        ...(command === "forward" ? ["--to", "c@example.test"] : []),
        ...["--operation", join(f.directory, "ops", `${randomUUID()}.json`)],
        "--json",
      ],
      "Thanks.\n",
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(read).toHaveBeenCalledWith({ apiKey: "private" }, message, {
      mailboxId: f.mailboxId,
    });
    expect(compose.mock.lastCall?.[1]).toMatchObject({
      subject: expected,
      text: "Thanks.\n",
    });
  }
  sourceMessage(undefined);
  expect(
    await f.run(
      [
        ...["mail", "reply", "--message", message, "--body-file", "-"],
        ...["--operation", join(f.directory, "ops", "none.json")],
      ],
      "Thanks.\n",
    ),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "Error: The source message has no retained subject; pass --subject\n",
  });
});

test("mail send and chat post read their text from stdin with -", async () => {
  const f = await fixture();
  const send = vi
    .spyOn(AgentWorkplace.prototype, "sendMail")
    .mockResolvedValue({ state: "queued" } as unknown as Awaited<
      ReturnType<AgentWorkplace["sendMail"]>
    >);
  expect(
    await f.run(
      [
        ...["mail", "send", "--to", "b@example.test", "--subject", "Hi"],
        ...["--body-file", "-", "--operation", join(f.directory, "send.json")],
        "--json",
      ],
      "From stdin\n",
    ),
  ).toMatchObject({ code: 0, stderr: "" });
  expect(send.mock.lastCall?.[1]).toMatchObject({ text: "From stdin\n" });

  const post = vi
    .spyOn(AgentWorkplace.prototype, "postChatMessage")
    .mockResolvedValue({ state: "posted" } as unknown as Awaited<
      ReturnType<AgentWorkplace["postChatMessage"]>
    >);
  expect(
    await f.run(
      [
        ...["chat", "post", "--id", randomUUID(), "--text-file", "-"],
        ...["--operation", join(f.directory, "post.json"), "--json"],
      ],
      "Chat from stdin",
    ),
  ).toMatchObject({ code: 0, stderr: "" });
  expect(post.mock.lastCall?.[2]).toMatchObject({ text: "Chat from stdin" });
});

test("role show defaults to the current account", async () => {
  const f = await fixture();
  const role = vi
    .spyOn(AgentWorkplace.prototype, "getParticipantRole")
    .mockResolvedValue({ role: "admin" } as unknown as Awaited<
      ReturnType<AgentWorkplace["getParticipantRole"]>
    >);
  expect(await f.run(["role", "show", "--json"])).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ role: "admin" })}\n`,
    stderr: "",
  });
  expect(role).toHaveBeenCalledWith({ apiKey: "private" }, f.accountId);
});

test("human invitation link files default the dashboard like agent links", async () => {
  const f = await fixture();
  const create = vi.spyOn(AgentWorkplace.prototype, "createHumanInvitation");
  expect(
    await f.run([
      ...["invitations", "create-human", "--email", "h@example.test"],
      ...["--invitation-link-file", join(f.directory, "link.txt")],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "Error: Specify --dashboard-url for invitation links outside production\n",
  });
  expect(
    await f.run([
      ...["invitations", "create-human", "--email", "h@example.test"],
      ...["--dashboard-url", "https://app.example.test"],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr: "Error: --dashboard-url applies only with --invitation-link-file\n",
  });
  expect(create).not.toHaveBeenCalled();
});
