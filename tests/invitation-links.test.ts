import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentWorkplace,
  createAgentInvitationLink,
  createHumanInvitationLink,
  parseAgentInvitationLink,
} from "@agent-workplace/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const api = "https://api.example.test";
const dashboard = "https://app.example.test";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function* stream(text: string) {
  yield text;
}

async function fixture(origin = api, dashboardOrigin = dashboard) {
  vi.stubEnv("AGENT_WORKPLACE_API_URL", origin === api ? api : undefined);
  const directory = await mkdtemp(join(tmpdir(), "awp-invitation-link-"));
  directories.push(directory);
  const credentials = join(directory, "account.json");
  const record = {
    version: 1 as const,
    kind: "invitation" as const,
    origin,
    invitationId: randomUUID(),
    workplaceId: randomUUID(),
    accountId: randomUUID(),
    code: randomBytes(32).toString("base64url"),
  };
  const link = createAgentInvitationLink(record, { dashboardOrigin });
  const mailbox = {
    accountId: record.accountId,
    mailboxId: randomUUID(),
    address: "agent@example.test",
  };
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue({
    accountId: record.accountId,
    workplaceId: record.workplaceId,
    role: "member",
    mailbox,
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const preview = vi
    .spyOn(AgentWorkplace.prototype, "previewInvitation")
    .mockResolvedValue({
      id: record.invitationId,
      workplaceId: record.workplaceId,
      accountId: record.accountId,
      issuerId: randomUUID(),
      kind: "agent",
      role: "member",
      name: "Research partner",
      state: "pending",
      createdAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-18T00:00:00.000Z",
      workplaceName: "Workplace",
    });
  const redeem = vi
    .spyOn(AgentWorkplace.prototype, "redeemAgentInvitation")
    .mockImplementation(async (input) => ({
      invitationId: record.invitationId,
      handoffId: input.handoffId,
      workplaceId: record.workplaceId,
      accountId: record.accountId,
      role: "member",
      recoveryExpiresAt: "2026-10-18T00:00:00.000Z",
      mailbox,
      credential: { id: randomUUID(), key: "private-admission-key" },
    }));
  const acknowledge = vi
    .spyOn(AgentWorkplace.prototype, "acknowledgeInvitation")
    .mockResolvedValue({ acknowledged: true });
  async function run(args: string[], input?: string) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["--credentials", credentials, ...args], {
      version: "0.0.0",
      ...(input === undefined ? {} : { input: stream(input) }),
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    });
    expect(stdout + stderr).not.toContain(record.code);
    return { code, stdout, stderr };
  }
  return {
    directory,
    credentials,
    record,
    link,
    preview,
    redeem,
    acknowledge,
    run,
  };
}

describe("agent invitation links for recipients", () => {
  it("joins from a link on stdin and retries from the saved attempt without the link", async () => {
    const f = await fixture();
    f.redeem.mockRejectedValueOnce(new Error("Connection lost"));
    const join = ["invitations", "join", "--dashboard-url", dashboard];
    const first = await f.run(
      [...join, "--link", "-", "--json"],
      `${f.link}\n`,
    );
    expect(first.code).toBe(1);
    const attempt = JSON.parse(
      await readFile(`${f.credentials}.invitation.json`, "utf8"),
    );
    expect(attempt).toMatchObject({
      phase: "pending",
      origin: api,
      code: f.record.code,
    });
    const retry = await f.run(["invitations", "join", "--json"]);
    expect(retry.code).toBe(0);
    expect(f.redeem).toHaveBeenCalledTimes(2);
    expect(f.redeem.mock.calls[1]![0]).toMatchObject({
      invitationId: f.record.invitationId,
      code: f.record.code,
      handoffId: attempt.handoffId,
      recoveryProof: attempt.recoveryProof,
    });
    expect(f.acknowledge).toHaveBeenCalledOnce();
    expect(JSON.parse(retry.stdout)).toMatchObject({
      accountId: f.record.accountId,
      requestedMailboxChoiceApplied: true,
    });
    expect((await stat(f.credentials)).mode & 0o777).toBe(0o600);
  });

  it("previews from a private link file and rejects a readable one", async () => {
    const f = await fixture();
    const path = join(f.directory, "invite.txt");
    await writeFile(path, `${f.link}\n`, { mode: 0o600 });
    const args = [
      "invitations",
      "preview",
      "--link-file",
      path,
      "--dashboard-url",
      dashboard,
      "--json",
    ];
    const result = await f.run(args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: "Research partner",
    });
    expect(f.preview).toHaveBeenCalledWith({
      invitationId: f.record.invitationId,
      code: f.record.code,
    });
    await chmod(path, 0o644);
    expect((await f.run(args)).code).toBe(1);
    expect(f.preview).toHaveBeenCalledOnce();
  });

  it("defaults the dashboard origin only for the production API", async () => {
    const f = await fixture(
      "https://api.agentworkplace.dev",
      "https://app.agentworkplace.dev",
    );
    const result = await f.run(
      ["invitations", "preview", "--link", "-", "--json"],
      f.link,
    );
    expect(result.code).toBe(0);
    expect(f.preview).toHaveBeenCalledOnce();
  });

  it("requires a dashboard origin outside production", async () => {
    const f = await fixture();
    const missing = await f.run(
      ["invitations", "preview", "--link", "-", "--json"],
      f.link,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--dashboard-url");
    expect(f.preview).not.toHaveBeenCalled();
  });

  it.each([
    ["a link passed as an argument", (link: string) => [["--link", link]]],
    [
      "two invitation inputs",
      () => [["--link", "-", "--invitation-file", "/tmp/unused.json"]],
    ],
    [
      "a lookalike dashboard",
      () => [
        ["--link", "-", "--dashboard-url", "https://app.example.test.evil"],
      ],
    ],
    ["a dashboard URL without a link", () => [["--dashboard-url", dashboard]]],
  ])("rejects %s without contacting the API", async (_label, options) => {
    const f = await fixture();
    const [extra] = options(f.link);
    for (const command of ["preview", "join"]) {
      const result = await f.run(
        ["invitations", command, ...extra!, "--json"],
        f.link,
      );
      expect(result.code).toBe(1);
    }
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.redeem).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a link for another API",
      (record: Parameters<typeof createAgentInvitationLink>[0]) =>
        createAgentInvitationLink(
          { ...record, origin: "https://api.other.test" },
          { dashboardOrigin: dashboard },
        ),
    ],
    ["an empty stream", () => ""],
    ["an oversized stream", () => "x".repeat(8193)],
  ])("rejects %s before redemption", async (_label, link) => {
    const f = await fixture();
    const input = link(f.record);
    const result = await f.run(
      [
        "invitations",
        "join",
        "--link",
        "-",
        "--dashboard-url",
        dashboard,
        "--json",
      ],
      input,
    );
    expect(result.code).toBe(1);
    expect(f.redeem).not.toHaveBeenCalled();
  });

  it("rejects a human invitation link", async () => {
    const f = await fixture();
    const human = createHumanInvitationLink(
      { ...f.record, kind: "human-invitation" },
      { dashboardOrigin: dashboard },
    );
    const result = await f.run(
      [
        "invitations",
        "join",
        "--link",
        "-",
        "--dashboard-url",
        dashboard,
        "--json",
      ],
      human,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid agent invitation link");
    expect(f.redeem).not.toHaveBeenCalled();
  });
});

