import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentWorkplace, AgentWorkplaceError } from "@agent-workplace/sdk";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-scoped-keys-"));
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
  } as Awaited<ReturnType<AgentWorkplace["accountStatus"]>>);
  const listed = vi
    .spyOn(AgentWorkplace.prototype, "listParticipants")
    .mockResolvedValue({
      participants: [{ id: accountId, kind: "agent", state: "active" }],
    } as unknown as Awaited<ReturnType<AgentWorkplace["listParticipants"]>>);
  const created = vi
    .spyOn(AgentWorkplace.prototype, "createAgentKey")
    .mockResolvedValue({ id: randomUUID(), key: "issued" });
  const run = async (arguments_: string[]) => {
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
    });
    return { code, stdout, stderr };
  };
  return { run, created, listed, directory, accountId };
}

test("create-key passes repeated --scope groups and omits them for an unscoped key", async () => {
  const f = await fixture();
  for (const [name, scopes] of [
    ["Triage", ["mail", "files"]],
    ["Full", []],
  ] as const) {
    const result = await f.run([
      "create-key",
      "--name",
      name,
      ...scopes.flatMap((scope) => ["--scope", scope]),
      "--save-to",
      join(f.directory, `${name}.json`),
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
  }
  expect(f.created.mock.calls.map((call) => call.slice(1))).toEqual([
    [f.accountId, "Triage", { scopes: ["mail", "files"] }],
    [f.accountId, "Full", {}],
  ]);
});

test("recover-keys has no --scope: recovery issues an unscoped key", async () => {
  const f = await fixture();
  const result = await f.run([
    "recover-keys",
    "--name",
    "Recovered",
    "--scope",
    "mail",
    "--save-to",
    join(f.directory, "recovered.json"),
  ]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("--scope");
});

test("create-key with a scoped key reports the API's refusal, not a workplace scope", async () => {
  const f = await fixture();
  // A scoped key without `workplace` cannot list participants; the CLI must not
  // need to, because the account status already identifies the caller.
  f.listed.mockRejectedValue(
    new AgentWorkplaceError("Missing scope", {
      status: 403,
      code: "insufficient_scope",
      scopes: ["workplace"],
    }),
  );
  f.created.mockRejectedValue(
    new AgentWorkplaceError("This operation needs an unscoped agent key.", {
      status: 403,
      code: "unscoped_key_required",
    }),
  );
  for (const target of [[], ["--account", f.accountId.toUpperCase()]]) {
    const result = await f.run([
      "create-key",
      "--name",
      "Escalate",
      ...target,
      "--save-to",
      join(f.directory, `escalate-${target.length}.json`),
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "unscoped_key_required",
    });
  }
  expect(f.listed).not.toHaveBeenCalled();
  expect(f.created.mock.calls.map((call) => call[1])).toEqual([
    f.accountId,
    f.accountId,
  ]);
});

test("create-key for another agent still checks that it is an active agent", async () => {
  const f = await fixture();
  const result = await f.run([
    "create-key",
    "--name",
    "Handoff",
    "--account",
    randomUUID(),
    "--save-to",
    join(f.directory, "handoff.json"),
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error.message).toContain(
    "Target is not an active agent",
  );
  expect(f.listed).toHaveBeenCalledOnce();
  expect(f.created).not.toHaveBeenCalled();
});
