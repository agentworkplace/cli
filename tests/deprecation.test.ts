import { AgentWorkplace } from "@agent-workplace/sdk";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";

import { deprecationWarnings } from "../src/output.js";
import { runCli } from "../src/program.js";

const origin = "https://api.example.test";
const headers = {
  Deprecation: "@1796083200",
  Sunset: "Mon, 01 Mar 2027 00:00:00 GMT",
  Link: '<https://agentworkplace.dev/changelog/example>; rel="deprecation"',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

async function accounts(json: boolean) {
  vi.stubEnv("AGENT_WORKPLACE_API_URL", origin);
  vi.stubEnv("AGENT_WORKPLACE_API_KEY", "fixture-only-product-key");
  let stdout = "",
    stderr = "";
  const exitCode = await runCli(["accounts", ...(json ? ["--json"] : [])], {
    version: "0.0.0",
    createProductClient: (baseUrl, construction) =>
      new AgentWorkplace({
        baseUrl,
        ...construction,
        fetch: async () =>
          Response.json(
            { error: { code: "forbidden", message: "Not allowed" } },
            { status: 403, headers },
          ),
      }),
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
}

test("warns on stderr when a command uses a deprecated operation", async () => {
  const result = await accounts(false);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.split("\n")[0]).toBe(
    "Warning: GET /v1/access/account is deprecated since 2026-12-01 and may stop working after 2027-03-01. Update this CLI or your integration; see https://agentworkplace.dev/changelog/example",
  );
  expect(result.stderr).toContain("code: forbidden");
});

test("writes the warning as one JSON line with --json", async () => {
  const result = await accounts(true);
  const [warning, failure] = result.stderr.trimEnd().split("\n");
  expect(JSON.parse(warning!)).toEqual({
    warning: {
      code: "deprecated_operation",
      operation: "GET /v1/access/account",
      deprecatedAt: "2026-12-01T00:00:00.000Z",
      sunsetAt: "2027-03-01T00:00:00.000Z",
      link: "https://agentworkplace.dev/changelog/example",
    },
  });
  expect(JSON.parse(failure!)).toMatchObject({ error: { code: "forbidden" } });
  expect(result.stdout).toBe("");
});

test("warns once per operation", () => {
  let stderr = "";
  const warn = deprecationWarnings(false, (value) => {
    stderr += value;
  });
  const notice = {
    method: "GET",
    path: `/v1/accounts/${randomUUID()}`,
    deprecatedAt: new Date("2026-12-01T00:00:00Z"),
  };
  warn(notice);
  warn(notice);
  warn({ ...notice, method: "DELETE" });
  expect(stderr.trimEnd().split("\n")).toHaveLength(2);
  expect(stderr).toContain("Update this CLI or your integration.\n");
});
