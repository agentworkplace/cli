import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkplace, AgentWorkplaceError } from "@agent-workplace/sdk";
import { withCredentials, type CredentialState } from "../src/credentials.js";
import { executeKeyRotation, executeKeyIssue } from "../src/commands/keys.js";
import { executeSignup } from "../src/commands/access.js";
vi.mock("node:fs/promises", { spy: true });
const realFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockImplementation(realFs.rename);
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(general = false) {
  const directory = await mkdtemp(join(tmpdir(), "awp-rotation-"));
  directories.push(directory);
  const file = join(directory, "credentials.json");
  const accountId = randomUUID();
  const workplaceId = randomUUID();
  const legacy: CredentialState = {
    origin: "https://api.example.test",
    name: "Agent",
    nominatedEmail: "owner@example.test",
    acknowledged: true,
    credential: { accountId, workplaceId, key: "old-secret" },
  };
  const state: CredentialState = general
    ? {
        version: 1,
        kind: "account",
        origin: legacy.origin,
        credential: legacy.credential!,
      }
    : legacy;
  await withCredentials(file, (store) => store.write(state));
  const status = vi
    .spyOn(AgentWorkplace.prototype, "accountStatus")
    .mockResolvedValue({
      accountId,
      workplaceId,
    } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const begin = vi
    .spyOn(AgentWorkplace.prototype, "beginKeyRotation")
    .mockImplementation(async (_key, operationId) => ({
      operationId,
      predecessorId: randomUUID(),
      id: randomUUID(),
      key: "new-secret",
    }));
  const complete = vi
    .spyOn(AgentWorkplace.prototype, "completeKeyRotation")
    .mockResolvedValue({ completed: true });
  const write = vi.fn();
  const options = { credentials: file, name: "Rotation", json: true, write };
  return { file, begin, complete, options, state, status };
}
describe("private CLI rotation handoff", () => {
  it.each(["", "https://api.agentworkplace.dev"])(
    "rejects a conflicting or empty override before using a saved key (%s)",
    async (baseUrl) => {
      const f = await fixture();
      await expect(
        executeKeyRotation({ ...f.options, baseUrl }),
      ).rejects.toThrow();
      await expect(
        executeKeyIssue(
          { ...f.options, baseUrl, saveTo: `${f.file}.issued` },
          false,
        ),
      ).rejects.toThrow();
      expect(f.status).not.toHaveBeenCalled();
      expect(f.begin).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(await readFile(f.file, "utf8")).toContain("old-secret");
    },
  );
  it("keeps the old credential and stable operation after a failed candidate write", async () => {
    const f = await fixture();
    const rename = vi.spyOn(fs, "rename");
    const realRename = realFs.rename;
    let writes = 0;
    rename.mockImplementation(async (...args) => {
      if (++writes === 2) throw new Error("Interrupted candidate write");
      return realRename(...args);
    });
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "Interrupted candidate write",
    );
    const interrupted = JSON.parse(
      await readFile(f.file, "utf8"),
    ) as CredentialState;
    expect(interrupted.credential?.key).toBe("old-secret");
    expect(interrupted.rotation?.phase).toBe("issuing");
    expect(f.complete).not.toHaveBeenCalled();
    rename.mockImplementation(realRename);
    await executeKeyRotation(f.options);
    expect(f.begin.mock.calls[0]![1]).toBe(f.begin.mock.calls[1]![1]);
    expect(f.complete).toHaveBeenCalledWith(
      "new-secret",
      interrupted.rotation?.operationId,
    );
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(f.file, "utf8")).rotation).toBeUndefined();
    expect(f.options.write.mock.calls.flat().join("")).not.toMatch(
      /old-secret|new-secret|operationId/,
    );
  });
  it.each([false, true])(
    "retries a lost finalization response (general=%s) without issuing another key",
    async (general) => {
      const f = await fixture(general);
      f.complete.mockRejectedValueOnce(
        new Error("Lost acknowledgement response"),
      );
      await expect(executeKeyRotation(f.options)).rejects.toThrow(
        "Lost acknowledgement response",
      );
      const saved = JSON.parse(
        await readFile(f.file, "utf8"),
      ) as CredentialState;
      expect(saved.credential?.key).toBe("new-secret");
      expect(saved.rotation?.phase).toBe("saved");
      await executeKeyRotation(f.options);
      expect(f.begin).toHaveBeenCalledTimes(1);
      expect(f.complete).toHaveBeenCalledTimes(2);
      expect(f.complete.mock.calls[0]).toEqual(f.complete.mock.calls[1]);
    },
  );
  it("writes explicit key handoff files privately and never emits the returned secret", async () => {
    const f = await fixture();
    const targetId = randomUUID();
    vi.spyOn(AgentWorkplace.prototype, "listParticipants").mockResolvedValue({
      participants: [
        {
          id: targetId,
          name: "Target",
          kind: "agent",
          role: "member",
          state: "active",
          departureKind: null,
          departedAt: null,
        },
      ],
    });
    const issued = { id: randomUUID(), key: "handoff-private-secret" };
    const recovery = vi
      .spyOn(AgentWorkplace.prototype, "recoverAgentKeys")
      .mockResolvedValue(issued);
    const saveTo = join(f.file + ".private", "target.json");
    await executeKeyIssue({ ...f.options, accountId: targetId, saveTo }, true);
    expect(recovery).toHaveBeenCalledWith(
      { apiKey: "old-secret" },
      targetId,
      "Rotation",
    );
    const target = JSON.parse(
      await readFile(saveTo, "utf8"),
    ) as CredentialState;
    expect(target.credential).toEqual({
      accountId: targetId,
      workplaceId: f.state.credential!.workplaceId,
      key: issued.key,
    });
    expect(target.origin).toBe(f.state.origin);
    expect(target).toMatchObject({ version: 1, kind: "account" });
    expect(target).not.toHaveProperty("nominatedEmail");
    expect(target).not.toHaveProperty("bootstrapProof");
    expect((await stat(saveTo)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(f.file, "utf8")).credential.key).toBe(
      "old-secret",
    );
    expect(f.options.write.mock.calls.flat().join("")).not.toContain(
      issued.key,
    );
    await expect(
      executeKeyIssue(
        { ...f.options, accountId: targetId, saveTo: f.file },
        true,
      ),
    ).rejects.toThrow("separate credential destination");
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("refuses to replace a saved key and never issues one", async () => {
    const f = await fixture(true);
    vi.spyOn(AgentWorkplace.prototype, "listParticipants").mockResolvedValue({
      participants: [
        {
          id: f.state.credential!.accountId,
          name: "Agent",
          kind: "agent",
          role: "admin",
          state: "active",
          departureKind: null,
          departedAt: null,
        },
      ],
    });
    const create = vi.spyOn(AgentWorkplace.prototype, "createAgentKey");
    const saveTo = `${f.file}.existing`;
    await withCredentials(saveTo, (store) => store.write(f.state));

    for (const destination of [saveTo, f.file])
      await expect(
        executeKeyIssue({ ...f.options, saveTo: destination }, false),
      ).rejects.toThrow("Destination already holds a credential");

    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(saveTo, "utf8")).credential.key).toBe(
      "old-secret",
    );
  });

  it("creates a key in a new destination", async () => {
    const f = await fixture(true);
    vi.spyOn(AgentWorkplace.prototype, "listParticipants").mockResolvedValue({
      participants: [
        {
          id: f.state.credential!.accountId,
          name: "Agent",
          kind: "agent",
          role: "admin",
          state: "active",
          departureKind: null,
          departedAt: null,
        },
      ],
    });
    vi.spyOn(AgentWorkplace.prototype, "createAgentKey").mockResolvedValue({
      id: randomUUID(),
      key: "second-secret",
    });
    const saveTo = `${f.file}.new`;
    await executeKeyIssue({ ...f.options, saveTo }, false);
    expect(JSON.parse(await readFile(saveTo, "utf8")).credential.key).toBe(
      "second-secret",
    );
  });
});

