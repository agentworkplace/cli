import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { executeMailSend } from "../src/commands/mail.js";
import { runCli } from "../src/program.js";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-mail-send-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const operation = join(directory, "send.json");
  const bodyFile = join(directory, "body.txt");
  await writeFile(bodyFile, "explicitly requested body", { mode: 0o600 });
  const status = {
    accountId: randomUUID(),
    workplaceId: randomUUID(),
    mailbox: {
      accountId: "",
      mailboxId: randomUUID(),
      address: "fixture@mail.agentworkplace.dev",
    },
  };
  status.mailbox.accountId = status.accountId;
  const state = {
    version: 1 as const,
    kind: "account" as const,
    origin: "https://api.example.test",
    credential: {
      accountId: status.accountId,
      workplaceId: status.workplaceId,
      key: "private-key",
    },
  };
  await withCredentials(credentials, (store) => store.write(state));
  const statusMock = vi
    .spyOn(AgentWorkplace.prototype, "accountStatus")
    .mockResolvedValue(
      status as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>,
    );
  const result = {
    operationId: randomUUID(),
    mailboxId: status.mailbox.mailboxId,
    state: "queued" as const,
    contentRetained: true,
    receipt: {
      available: true as const,
      createdAt: new Date().toISOString(),
      firstClaimAt: null,
      acceptanceObservedAt: null,
      stoppedAt: null,
      submissions: 0,
    },
  };
  const send = vi
    .spyOn(AgentWorkplace.prototype, "sendMail")
    .mockImplementation(async (_auth, request) => ({
      ...result,
      operationId: request.operationId,
    }));
  const read = vi
    .spyOn(AgentWorkplace.prototype, "getMailOperation")
    .mockImplementation(async (_auth, operationId) => ({
      ...result,
      operationId,
    }));
  const invoke = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      ["--credentials", credentials, "mail", ...args, "--json"],
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
  const initial = [
    "send",
    "--operation",
    operation,
    "--to",
    "requested@example.test",
    "--subject",
    "Demo",
    "--body-file",
    bodyFile,
  ];
  return {
    directory,
    credentials,
    operation,
    bodyFile,
    status,
    statusMock,
    state,
    result,
    send,
    read,
    invoke,
    initial,
  };
}

test("CLI durably saves before a lost response, retries unchanged and reads status without sending", async () => {
  const f = await fixture();
  f.send.mockImplementationOnce(async (_auth, request) => {
    expect(JSON.parse(await readFile(f.operation, "utf8")).request).toEqual(
      request,
    );
    expect((await stat(f.operation)).mode & 0o777).toBe(0o600);
    throw new Error("lost response with private details");
  });
  const failed = await f.invoke(f.initial);
  expect(failed.code).not.toBe(0);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).not.toContain("private details");
  const stored = await readFile(f.operation, "utf8");
  const saved = JSON.parse(stored);
  expect(saved).toMatchObject({
    version: 1,
    origin: f.state.origin,
    workplaceId: f.status.workplaceId,
    accountId: f.status.accountId,
    request: {
      mailboxId: f.status.mailbox.mailboxId,
      text: "explicitly requested body",
    },
  });
  expect(stored).not.toContain("private-key");
  // A new invocation and rotated key use the same account binding and operation.
  await withCredentials(f.credentials, (store) =>
    store.write({
      ...f.state,
      credential: { ...f.state.credential, key: "rotated-key" },
    }),
  );
  const retried = await f.invoke(["send", "--operation", f.operation]);
  expect(retried).toEqual({
    code: 0,
    stdout:
      JSON.stringify({ ...f.result, operationId: saved.request.operationId }) +
      "\n",
    stderr: "",
  });
  expect(f.send.mock.calls[1]).toEqual([
    { apiKey: "rotated-key" },
    saved.request,
  ]);
  expect(await readFile(f.operation, "utf8")).toBe(stored);
  const read = await f.invoke(["status", "--operation", f.operation]);
  expect(read).toEqual(retried);
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.read).toHaveBeenCalledExactlyOnceWith(
    { apiKey: "rotated-key" },
    saved.request.operationId,
  );
});

