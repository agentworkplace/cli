import * as fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkplace, AgentWorkplaceError } from "@agent-workplace/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withInvitation } from "../src/invitation-file.js";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

vi.mock("node:fs/promises", { spy: true });

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-invitation-"));
  directories.push(directory);
  const credentials = join(directory, "account.json");
  const invitationFile = join(directory, "invitation.json");
  const saved = {
    version: 1 as const,
    kind: "invitation" as const,
    origin: "https://api.example.test",
    invitationId: randomUUID(),
    workplaceId: randomUUID(),
    accountId: randomUUID(),
    code: randomBytes(32).toString("base64url"),
  };
  await withInvitation(invitationFile, (store) => store.write(saved));
  const admission = {
    invitationId: saved.invitationId,
    handoffId: randomUUID(),
    workplaceId: saved.workplaceId,
    accountId: saved.accountId,
    role: "member" as const,
    recoveryExpiresAt: "2026-09-23T00:00:00.000Z",
    mailbox: {
      accountId: saved.accountId,
      mailboxId: randomUUID(),
      address: "second@example.test",
    },
    credential: { id: randomUUID(), key: "private-admission-key" },
  };
  const status = {
    accountId: saved.accountId,
    workplaceId: saved.workplaceId,
    role: "member",
    mailbox: admission.mailbox,
  };
  vi.spyOn(AgentWorkplace.prototype, "accountStatus").mockResolvedValue(
    status as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>,
  );
  const redeem = vi
    .spyOn(AgentWorkplace.prototype, "redeemAgentInvitation")
    .mockImplementation(async (input) => ({
      ...admission,
      handoffId: input.handoffId,
    }));
  const acknowledge = vi
    .spyOn(AgentWorkplace.prototype, "acknowledgeInvitation")
    .mockResolvedValue({ acknowledged: true });
  async function run(args: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["--credentials", credentials, ...args], {
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
  return {
    directory,
    credentials,
    invitationFile,
    saved,
    admission,
    status,
    redeem,
    acknowledge,
    run,
    attemptFile: `${credentials}.invitation.json`,
  };
}

describe("private invitation CLI journey", () => {
  it("issues a human bearer file privately without email or code in output", async () => {
    const f = await fixture();
    await withCredentials(f.credentials, (store) =>
      store.write({
        version: 1,
        kind: "account",
        origin: f.saved.origin,
        credential: {
          accountId: f.saved.accountId,
          workplaceId: f.saved.workplaceId,
          key: "admin-key",
        },
      }),
    );
    const create = vi
      .spyOn(AgentWorkplace.prototype, "createHumanInvitation")
      .mockResolvedValue({
        id: f.saved.invitationId,
        workplaceId: f.saved.workplaceId,
        accountId: f.saved.accountId,
        issuerId: randomUUID(),
        kind: "human",
        name: "Human",
        role: "member",
        state: "pending",
        createdAt: "2026-09-16T00:00:00.000Z",
        expiresAt: f.admission.recoveryExpiresAt,
        code: f.saved.code,
      });
    const path = join(f.directory, "human.json");
    const args = [
      "invitations",
      "create-human",
      "--email",
      "human@example.test",
      "--invitation-file",
      path,
      "--json",
    ];
    const result = await f.run(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(f.saved.code);
    expect(result.stdout).not.toContain("human@example.test");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      kind: "human-invitation",
      code: f.saved.code,
      origin: f.saved.origin,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await f.run(args)).code).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });
  it("persists proof before redemption, keeps the same attempt after loss, saves credentials before ack and scrubs after ack retry", async () => {
    const f = await fixture();
    f.redeem.mockImplementationOnce(async (input) => {
      const stored = JSON.parse(await readFile(f.attemptFile, "utf8"));
      expect(stored).toMatchObject({
        phase: "pending",
        recoveryProof: input.recoveryProof,
        handoffId: input.handoffId,
      });
      await expect(readFile(f.credentials)).rejects.toMatchObject({
        code: "ENOENT",
      });
      throw new AgentWorkplaceError("Request failed", { status: 0 });
    });
    let result = await f.run([
      "invitations",
      "join",
      "--invitation-file",
      f.invitationFile,
      "--json",
    ]);
    expect(result.code).toBe(1);
    const pending = JSON.parse(await readFile(f.attemptFile, "utf8"));
    expect((await stat(f.attemptFile)).mode & 0o777).toBe(0o600);
    f.acknowledge.mockImplementationOnce(async () => {
      const account = JSON.parse(await readFile(f.credentials, "utf8"));
      expect(account).toMatchObject({
        version: 1,
        kind: "account",
        credential: { key: f.admission.credential.key },
      });
      expect((await stat(f.credentials)).mode & 0o777).toBe(0o600);
      throw new AgentWorkplaceError("Request failed", { status: 0 });
    });
    result = await f.run(["invitations", "join", "--json"]);
    expect(result.code).toBe(1);
    expect(f.redeem.mock.calls[1]![0]).toEqual(f.redeem.mock.calls[0]![0]);
    result = await f.run(["invitations", "join", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject(f.status);
    expect(f.redeem).toHaveBeenCalledTimes(2);
    expect(f.acknowledge).toHaveBeenCalledTimes(2);
    const completed = await readFile(f.attemptFile, "utf8");
    expect(JSON.parse(completed)).toMatchObject({
      phase: "complete",
      handoffId: pending.handoffId,
    });
    for (const secret of [
      f.saved.code,
      pending.recoveryProof,
      f.admission.credential.key,
    ]) {
      expect(completed).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    expect((await f.run(["account-status", "--json"])).code).toBe(0);
  });
  it.each(["lost-ack", "complete"])(
    "does not claim a new address was applied on a saved-account %s retry",
    async (phase) => {
      const f = await fixture();
      if (phase === "lost-ack")
        f.acknowledge.mockRejectedValueOnce(
          new AgentWorkplaceError("Request failed", { status: 0 }),
        );
      expect(
        (
          await f.run([
            "invitations",
            "join",
            "--invitation-file",
            f.invitationFile,
            "--json",
          ])
        ).code,
      ).toBe(phase === "lost-ack" ? 1 : 0);
      const saved = await readFile(f.credentials, "utf8");
      const result = await f.run([
        "invitations",
        "join",
        "--mailbox-name",
        "different",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mailbox: f.admission.mailbox,
        requestedMailboxChoiceApplied: false,
      });
      expect(await readFile(f.credentials, "utf8")).toBe(saved);
      expect(f.redeem).toHaveBeenCalledOnce();
    },
  );
  it("retains recovery material and sends no acknowledgement when credential persistence fails", async () => {
    const f = await fixture();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const rename = vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === f.credentials)
        throw new Error("Synthetic credential write interruption");
      return actual.rename(from, to);
    });
    expect(
      (
        await f.run([
          "invitations",
          "join",
          "--invitation-file",
          f.invitationFile,
          "--json",
        ])
      ).code,
    ).toBe(1);
    const attempt = JSON.parse(await readFile(f.attemptFile, "utf8"));
    expect(attempt.phase).toBe("pending");
    expect(attempt.recoveryProof).toBe(
      f.redeem.mock.calls[0]![0].recoveryProof,
    );
    expect(f.acknowledge).not.toHaveBeenCalled();
    await expect(readFile(f.credentials)).rejects.toMatchObject({
      code: "ENOENT",
    });
    rename.mockRestore();
    expect((await f.run(["invitations", "join", "--json"])).code).toBe(0);
    expect(f.redeem.mock.calls[1]![0]).toEqual(f.redeem.mock.calls[0]![0]);
  });

  it("changes a rejected mailbox choice only after resolving the original attempt", async () => {
    const f = await fixture();
    f.redeem.mockRejectedValueOnce(
      new AgentWorkplaceError("Choice unavailable", {
        status: 409,
        code: "address_unavailable",
      }),
    );
    expect(
      (
        await f.run([
          "invitations",
          "join",
          "--invitation-file",
          f.invitationFile,
          "--mailbox-name",
          "taken",
          "--json",
        ])
      ).code,
    ).toBe(1);
    const pending = JSON.parse(await readFile(f.attemptFile, "utf8"));
    f.redeem.mockRejectedValueOnce(
      new AgentWorkplaceError("Choice unavailable", {
        status: 409,
        code: "address_unavailable",
      }),
    );
    expect(
      (await f.run(["invitations", "join", "--mailbox-default", "--json"]))
        .code,
    ).toBe(0);
    expect(f.redeem.mock.calls[1]![0].handoffId).toBe(pending.handoffId);
    expect(f.redeem.mock.calls[2]![0].handoffId).not.toBe(pending.handoffId);
    expect(f.redeem.mock.calls[2]![0].recoveryProof).not.toBe(
      pending.recoveryProof,
    );
    expect(f.redeem.mock.calls[2]![0].mailboxAddressChoice).toEqual({
      kind: "automatic",
    });
  });
  it("preserves an uncertain successful admission when a different address is requested", async () => {
    const f = await fixture();
    f.redeem.mockRejectedValueOnce(
      new AgentWorkplaceError("Request failed", { status: 0 }),
    );
    expect(
      (
        await f.run([
          "invitations",
          "join",
          "--invitation-file",
          f.invitationFile,
          "--json",
        ])
      ).code,
    ).toBe(1);
    const result = await f.run([
      "invitations",
      "join",
      "--mailbox-name",
      "new-choice",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestedMailboxChoiceApplied: false,
    });
    expect(f.redeem.mock.calls[1]![0]).toEqual(f.redeem.mock.calls[0]![0]);
  });
  it("rejects origin and credential-file collisions before sending credentials or proofs", async () => {
    const f = await fixture();
    expect(
      (
        await f.run([
          "--base-url",
          "https://different.example.test",
          "invitations",
          "join",
          "--invitation-file",
          f.invitationFile,
          "--json",
        ])
      ).code,
    ).toBe(1);
    await withCredentials(f.credentials, (store) =>
      store.write({
        version: 1,
        kind: "account",
        origin: f.saved.origin,
        credential: {
          accountId: randomUUID(),
          workplaceId: randomUUID(),
          key: "existing-key",
        },
      }),
    );
    expect(
      (
        await f.run([
          "invitations",
          "join",
          "--invitation-file",
          f.invitationFile,
          "--json",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await f.run([
          "invitations",
          "join",
          "--invitation-file",
          f.credentials,
          "--json",
        ])
      ).code,
    ).toBe(1);
    expect(f.redeem).not.toHaveBeenCalled();
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(await readFile(f.credentials, "utf8")).toContain("existing-key");
  });
  it("writes issued codes only to a new private invitation file", async () => {
    const f = await fixture();
    await withCredentials(f.credentials, (store) =>
      store.write({
        version: 1,
        kind: "account",
        origin: f.saved.origin,
        credential: {
          accountId: f.saved.accountId,
          workplaceId: f.saved.workplaceId,
          key: "admin-key",
        },
      }),
    );
    const create = vi
      .spyOn(AgentWorkplace.prototype, "createAgentInvitation")
      .mockResolvedValue({
        id: f.saved.invitationId,
        workplaceId: f.saved.workplaceId,
        accountId: f.saved.accountId,
        issuerId: randomUUID(),
        kind: "agent",
        name: "B",
        role: "member",
        state: "pending",
        createdAt: "2026-09-16T00:00:00.000Z",
        expiresAt: f.admission.recoveryExpiresAt,
        code: f.saved.code,
      });
    const path = join(f.directory, "issued.json");
    const result = await f.run([
      "invitations",
      "create",
      "--name",
      "B",
      "--invitation-file",
      path,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(f.saved.code);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      code: f.saved.code,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (
        await f.run([
          "invitations",
          "create",
          "--name",
          "B",
          "--invitation-file",
          path,
          "--json",
        ])
      ).code,
    ).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });
});
