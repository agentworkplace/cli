import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace, AgentWorkplaceError } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { executeSignup } from "../src/commands/access.js";
import { runCli } from "../src/program.js";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function file() {
  const directory = await mkdtemp(join(tmpdir(), "awp-mail-cli-"));
  directories.push(directory);
  return join(directory, "credentials.json");
}
test("mail commands preserve exact JSON streams and old account credential files", async () => {
  const path = await file();
  const accountId = randomUUID(),
    workplaceId = randomUUID();
  const mailbox = {
    mailboxId: randomUUID(),
    accountId,
    address: "sample@mail.agentworkplace.dev",
  };
  await withCredentials(path, (store) =>
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
    mailbox,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  let stdout = "",
    stderr = "";
  const code = await runCli(
    ["--credentials", path, "mail", "address", "--json"],
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
  expect({ code, stdout, stderr }).toEqual({
    code: 0,
    stdout: JSON.stringify(mailbox) + "\n",
    stderr: "",
  });
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty(
    "bootstrapProof",
  );
});
test("CLI keeps bootstrap proof before request, scrubs a conflicted label and explicitly reselects with the saved revision", async () => {
  const path = await file();
  const options = {
    credentials: path,
    baseUrl: "https://api.example.test",
    name: "Agent",
    ownerEmail: "owner@example.test",
    json: true,
    write: vi.fn(),
  };
  const signup = vi
    .spyOn(AgentWorkplace.prototype, "signup")
    .mockImplementation(async () => {
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.bootstrapProof).toHaveLength(43);
      throw new AgentWorkplaceError("Address unavailable", {
        status: 409,
        code: "address_unavailable",
        choiceRevision: 1,
      });
    });
  await expect(
    executeSignup({ ...options, mailboxName: "conflicted" }),
  ).rejects.toMatchObject({ code: "address_unavailable" });
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved).not.toHaveProperty("mailboxAddressChoice");
  expect(saved.mailboxChoiceRevision).toBe(1);
  await expect(
    executeSignup({ ...options, mailboxDefault: true }),
  ).rejects.toThrow();
  expect(signup.mock.calls[1]![0]).toMatchObject({
    bootstrapProof: saved.bootstrapProof,
    mailboxAddressChoice: { kind: "automatic" },
    expectedChoiceRevision: 1,
  });
});

test("signup shows the permanent assigned mailbox on fresh and recovered human output without changing JSON", async () => {
  const path = await file();
  const accountId = randomUUID();
  const workplaceId = randomUUID();
  const address = "acornapple03@mail.agentworkplace.dev";
  const status = {
    accountId,
    workplaceId,
    workplaceState: "unconfirmed",
    cleanupAt: "2026-10-25T00:00:00.000Z",
    nomination: {
      id: randomUUID(),
      email: "private-owner@example.test",
      deliveryState: "accepted",
      expiresAt: "2026-09-25T00:10:00.000Z",
    },
    mailbox: { mailboxId: randomUUID(), accountId, address },
  } as Awaited<ReturnType<AgentWorkplace["accessStatus"]>>;
  const signup = vi
    .spyOn(AgentWorkplace.prototype, "signup")
    .mockResolvedValue({
      accountId,
      workplaceId,
      credential: { id: randomUUID(), key: "private-signup-key" },
    } as Awaited<ReturnType<AgentWorkplace["signup"]>>);
  vi.spyOn(AgentWorkplace.prototype, "acknowledgeSignup").mockResolvedValue(
    {} as Awaited<ReturnType<AgentWorkplace["acknowledgeSignup"]>>,
  );
  const access = vi
    .spyOn(AgentWorkplace.prototype, "accessStatus")
    .mockResolvedValue(status);
  const write = vi.fn();
  const options = {
    credentials: path,
    baseUrl: "https://api.example.test",
    name: "Display name",
    ownerEmail: "owner@example.test",
    json: false,
    write,
  };
  await executeSignup(options);
  const human = write.mock.calls[0]![0] as string;
  expect(human).toContain(
    `Mailbox address: ${address}\nThis address is permanent and cannot be renamed.`,
  );
  expect(human).not.toContain("private-signup-key");
  expect(human).not.toContain("bootstrapProof");
  expect(human).toContain("Cleanup deadline: 2026-10-25T00:00:00.000Z");
  expect(human).toContain("Nomination delivery: accepted");
  expect(human).toContain("Next: Read the nomination ID from status");
  expect(human).not.toContain("private-owner@example.test");
  write.mockClear();
  await executeSignup(options);
  expect(write).toHaveBeenCalledWith(human);
  expect(signup).toHaveBeenCalledTimes(1);
  write.mockClear();
  await executeSignup({ ...options, json: true });
  expect(write).toHaveBeenCalledWith(`${JSON.stringify(status)}\n`);
  for (const deliveryState of ["failed", "uncertain"] as const) {
    access.mockResolvedValue({
      ...status,
      nomination: { ...status.nomination!, deliveryState },
    });
    write.mockClear();
    await executeSignup(options);
    expect(write.mock.calls[0]![0]).toContain(
      `Nomination delivery: ${deliveryState}`,
    );
    expect(write.mock.calls[0]![0]).toContain(
      deliveryState === "failed"
        ? "Next: Check status, then resend the nomination if appropriate."
        : "Next: Check status before retrying nomination delivery.",
    );
  }
  access.mockResolvedValue({ ...status, mailbox: undefined });
  write.mockClear();
  await executeSignup(options);
  expect(write.mock.calls[0]![0]).toContain(
    "Mailbox address: unavailable; check account-status or mail address",
  );
  expect(write.mock.calls[0]![0]).not.toContain(address);
});