function selfRecovery(f: Awaited<ReturnType<typeof fixture>>) {
  const keyId = randomUUID();
  vi.spyOn(AgentWorkplace.prototype, "listParticipants").mockResolvedValue({
    participants: [
      {
        id: f.state.credential!.accountId,
        name: "Agent",
        kind: "agent",
        role: "admin",
        state: "active",
        departureKind: null,
        departedAt: null,
      },
    ],
  });
  const create = vi
    .spyOn(AgentWorkplace.prototype, "createAgentKey")
    .mockResolvedValue({ id: keyId, key: "replacement-secret" });
  const recover = vi
    .spyOn(AgentWorkplace.prototype, "recoverAgentKeysExceptCurrent")
    .mockResolvedValue({ recovered: true, id: keyId });
  const revokeAll = vi.spyOn(AgentWorkplace.prototype, "recoverAgentKeys");
  const saved = async () =>
    JSON.parse(await readFile(f.file, "utf8")) as CredentialState;
  return { create, recover, revokeAll, saved };
}

describe("self-recovery", () => {
  it.each([false, true])(
    "saves the replacement, then revokes the rest with it (general=%s)",
    async (general) => {
      const f = await fixture(general);
      const r = selfRecovery(f);
      r.recover.mockImplementation(async () => {
        expect((await r.saved()).credential?.key).toBe("replacement-secret");
        return { recovered: true, id: randomUUID() };
      });
      await executeKeyIssue({ ...f.options, saveTo: f.file }, true);
      expect(r.recover).toHaveBeenCalledWith(
        "replacement-secret",
        f.state.credential!.accountId,
      );
      expect(r.revokeAll).not.toHaveBeenCalled();
      const state = await r.saved();
      expect(state.credential?.key).toBe("replacement-secret");
      expect(f.options.write.mock.calls.flat().join("")).not.toContain(
        "replacement-secret",
      );
    },
  );

  it("keeps the old key when the replacement can't be saved", async () => {
    const f = await fixture(true);
    const r = selfRecovery(f);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Disk full"));
    await expect(
      executeKeyIssue({ ...f.options, saveTo: f.file }, true),
    ).rejects.toThrow("Disk full");
    expect(r.recover).not.toHaveBeenCalled();
    expect((await r.saved()).credential?.key).toBe("old-secret");
  });

  it("replaces the saved key on a rerun after a lost response", async () => {
    const f = await fixture(true);
    const r = selfRecovery(f);
    r.recover.mockRejectedValueOnce(new Error("Lost response"));
    await expect(
      executeKeyIssue({ ...f.options, saveTo: f.file }, true),
    ).rejects.toThrow("Lost response");
    expect((await r.saved()).credential?.key).toBe("replacement-secret");
    r.create.mockResolvedValueOnce({ id: randomUUID(), key: "second-secret" });
    await executeKeyIssue({ ...f.options, saveTo: f.file }, true);
    expect(r.create).toHaveBeenCalledTimes(2);
    expect(r.create.mock.calls[1]![0]).toEqual({
      apiKey: "replacement-secret",
    });
    expect((await r.saved()).credential?.key).toBe("second-secret");
    expect(r.recover).toHaveBeenLastCalledWith(
      "second-secret",
      f.state.credential!.accountId,
    );
  });

  it("frees slots with the current key at the key limit", async () => {
    const f = await fixture(true);
    const r = selfRecovery(f);
    r.create.mockRejectedValueOnce(
      new AgentWorkplaceError("Key limit", { status: 409, code: "key_limit" }),
    );
    await executeKeyIssue({ ...f.options, saveTo: f.file }, true);
    expect(r.recover.mock.calls.map((call) => call[0])).toEqual([
      "old-secret",
      "replacement-secret",
    ]);
    expect(r.create).toHaveBeenCalledTimes(2);
    expect((await r.saved()).credential?.key).toBe("replacement-secret");
  });

  it("still replaces another account's keys in one call", async () => {
    const f = await fixture(true);
    const r = selfRecovery(f);
    const targetId = randomUUID();
    vi.mocked(AgentWorkplace.prototype.listParticipants).mockResolvedValue({
      participants: [
        {
          id: targetId,
          name: "Target",
          kind: "agent",
          role: "member",
          state: "active",
          departureKind: null,
          departedAt: null,
        },
      ],
    });
    r.revokeAll.mockResolvedValue({ id: randomUUID(), key: "target-secret" });
    await executeKeyIssue(
      {
        ...f.options,
        accountId: targetId,
        saveTo: join(f.file + ".private", "target.json"),
      },
      true,
    );
    expect(r.revokeAll).toHaveBeenCalledOnce();
    expect(r.create).not.toHaveBeenCalled();
  });
});

