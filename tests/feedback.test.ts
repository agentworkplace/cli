import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentWorkplace } from "@agent-workplace/sdk";

import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(fail = false) {
  const directory = await mkdtemp(join(tmpdir(), "awp-feedback-cli-"));
  directories.push(directory);
  const credentials = join(directory, "credentials.json");
  const accountId = "11111111-1111-4111-8111-111111111111";
  const workplaceId = "22222222-2222-4222-8222-222222222222";
  const submissionId = "33333333-3333-4333-8333-333333333333";
  await withCredentials(credentials, (store) =>
    store.write({
      version: 1,
      kind: "account",
      origin: "https://api.example.test",
      credential: { accountId, workplaceId, key: "private-key" },
    }),
  );
  const calls: string[] = [];
  const createProductClient = (baseUrl: string) =>
    new AgentWorkplace({
      baseUrl,
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/access/account")
          return Response.json({
            accountId,
            workplaceId,
            kind: "agent",
            role: "member",
            state: "active",
            workplaceState: "unconfirmed",
            cleanupAt: "2026-10-21T00:00:00.000Z",
            cleanupWarning: null,
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
        if (path !== "/v1/feedback") throw new Error("Unexpected path");
        calls.push(String(init?.body));
        if (fail) throw new Error("private transport failure");
        return Response.json(
          {
            feedbackId: accountId,
            submissionId,
            state: "received",
            receivedAt: "2026-09-26T00:00:00.000Z",
          },
          { status: 201 },
        );
      },
    });
  const invoke = async (
    args: string[],
    input?: AsyncIterable<string | Uint8Array>,
  ) => {
    let stdout = "",
      stderr = "";
    const code = await runCli(
      ["--credentials", credentials, "feedback", "send", ...args],
      {
        version: "0.0.0",
        createProductClient,
        input,
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
  return { invoke, calls, submissionId, directory };
}

it("sends stdin feedback without prompts and prints one JSON receipt", async () => {
  const f = await fixture();
  const result = await f.invoke(
    [
      "--message-file",
      "-",
      "--category",
      "bug",
      "--submission-id",
      f.submissionId,
      "--json",
    ],
    (async function* () {
      yield "Explicit report";
    })(),
  );
  expect(result).toEqual({
    code: 0,
    stderr: "",
    stdout: `${JSON.stringify({ feedbackId: "11111111-1111-4111-8111-111111111111", submissionId: f.submissionId, state: "received", receivedAt: "2026-09-26T00:00:00.000Z" })}\n`,
  });
  expect(JSON.parse(f.calls[0]!)).toEqual({
    submissionId: f.submissionId,
    message: "Explicit report",
    category: "bug",
  });
});

it("reads an explicit UTF-8 file and sends the selected request ID", async () => {
  const f = await fixture();
  const path = join(f.directory, "report.txt");
  await writeFile(path, "Something went wrong\n", "utf8");
  const relatedRequestId = "44444444-4444-4444-8444-444444444444";
  const result = await f.invoke([
    "--message-file",
    path,
    "--request-id",
    relatedRequestId,
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(f.calls[0]!)).toMatchObject({
    message: "Something went wrong\n",
    relatedRequestId,
  });
});

it("keeps a retry ID in safe JSON diagnostics after an uncertain failure", async () => {
  const f = await fixture(true);
  const result = await f.invoke([
    "--message",
    "Private report",
    "--submission-id",
    f.submissionId,
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatchObject({
    submissionId: f.submissionId,
  });
  expect(result.stderr).not.toContain("private transport failure");
  expect(result.stderr).not.toContain("Private report");
});