test("new-session read/list/omissions use the SDK, preserve JSON and escape all untrusted human-output fields", async () => {
  const path = await file();
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    mailboxId = randomUUID(),
    messageId = randomUUID();
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const content =
    "\ufeff\0reply\r\n\u001b]8;;https://untrusted.example\u0007link\u009b\u2028\u202e";
  const message = {
    messageId,
    mailboxId,
    direction: "incoming" as const,
    operationId: null,
    createdAt: "2026-09-14T00:00:00.123456Z",
    trashedAt: null,
    retainedBytes: Buffer.byteLength(content),
    display: { subject: "Spoof\u009b\u2028\u202e" },
    metadataOmissions: [],
    attachmentOmissions: 0,
    text: { state: "present" as const, content },
    html: { state: "absent" as const },
  };
  const read = vi
    .spyOn(AgentWorkplace.prototype, "getMailMessage")
    .mockResolvedValue(message);
  const list = vi
    .spyOn(AgentWorkplace.prototype, "listMailMessages")
    .mockResolvedValue({ messages: [], nextCursor: null });
  const omissions = vi
    .spyOn(AgentWorkplace.prototype, "listMailOmissions")
    .mockResolvedValue({ omissions: [], nextCursor: null });
  const run = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(["--credentials", path, "mail", ...args], {
      version: "0.0.0",
      writeOut: (v) => {
        stdout += v;
      },
      writeErr: (v) => {
        stderr += v;
      },
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return stdout;
  };
  const json = await run(["read", messageId, "--mailbox", mailboxId, "--json"]);
  expect(json).toBe(JSON.stringify(message) + "\n");
  expect(read).toHaveBeenCalledWith({ apiKey: "private" }, messageId, {
    mailboxId,
  });
  const human = await run(["read", messageId]);
  for (const control of ["\u001b", "\u0007", "\u009b", "\u2028", "\u202e"])
    expect(human).not.toContain(control);
  expect(JSON.parse(human)).toEqual(message);
  await run([
    "list",
    "--after",
    "cursor",
    "--limit",
    "2",
    "--view",
    "trash",
    "--json",
  ]);
  expect(list).toHaveBeenCalledWith(
    { apiKey: "private" },
    { mailboxId: undefined, after: "cursor", limit: 2, view: "trash" },
  );
  await run(["omissions", "--json"]);
  expect(omissions).toHaveBeenCalledWith(
    { apiKey: "private" },
    { mailboxId: undefined, after: undefined, limit: undefined },
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    credential: { accountId, workplaceId, key: "private" },
  });
});