test("CLI refuses changed intent, unsafe files and foreign bindings without sending", async () => {
  const f = await fixture();
  expect((await f.invoke(f.initial)).code).toBe(0);
  const stored = await readFile(f.operation, "utf8");
  for (const extra of [
    ["--to", "other@example.test"],
    ["--subject", "Changed"],
    ["--mailbox", randomUUID()],
  ]) {
    expect(
      (await f.invoke(["send", "--operation", f.operation, ...extra])).code,
    ).not.toBe(0);
  }
  await writeFile(f.bodyFile, "changed content");
  expect((await f.invoke(f.initial)).code).not.toBe(0);
  await chmod(f.operation, 0o644);
  expect((await f.invoke(["send", "--operation", f.operation])).code).not.toBe(
    0,
  );
  await chmod(f.operation, 0o600);
  const link = join(f.directory, "link.json");
  await symlink(f.operation, link);
  expect((await f.invoke(["send", "--operation", link])).code).not.toBe(0);
  const other = {
    ...f.state,
    credential: { ...f.state.credential, accountId: randomUUID() },
  };
  await withCredentials(f.credentials, (store) => store.write(other));
  f.statusMock.mockResolvedValue({
    ...f.status,
    accountId: other.credential.accountId,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  expect((await f.invoke(["send", "--operation", f.operation])).code).not.toBe(
    0,
  );
  expect(
    (await f.invoke(["status", "--operation", f.operation])).code,
  ).not.toBe(0);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.read).not.toHaveBeenCalled();
  expect(await readFile(f.operation, "utf8")).toBe(stored);
});

test("CLI rejects missing or oversized first input and status never creates an operation", async () => {
  const f = await fixture();
  expect(
    (await f.invoke(["status", "--operation", f.operation])).code,
  ).not.toBe(0);
  expect((await f.invoke(["send", "--operation", f.operation])).code).not.toBe(
    0,
  );
  await writeFile(f.bodyFile, "é".repeat(131073));
  expect((await f.invoke(f.initial)).code).not.toBe(0);
  await writeFile(f.bodyFile, new Uint8Array([0xff]));
  expect((await f.invoke(f.initial)).code).not.toBe(0);
  await expect(stat(f.operation)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

test("concurrent credentials for one account cannot replace the same operation file", async () => {
  const f = await fixture();
  const otherCredentials = join(f.directory, "other-credentials.json");
  await withCredentials(otherCredentials, (store) => store.write(f.state));
  const options = {
    operation: f.operation,
    to: "requested@example.test",
    subject: "Demo",
    bodyFile: f.bodyFile,
    json: true,
    write: vi.fn(),
  };
  await Promise.all(
    [f.credentials, otherCredentials].map((credentials) =>
      executeMailSend({ ...options, credentials }),
    ),
  );
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[0]![1]).toEqual(f.send.mock.calls[1]![1]);
});

test.skipIf(process.platform === "win32")(
  "non-regular body files are rejected without waiting for a writer",
  async () => {
    const f = await fixture();
    await rm(f.bodyFile);
    execFileSync("mkfifo", [f.bodyFile]);
    expect((await f.invoke(f.initial)).code).not.toBe(0);
    expect(f.send).not.toHaveBeenCalled();
    await expect(stat(f.operation)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("freezes repeated To/Cc/Bcc options before transport and rejects hidden-recipient changes on retry", async () => {
  const f = await fixture();
  const args = [
    ...f.initial,
    "--to",
    "second@example.test",
    "--cc",
    "copy@example.test",
    "--bcc",
    "hidden@example.test",
  ];
  const first = await f.invoke(args);
  expect({ code: first.code, stderr: first.stderr }).toEqual({
    code: 0,
    stderr: "",
  });
  const saved = JSON.parse(await readFile(f.operation, "utf8"));
  expect(saved.request).toMatchObject({
    to: ["requested@example.test", "second@example.test"],
    cc: ["copy@example.test"],
    bcc: ["hidden@example.test"],
  });
  expect(first.stdout).not.toContain("hidden@example.test");
  expect((await f.invoke(["send", "--operation", f.operation])).code).toBe(0);
  expect(f.send.mock.calls[1]![1]).toEqual(saved.request);
  const changed = await f.invoke([
    "send",
    "--operation",
    f.operation,
    "--bcc",
    "changed@example.test",
  ]);
  expect(changed.code).toBe(1);
  expect(changed.stdout).toBe("");
  expect(changed.stderr).not.toContain("hidden@example.test");
  expect(f.send).toHaveBeenCalledTimes(2);
});
test("rejects visible/Bcc overlap before saving or submitting", async () => {
  const f = await fixture();
  expect(
    (await f.invoke([...f.initial, "--bcc", "requested@example.test"])).code,
  ).toBe(1);
  expect(f.send).not.toHaveBeenCalled();
  await expect(readFile(f.operation)).rejects.toMatchObject({ code: "ENOENT" });
});

test("attachment selections persist before a lost response and recover without the input file", async () => {
  const f = await fixture();
  const attachmentsFile = join(f.directory, "attachments.json");
  const selection = [
    {
      kind: "files",
      workplaceId: f.status.workplaceId,
      fileId: randomUUID(),
      revisionId: randomUUID(),
    },
    {
      kind: "mail",
      workplaceId: f.status.workplaceId,
      mailboxId: f.status.mailbox.mailboxId,
      messageId: randomUUID(),
      attachmentId: randomUUID(),
    },
  ];
  await writeFile(attachmentsFile, JSON.stringify(selection), { mode: 0o600 });
  f.send.mockImplementationOnce(async (_auth, request) => {
    expect(JSON.parse(await readFile(f.operation, "utf8")).request).toEqual(
      request,
    );
    expect(request.attachments).toEqual(selection);
    throw new Error("lost response with private details");
  });
  const lost = await f.invoke([
    ...f.initial,
    "--attachments-file",
    attachmentsFile,
  ]);
  expect(lost.code).toBe(1);
  expect(lost.stdout).toBe("");
  expect(lost.stderr).not.toContain(selection[0]!.fileId);
  const saved = await readFile(f.operation, "utf8");
  expect((await stat(f.operation)).mode & 0o777).toBe(0o600);
  await rm(attachmentsFile);
  await rm(f.bodyFile);
  expect((await f.invoke(["send", "--operation", f.operation])).code).toBe(0);
  expect(f.send.mock.calls[1]![1]).toEqual(f.send.mock.calls[0]![1]);
  expect((await f.invoke(["status", "--operation", f.operation])).code).toBe(0);
  await writeFile(attachmentsFile, JSON.stringify([...selection].reverse()));
  const changed = await f.invoke([
    "send",
    "--operation",
    f.operation,
    "--attachments-file",
    attachmentsFile,
  ]);
  expect(changed.code).toBe(1);
  expect(changed.stdout).toBe("");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(await readFile(f.operation, "utf8")).toBe(saved);
});

test.each([
  "empty",
  "too_many",
  "url",
  "latest",
  "oversize",
  "utf8",
  "symlink",
] as const)(
  "rejects %s attachment input without saving or sending",
  async (mode) => {
    const f = await fixture();
    const path = join(f.directory, "selection.json");
    const part = {
      kind: "files",
      workplaceId: f.status.workplaceId,
      fileId: randomUUID(),
      revisionId: randomUUID(),
    };
    const value =
      mode === "empty"
        ? []
        : mode === "too_many"
          ? Array(11).fill(part)
          : mode === "url"
            ? [{ ...part, url: "https://private.example.test/value" }]
            : mode === "latest"
              ? [{ ...part, revisionId: "latest" }]
              : [part];
    if (mode === "symlink") {
      await writeFile(path + ".target", JSON.stringify(value));
      await symlink(path + ".target", path);
    } else
      await writeFile(
        path,
        mode === "oversize"
          ? " ".repeat(16_385)
          : mode === "utf8"
            ? Buffer.from([0xff])
            : JSON.stringify(value),
      );
    const result = await f.invoke([...f.initial, "--attachments-file", path]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private.example.test");
    expect(f.send).not.toHaveBeenCalled();
    await expect(stat(f.operation)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
