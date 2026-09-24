import { randomUUID } from "node:crypto";
import { AgentWorkplace } from "@agent-workplace/sdk";
import {
  executeSignup,
  executeAccess,
  executeNominationChange,
  executeAccountStatus,
} from "../src/commands/access.js";
import * as fs from "node:fs/promises";
import {
  mkdtemp,
  readFile,
  rm,
  chmod,
  stat,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessOrigin,
  withCredentials,
  type CredentialState,
} from "../src/credentials.js";

vi.mock("node:fs/promises", { spy: true });

const state: CredentialState = {
  origin: "https://api.example.test",
  name: "Agent",
  nominatedEmail: "owner@example.test",
  bootstrapProof: "a".repeat(43),
  acknowledged: false,
};
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-credentials-"));
  directories.push(directory);
  return { directory, file: join(directory, "credentials.json") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("credential persistence", () => {
  it("persists private state atomically with restrictive permissions", async () => {
    const { directory, file } = await fixture();
    await withCredentials(file, async (store) => {
      await store.write(state);
      expect(await store.read()).toEqual(state);
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual(["credentials.json"]);
  });
  it("rejects permissive files and symlinks without overwriting their targets", async () => {
    const { file, directory } = await fixture();
    await withCredentials(file, (store) => store.write(state));
    await chmod(file, 0o644);
    await expect(
      withCredentials(file, (store) => store.read()),
    ).rejects.toThrow("accessible only to you");
    await expect(
      withCredentials(file, (store) => store.write(state)),
    ).rejects.toThrow("accessible only to you");
    await chmod(file, 0o600);
    const link = join(directory, "link.json");
    await symlink(file, link);
    await expect(
      withCredentials(link, (store) => store.read()),
    ).rejects.toThrow("safely");
    await expect(
      withCredentials(link, (store) => store.write(state)),
    ).rejects.toThrow("accessible only to you");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
  });
  it("preserves the previous credential after an interrupted temporary write", async () => {
    const { file, directory } = await fixture();
    await withCredentials(file, (store) => store.write(state));
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await write("{partial");
        throw new Error("Injected interrupted write");
      });
      return handle;
    });
    await expect(
      withCredentials(file, (store) =>
        store.write({ ...state, name: "Changed" }),
      ),
    ).rejects.toThrow("Injected interrupted write");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect(await readdir(directory)).toEqual(["credentials.json"]);
    await withCredentials(file, async (store) => {
      expect(await store.read()).toEqual(state);
    });
  });
  it("does not replace an existing file when state validation fails", async () => {
    const { file } = await fixture();
    await withCredentials(file, (store) => store.write(state));
    await expect(
      withCredentials(file, (store) =>
        store.write({ ...state, acknowledged: true }),
      ),
    ).rejects.toThrow("Invalid credential file");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
  });
  it("does not send signup until the private proof is persisted", async () => {
    const { file } = await fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.open)
      .mockImplementationOnce((path, flags, mode) =>
        actual.open(path, flags, mode),
      )
      .mockImplementationOnce(async (path) => {
        expect(String(path)).toMatch(/\.tmp$/);
        throw new Error("Disk unavailable");
      });
    await expect(
      executeSignup({
        credentials: file,
        baseUrl: state.origin,
        name: state.name,
        ownerEmail: state.nominatedEmail,
        json: true,
        write: vi.fn(),
      }),
    ).rejects.toThrow("Disk unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps recovery proof and never acknowledges when credential persistence fails", async () => {
    const { file } = await fixture();
    await withCredentials(file, (store) => store.write(state));
    const fetch = vi.fn(async () => {
      // The proof already exists when the signup request starts.
      expect(JSON.parse(await readFile(file, "utf8")).bootstrapProof).toBe(
        state.bootstrapProof,
      );
      vi.mocked(fs.open).mockRejectedValueOnce(new Error("Disk full"));
      return Response.json({
        workplaceId: randomUUID(),
        accountId: randomUUID(),
        cleanupAt: new Date().toISOString(),
        cleanupWarning: null,
        credential: { id: randomUUID(), key: "private-returned-key" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const write = vi.fn();
    await expect(
      executeSignup({
        credentials: file,
        baseUrl: state.origin,
        name: state.name,
        ownerEmail: state.nominatedEmail,
        json: true,
        write,
      }),
    ).rejects.toThrow("Disk full");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects a different origin before transmitting a saved key", async () => {
    const { file } = await fixture();
    await withCredentials(file, (store) =>
      store.write({
        ...state,
        credential: {
          accountId: randomUUID(),
          workplaceId: randomUUID(),
          key: "private-key",
        },
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      executeAccess({
        credentials: file,
        baseUrl: "https://other.example.test",
        json: true,
        write: vi.fn(),
      }),
    ).rejects.toThrow("another API origin");
    expect(fetch).not.toHaveBeenCalled();
    for (const change of [
      { nominationId: randomUUID() },
      { nominationId: randomUUID(), nominatedEmail: "corrected@example.test" },
    ]) {
      await expect(
        executeNominationChange(
          {
            credentials: file,
            baseUrl: "https://other.example.test",
            json: true,
            write: vi.fn(),
          },
          change,
        ),
      ).rejects.toThrow("another API origin");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks saved account identity before any nomination mutation", async () => {
    const { file } = await fixture();
    const credential = {
      accountId: randomUUID(),
      workplaceId: randomUUID(),
      key: "private-key",
    };
    await withCredentials(file, (store) =>
      store.write({ ...state, credential }),
    );
    const before = await readFile(file, "utf8");
    const status = vi
      .spyOn(AgentWorkplace.prototype, "accountStatus")
      .mockResolvedValue({
        accountId: randomUUID(),
        workplaceId: credential.workplaceId,
        role: "admin",
        workplaceState: "unconfirmed",
        cleanupAt: new Date().toISOString(),
        cleanupWarning: null,
        kind: "agent",
        state: "active",
        free: null,
        starter: {
          outboundLimit: 2,
          inboundLimit: 20,
          storageLimit: "100 MB",
          outboundUsed: 0,
          inboundUsed: 0,
          storageUsedBytes: 0,
        },
      });
    const correct = vi
      .spyOn(AgentWorkplace.prototype, "correctNomination")
      .mockResolvedValue({ state: "queued", nominationId: randomUUID() });
    const cancel = vi
      .spyOn(AgentWorkplace.prototype, "cancelNomination")
      .mockResolvedValue({ canceled: true });
    const resend = vi
      .spyOn(AgentWorkplace.prototype, "resendNomination")
      .mockResolvedValue({ state: "queued" });
    const write = vi.fn();
    const options = { credentials: file, json: true, write };
    await expect(executeAccess(options, true)).rejects.toThrow(
      "Saved credential account",
    );
    for (const change of [
      { nominationId: randomUUID() },
      { nominationId: randomUUID(), nominatedEmail: "corrected@example.test" },
    ]) {
      await expect(executeNominationChange(options, change)).rejects.toThrow(
        "Saved credential account",
      );
    }
    expect(status).toHaveBeenCalledTimes(3);
    expect(correct).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(before);
  });
  it("returns a versioned account without enrollment metadata or a signup request", async () => {
    const { file } = await fixture();
    const credential = {
      accountId: randomUUID(),
      workplaceId: randomUUID(),
      key: "private-key",
    };
    const saved: CredentialState = {
      version: 1,
      kind: "account",
      origin: state.origin,
      credential,
    };
    await withCredentials(file, (store) => store.write(saved));
    const status = {
      ...credential,
      key: undefined,
      kind: "agent",
      state: "active",
      role: "member",
      workplaceState: "unconfirmed",
      cleanupAt: new Date().toISOString(),
      cleanupWarning: null,
      free: null,
      storage: {
        limitBytes: 100000000,
        usedBytes: 64,
        heldBytes: 128,
        availableBytes: 99999808,
      },
      starter: {
        outboundLimit: 2,
        inboundLimit: 20,
        storageLimit: "100 MB",
        outboundUsed: 0,
        inboundUsed: 0,
        storageUsedBytes: 0,
      },
    } as const;
    const read = vi
      .spyOn(AgentWorkplace.prototype, "accountStatus")
      .mockResolvedValue(status);
    const signup = vi.spyOn(AgentWorkplace.prototype, "signup");
    const write = vi.fn();
    await executeAccountStatus({ credentials: file, json: true, write });
    expect(JSON.parse(write.mock.calls[0]![0]).storage).toEqual(status.storage);
    expect(read).toHaveBeenCalledWith({ apiKey: credential.key });
    expect(write.mock.calls.flat().join("")).not.toContain(credential.key);
    await expect(
      executeSignup({
        credentials: file,
        baseUrl: state.origin,
        name: "Agent",
        ownerEmail: "owner@example.test",
        json: true,
        write,
      }),
    ).rejects.toThrow("not a signup");
    expect(signup).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(saved);
    for (const invalid of [
      { ...saved, version: 2 },
      { ...saved, nominatedEmail: "private@example.test" },
      { ...saved, bootstrapProof: "a".repeat(43) },
    ]) {
      await expect(
        withCredentials(file, (store) =>
          store.write(invalid as CredentialState),
        ),
      ).rejects.toThrow("Invalid credential file");
    }
  });
  it.each([
    "http://api.example.test",
    "https://user:secret@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?x=1",
  ])("rejects unsafe credential origin %s", (value) => {
    expect(() => accessOrigin(value)).toThrow();
  });
});