test("lifecycle commands use saved credentials, explicit targeting and exact acknowledgement streams", async () => {
  const path = await file();
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    messageId = randomUUID(),
    mailboxId = randomUUID();
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  for (const action of ["trash", "restore", "purge"] as const) {
    const method = vi
      .spyOn(AgentWorkplace.prototype, `${action}MailMessage`)
      .mockResolvedValue({ acknowledged: true });
    let stdout = "",
      stderr = "";
    const code = await runCli(
      [
        "--credentials",
        path,
        "mail",
        action,
        messageId,
        "--mailbox",
        mailboxId,
        "--json",
      ],
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
    expect({ code, stdout, stderr }).toEqual({
      code: 0,
      stdout: '{"acknowledged":true}\n',
      stderr: "",
    });
    expect(method).toHaveBeenCalledExactlyOnceWith(
      { apiKey: "private" },
      messageId,
      { mailboxId },
    );
  }
});

test("archive, unarchive and filters preserve exact SDK dispatch and JSON acknowledgement", async () => {
  const path = await file(),
    accountId = randomUUID(),
    workplaceId = randomUUID(),
    messageId = randomUUID();
  await withCredentials(path, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "fixture" },
    }),
  );
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const archive = vi
    .spyOn(AgentWorkplace.prototype, "archiveMailMessage")
    .mockResolvedValue({ acknowledged: true });
  const unarchive = vi
    .spyOn(AgentWorkplace.prototype, "unarchiveMailMessage")
    .mockResolvedValue({ acknowledged: true });
  const list = vi
    .spyOn(AgentWorkplace.prototype, "listMailMessages")
    .mockResolvedValue({ messages: [], nextCursor: "continue" });
  async function invoke(args: string[]) {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      ["--credentials", path, "mail", ...args, "--json"],
      {
        version: "0.0.0",
        writeOut: (v) => {
          stdout += v;
        },
        writeErr: (v) => {
          stderr += v;
        },
      },
    );
    return { code, stdout, stderr };
  }
  for (const action of ["archive", "unarchive"]) {
    expect(await invoke([action, messageId])).toEqual({
      code: 0,
      stdout: '{"acknowledged":true}\n',
      stderr: "",
    });
  }
  expect(archive).toHaveBeenCalledOnce();
  expect(unarchive).toHaveBeenCalledOnce();
  expect(
    await invoke([
      "list",
      "--view",
      "archive",
      "--direction",
      "incoming",
      "--subject",
      "100%_",
    ]),
  ).toEqual({
    code: 0,
    stdout: '{"messages":[],"nextCursor":"continue"}\n',
    stderr: "",
  });
  expect(list.mock.calls[0]![1]).toMatchObject({
    view: "archive",
    direction: "incoming",
    subject: "100%_",
  });
});

test.each(["reply", "reply-all", "forward"])(
  "%s saves immutable intent before lost response, retries and reads status without sending",
  async (command) => {
    const path = await file();
    const operation = path + ".operation",
      body = path + ".body";
    const accountId = randomUUID(),
      workplaceId = randomUUID(),
      mailboxId = randomUUID(),
      sourceMessageId = randomUUID();
    await writeFile(body, "Authored text");
    const attachmentsFile = path + ".attachments";
    const attachments = [
      {
        kind: "files",
        workplaceId,
        fileId: randomUUID(),
        revisionId: randomUUID(),
      },
    ];
    await writeFile(attachmentsFile, JSON.stringify(attachments));
    await withCredentials(path, (store) =>
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
        mailboxId,
        accountId,
        address: "agent@mail.agentworkplace.dev",
      },
    } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
    const compose = vi
      .spyOn(AgentWorkplace.prototype, "composeMail")
      .mockImplementation(async (_auth, request) => {
        const saved = JSON.parse(await readFile(operation, "utf8"));
        expect(saved).toMatchObject({ version: 2, request });
        throw new AgentWorkplaceError("Unavailable", {
          status: 503,
          code: "unavailable",
        });
      });
    const run = async (args: string[]) => {
      let stdout = "",
        stderr = "";
      const code = await runCli(
        ["--credentials", path, "mail", ...args, "--json"],
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
      return { code, stdout, stderr };
    };
    const destinations =
      command === "forward"
        ? [
            "--to",
            "one@example.test",
            "--cc",
            "copy@example.test",
            "--bcc",
            "hidden@example.test",
          ]
        : [];
    expect(
      (
        await run([
          command,
          "--operation",
          operation,
          "--message",
          sourceMessageId,
          "--subject",
          "Subject",
          "--body-file",
          body,
          "--attachments-file",
          attachmentsFile,
          ...destinations,
        ])
      ).code,
    ).not.toBe(0);
    const first = compose.mock.calls[0]![1];
    expect(first.attachments).toEqual(attachments);
    await rm(attachmentsFile);
    await run([command, "--operation", operation]);
    expect(compose.mock.calls[1]![1]).toEqual(first);
    expect(first).toMatchObject({
      kind: command.replace("-", "_"),
      sourceMessageId,
      text: "Authored text",
    });
    await run([command, "--operation", operation, "--subject", "different"]);
    await run(["send", "--operation", operation]);
    await writeFile(
      attachmentsFile,
      JSON.stringify([{ ...attachments[0], revisionId: randomUUID() }]),
    );
    const changed = await run([
      command,
      "--operation",
      operation,
      "--attachments-file",
      attachmentsFile,
    ]);
    expect(changed.code).toBe(1);
    expect(changed.stdout).toBe("");
    expect(compose).toHaveBeenCalledTimes(2);
    const status = vi
      .spyOn(AgentWorkplace.prototype, "getMailOperation")
      .mockResolvedValue({
        operationId: first.operationId,
        mailboxId,
        state: "queued",
        contentRetained: true,
        receipt: { available: false, reason: "evidence_unavailable" },
      });
    const result = await run(["status", "--operation", operation]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "queued" });
    expect(status).toHaveBeenCalledWith(
      { apiKey: "private" },
      first.operationId,
    );
    expect(compose).toHaveBeenCalledTimes(2);
  },
);

