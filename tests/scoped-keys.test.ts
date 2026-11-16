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
  vi.spyOn(AgentWorkplace.prototype, "listParticipants").mockResolvedValue({
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
  return { run, created, directory, accountId };
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
