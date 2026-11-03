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
  const directory = await mkdtemp(join(tmpdir(), "awp-cli-aliases-"));
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
  return { run };
}

test("--account and the older --account-id select the same target", async () => {
  const f = await fixture();
  const keys = vi
    .spyOn(AgentWorkplace.prototype, "listAgentKeys")
    .mockResolvedValue({ keys: [] } as unknown as Awaited<
      ReturnType<AgentWorkplace["listAgentKeys"]>
    >);
  const target = randomUUID();
  for (const flag of ["--account", "--account-id"])
    expect(await f.run(["keys", flag, target, "--json"])).toMatchObject({
      code: 0,
      stderr: "",
    });
  expect(keys.mock.calls.map((call) => call.slice(1))).toEqual([
    [target],
    [target],
  ]);
  expect(
    await f.run([
      ...["keys", "--account", target, "--account-id", randomUUID()],
    ]),
  ).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "error: options '--account <id>' and '--account-id <id>' name different values; use '--account'\n",
  });
  expect(
    (await f.run(["keys", "--account", target, "--account-id", target])).code,
  ).toBe(0);
});

test("remove-account still requires a target under either spelling", async () => {
  const f = await fixture();
  expect(await f.run(["remove-account"])).toEqual({
    code: 1,
    stdout: "",
    stderr: "error: required option '--account <id>' not specified\n",
  });
});

test("help shows only the canonical spellings", async () => {
  const f = await fixture();
  const keysHelp = (await f.run(["keys", "--help"])).stdout;
  expect(keysHelp).toContain("--account <id>");
  expect(keysHelp).not.toContain("--account-id");
  const chatHelp = (await f.run(["chat", "post", "--help"])).stdout;
  expect(chatHelp).toContain("--request-file <path>");
  expect(chatHelp).not.toMatch(/--file <path>/);
});