describe("agent invitation links for administrators", () => {
  async function adminFixture() {
    const f = await fixture();
    await withCredentials(f.credentials, (store) =>
      store.write({
        version: 1,
        kind: "account",
        origin: api,
        credential: {
          // The fixture's account status reports this identity.
          accountId: f.record.accountId,
          workplaceId: f.record.workplaceId,
          key: "admin-key",
        },
      }),
    );
    const create = vi
      .spyOn(AgentWorkplace.prototype, "createAgentInvitation")
      .mockResolvedValue({
        id: f.record.invitationId,
        workplaceId: f.record.workplaceId,
        accountId: f.record.accountId,
        issuerId: randomUUID(),
        kind: "agent",
        name: "Research partner",
        role: "member",
        state: "pending",
        createdAt: "2026-10-11T00:00:00.000Z",
        expiresAt: "2026-10-18T00:00:00.000Z",
        code: f.record.code,
      });
    const args = ["invitations", "create", "--name", "Research partner"];
    return { ...f, create, args, path: join(f.directory, "invite.txt") };
  }

  it("writes the link only to a new private file", async () => {
    const f = await adminFixture();
    const output = [
      ...f.args,
      "--invitation-link-file",
      f.path,
      "--dashboard-url",
      dashboard,
      "--json",
    ];
    const result = await f.run(output);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      invitationId: f.record.invitationId,
      accountId: f.record.accountId,
      workplaceId: f.record.workplaceId,
      role: "member",
      expiresAt: "2026-10-18T00:00:00.000Z",
      invitationLinkFile: f.path,
    });
    const text = await readFile(f.path, "utf8");
    expect(
      parseAgentInvitationLink(text.trimEnd(), {
        dashboardOrigin: dashboard,
        apiOrigin: api,
      }),
    ).toEqual(f.record);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await f.run(output)).code).toBe(1);
    expect(f.create).toHaveBeenCalledOnce();
  });

  it.each([
    ["no output file", () => ["--json"]],
    [
      "both output files",
      (path: string) => [
        "--invitation-link-file",
        path,
        "--invitation-file",
        `${path}.json`,
        "--dashboard-url",
        dashboard,
      ],
    ],
    [
      "a dashboard URL for a legacy file",
      (path: string) => [
        "--invitation-file",
        path,
        "--dashboard-url",
        dashboard,
      ],
    ],
    [
      "a missing dashboard outside production",
      (path: string) => ["--invitation-link-file", path],
    ],
    [
      "a non-canonical dashboard",
      (path: string) => [
        "--invitation-link-file",
        path,
        "--dashboard-url",
        "http://app.example.test",
      ],
    ],
  ])("rejects %s before issuance", async (_label, extra) => {
    const f = await adminFixture();
    const result = await f.run([...f.args, ...extra(f.path), "--json"]);
    expect(result.code).toBe(1);
    expect(f.create).not.toHaveBeenCalled();
  });
});