test("sender block commands use the SDK and preserve exact JSON streams", async () => {
  const path = await file(),
    accountId = randomUUID(),
    workplaceId = randomUUID(),
    mailboxId = randomUUID();
  await withCredentials(path, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "fixture" },
    }),
  );
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId,
    workplaceId,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const state = { mailboxId, sender: "Exact@example.test", blocked: true };
  const block = vi
    .spyOn(AgentWorkplace.prototype, "blockMailSender")
    .mockResolvedValue(state);
  const unblock = vi
    .spyOn(AgentWorkplace.prototype, "unblockMailSender")
    .mockResolvedValue({ ...state, blocked: false });
  const list = vi
    .spyOn(AgentWorkplace.prototype, "listMailSenderBlocks")
    .mockResolvedValue({ blocks: [], nextCursor: "next" });
  const invoke = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      ["--credentials", path, "mail", ...args, "--json"],
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
    return { code, stdout, stderr };
  };
  expect(
    await invoke(["block-sender", state.sender, "--mailbox", mailboxId]),
  ).toEqual({ code: 0, stdout: JSON.stringify(state) + "\n", stderr: "" });
  expect(block).toHaveBeenCalledWith(
    { apiKey: "fixture" },
    { sender: state.sender, mailboxId },
  );
  expect(await invoke(["unblock-sender", state.sender])).toEqual({
    code: 0,
    stdout: JSON.stringify({ ...state, blocked: false }) + "\n",
    stderr: "",
  });
  expect(unblock).toHaveBeenCalledOnce();
  expect(
    await invoke(["blocked-senders", "--after", "cursor", "--limit", "1"]),
  ).toEqual({
    code: 0,
    stdout: '{"blocks":[],"nextCursor":"next"}\n',
    stderr: "",
  });
  expect(list).toHaveBeenCalledWith(
    { apiKey: "fixture" },
    { mailboxId: undefined, after: "cursor", limit: 1 },
  );
});