describe("cancelled rotations", () => {
  const conflict = () =>
    new AgentWorkplaceError("Rotation conflict", {
      status: 409,
      code: "rotation_conflict",
    });
  const read = async (file: string) =>
    JSON.parse(await readFile(file, "utf8")) as CredentialState;

  /** What the previous key sees when it lists its account's keys. */
  const candidateEnabled = (
    enabled: boolean,
    f: Awaited<ReturnType<typeof fixture>>,
  ) =>
    vi
      .spyOn(AgentWorkplace.prototype, "listAgentKeys")
      .mockImplementation(async () => {
        const issued = await f.begin.mock.results[0]!.value;
        return {
          keys: [
            {
              id: issued.id,
              name: "Rotation",
              enabled,
              createdAt: "2026-11-05T00:00:00.000Z",
              expiresAt: null,
            },
          ],
        };
      });

  it("restores the previous key when finalization is refused", async () => {
    const f = await fixture(true);
    const list = candidateEnabled(false, f);
    f.complete.mockRejectedValueOnce(conflict());
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "run rotate-key again",
    );
    const state = await read(f.file);
    expect(state.credential?.key).toBe("old-secret");
    expect(state.rotation).toBeUndefined();
    expect(list).toHaveBeenCalledWith(
      { apiKey: "old-secret" },
      f.state.credential!.accountId,
    );
  });

  it("restores the previous key when the saved candidate was revoked", async () => {
    const f = await fixture(true);
    candidateEnabled(false, f);
    f.complete.mockRejectedValueOnce(new Error("Lost response"));
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "Lost response",
    );
    f.status.mockRejectedValueOnce(
      new AgentWorkplaceError("Rejected", {
        status: 401,
        code: "access_denied",
      }),
    );
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "run rotate-key again",
    );
    expect((await read(f.file)).credential?.key).toBe("old-secret");
  });

  it.each([
    ["the candidate is still enabled", true, "access_denied"],
    ["the error isn't a refused key", false, "unavailable"],
  ])("keeps the candidate when %s", async (_name, enabled, code) => {
    const f = await fixture(true);
    candidateEnabled(enabled, f);
    f.complete.mockRejectedValueOnce(new Error("Lost response"));
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "Lost response",
    );
    f.status.mockRejectedValueOnce(
      new AgentWorkplaceError("Rejected", { status: 401, code }),
    );
    await expect(executeKeyRotation(f.options)).rejects.toThrow("Rejected");
    const state = await read(f.file);
    expect(state.credential?.key).toBe("new-secret");
    expect(state.rotation?.phase).toBe("saved");
  });

  it("keeps a working candidate when its handoff is over and the previous key is gone", async () => {
    const f = await fixture(true);
    vi.spyOn(AgentWorkplace.prototype, "listAgentKeys").mockRejectedValue(
      new AgentWorkplaceError("Rejected", {
        status: 401,
        code: "access_denied",
      }),
    );
    f.complete.mockRejectedValueOnce(conflict());
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "run rotate-key again",
    );
    const state = await read(f.file);
    expect(state.credential?.key).toBe("new-secret");
    expect(state.rotation).toBeUndefined();
  });

  it("keeps the rotation when a passing 401 can't be confirmed", async () => {
    const f = await fixture(true);
    vi.spyOn(AgentWorkplace.prototype, "listAgentKeys").mockRejectedValue(
      new Error("Lost response"),
    );
    f.complete.mockRejectedValueOnce(new Error("Lost response"));
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "Lost response",
    );
    f.status.mockRejectedValueOnce(
      new AgentWorkplaceError("Rejected", {
        status: 401,
        code: "access_denied",
      }),
    );
    await expect(executeKeyRotation(f.options)).rejects.toThrow("Rejected");
    const state = await read(f.file);
    expect(state.credential?.key).toBe("new-secret");
    expect(state.rotation?.phase).toBe("saved");
  });

  it("clears a refused issuance so a rerun starts a fresh operation", async () => {
    const f = await fixture(true);
    f.begin.mockRejectedValueOnce(conflict());
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "run rotate-key again",
    );
    expect((await read(f.file)).rotation).toBeUndefined();
    await executeKeyRotation(f.options);
    expect(f.begin.mock.calls[0]![1]).not.toBe(f.begin.mock.calls[1]![1]);
    expect((await read(f.file)).credential?.key).toBe("new-secret");
  });

  it("keeps a lost finalization resumable", async () => {
    const f = await fixture(true);
    f.complete.mockRejectedValueOnce(new Error("Lost response"));
    await expect(executeKeyRotation(f.options)).rejects.toThrow(
      "Lost response",
    );
    const state = await read(f.file);
    expect(state.rotation?.phase).toBe("saved");
    expect(state.rotation?.predecessorKey).toBe("old-secret");
  });

  it("keeps unfinished rotation state when signup runs again", async () => {
    const f = await fixture();
    const rotation = {
      operationId: randomUUID(),
      name: "Rotation",
      phase: "saved" as const,
      predecessorKey: "older-secret",
    };
    await withCredentials(f.file, (store) =>
      store.write({ ...f.state, rotation }),
    );
    vi.spyOn(AgentWorkplace.prototype, "acknowledgeSignup").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(AgentWorkplace.prototype, "accessStatus").mockRejectedValue(
      new Error("Stop after the local write"),
    );
    await expect(
      executeSignup({
        credentials: f.file,
        baseUrl: f.state.origin,
        name: "Agent",
        ownerEmail: "owner@example.test",
        json: true,
        write: vi.fn(),
      }),
    ).rejects.toThrow("Stop after the local write");
    expect((await read(f.file)).rotation).toEqual(rotation);
  });

  it("reads a file saved before predecessor keys were kept", async () => {
    const f = await fixture(true);
    await withCredentials(f.file, (store) =>
      store.write({
        ...f.state,
        credential: { ...f.state.credential!, key: "new-secret" },
        rotation: {
          operationId: randomUUID(),
          name: "Rotation",
          phase: "saved",
        },
      }),
    );
    await executeKeyRotation(f.options);
    expect(f.complete).toHaveBeenCalledOnce();
    expect((await read(f.file)).rotation).toBeUndefined();
  });
});
