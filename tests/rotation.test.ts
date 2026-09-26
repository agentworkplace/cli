import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";
import { withCredentials, type CredentialState } from "../src/credentials.js";
import { executeKeyRotation, executeKeyIssue } from "../src/commands/keys.js";
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
});