test("attachment metadata command preserves SDK pagination, exact JSON and streams", async () => {
  const path = await file(),
    accountId = randomUUID(),
    workplaceId = randomUUID(),
    messageId = randomUUID();
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const page = {
    messageId,
    attachments: [],
    nextAfter: null,
    preparation: null,
  };
  const request = vi
    .spyOn(AgentWorkplace.prototype, "listMailAttachments")
    .mockResolvedValue(page);
  let stdout = "",
    stderr = "";
  const code = await runCli(
    [
      "--credentials",
      path,
      "mail",
      "attachments",
      messageId,
      "--after",
      "0",
      "--limit",
      "2",
      "--json",
    ],
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
  expect({ code, stdout, stderr }).toEqual({
    code: 0,
    stdout: JSON.stringify(page) + "\n",
    stderr: "",
  });
  expect(request).toHaveBeenCalledWith({ apiKey: "private" }, messageId, {
    mailboxId: undefined,
    after: 0,
    limit: 2,
  });
});

test("pending preparation command preserves SDK pagination, exact JSON and streams", async () => {
  const path = await file(),
    accountId = randomUUID(),
    workplaceId = randomUUID();
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const page = {
    preparations: [],
    nextCursor: null,
  };
  const request = vi
    .spyOn(AgentWorkplace.prototype, "listMailPreparations")
    .mockResolvedValue(page);
  let stdout = "",
    stderr = "";
  const code = await runCli(
    [
      "--credentials",
      path,
      "mail",
      "preparations",
      "--after",
      "opaque",
      "--limit",
      "2",
      "--json",
    ],
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
  expect({ code, stdout, stderr }).toEqual({
    code: 0,
    stdout: JSON.stringify(page) + "\n",
    stderr: "",
  });
  expect(request).toHaveBeenCalledWith(
    { apiKey: "private" },
    {
      mailboxId: undefined,
      after: "opaque",
      limit: 2,
    },
  );
});

test("attachment download publishes verified bytes without using inbound filenames or overwriting output", async () => {
  const path = await file(),
    accountId = randomUUID(),
    workplaceId = randomUUID(),
    messageId = randomUUID(),
    attachmentId = randomUUID();
  const output = join(dirname(path), "verified.txt");
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const sha256 =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const download = vi
    .spyOn(AgentWorkplace.prototype, "downloadMailAttachment")
    .mockResolvedValue({
      messageId,
      attachment: {
        attachmentId,
        ordinal: 0,
        filename: "../untrusted.txt",
        contentType: null,
        disposition: null,
        contentId: null,
        state: "retained",
        bytes: 3,
        sha256,
      },
      bytes: new TextEncoder().encode("abc"),
    });
  let stdout = "",
    stderr = "";
  const run = () =>
    runCli(
      [
        "--credentials",
        path,
        "mail",
        "download",
        messageId,
        attachmentId,
        "--output",
        output,
        "--json",
      ],
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
  expect(await run()).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    messageId,
    attachmentId,
    bytes: 3,
    sha256,
    output: await realpath(output),
  });
  expect(await readFile(output, "utf8")).toBe("abc");
  expect(download).toHaveBeenCalledWith(
    { apiKey: "private" },
    { messageId, attachmentId, mailboxId: undefined },
  );
  stdout = "";
  expect(await run()).toBe(1);
  expect(stdout).toBe("");
  expect(await readFile(output, "utf8")).toBe("abc");
});

test("Mail catch-up CLI emits independent checkpoints and explicit gaps as exact JSON", async () => {
  const path = await file();
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    mailboxId = randomUUID();
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const checkpoint = vi
    .spyOn(AgentWorkplace.prototype, "getMailCheckpoint")
    .mockResolvedValue({ checkpoint: "opaque" });
  const gap = {
    state: "gap",
    reason: "history_expired",
    baselineRequired: true,
  } as const;
  const changes = vi
    .spyOn(AgentWorkplace.prototype, "listMailChanges")
    .mockResolvedValue(gap);
  const operations = vi
    .spyOn(AgentWorkplace.prototype, "listMailOperations")
    .mockResolvedValue({ operations: [], nextCursor: null });
  for (const [args, expected] of [
    [["checkpoint"], { checkpoint: "opaque" }],
    [["changes", "--cursor", "opaque", "--limit", "1"], gap],
    [
      ["operations", "--after", mailboxId],
      { operations: [], nextCursor: null },
    ],
  ] as const) {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      [
        "--credentials",
        path,
        "mail",
        ...args,
        "--mailbox",
        mailboxId,
        "--json",
      ],
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
    expect({ code, stdout, stderr }).toEqual({
      code: 0,
      stdout: JSON.stringify(expected) + "\n",
      stderr: "",
    });
  }
  expect(checkpoint).toHaveBeenCalledWith({ apiKey: "private" }, { mailboxId });
  expect(changes).toHaveBeenCalledWith(
    { apiKey: "private" },
    { mailboxId, cursor: "opaque", limit: 1 },
  );
  expect(operations).toHaveBeenCalledWith(
    { apiKey: "private" },
    { mailboxId, after: mailboxId, limit: undefined },
  );
});

test("Mail operation status can be read by ID without an original receipt", async () => {
  const path = await file();
  const accountId = randomUUID(),
    workplaceId = randomUUID(),
    operationId = randomUUID();
  await withCredentials(path, (store) =>
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const result = {
    operationId,
    mailboxId: randomUUID(),
    state: "canceled",
    contentRetained: false,
    receipt: { available: false, reason: "expired" },
  } satisfies Awaited<ReturnType<AgentWorkplace["getMailOperation"]>>;
  const read = vi
    .spyOn(AgentWorkplace.prototype, "getMailOperation")
    .mockResolvedValue(result);
  let stdout = "",
    stderr = "";
  const code = await runCli(
    ["--credentials", path, "mail", "operation", operationId, "--json"],
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
  expect({ code, stdout, stderr }).toEqual({
    code: 0,
    stdout: JSON.stringify(result) + "\n",
    stderr: "",
  });
  expect(read).toHaveBeenCalledWith({ apiKey: "private" }, operationId);
});
