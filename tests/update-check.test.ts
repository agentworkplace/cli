import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkplaceError } from "@agent-workplace/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import packageMetadata from "../package.json" with { type: "json" };
import { cliUserAgent, cliVersion } from "../src/client.js";
import { presentError } from "../src/errors.js";
import {
  latestReleaseUrl,
  refreshUpdateCache,
  startUpdateCheck,
  updateCheckEnabled,
  type UpdateCheckOptions,
} from "../src/update-check.js";

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const notice =
  "agent-workplace 0.15.0 is available (you have 0.14.0). " +
  "Update: npm i -g agent-workplace@latest. " +
  "Changes: https://agentworkplace.dev/changelog\n";
let directory: string;
let cachePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "awp-update-check-"));
  cachePath = join(directory, "nested", "update-check.json");
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const registry = (version: unknown) =>
  vi.fn<typeof globalThis.fetch>(async () => Response.json({ version }));
const readCache = () =>
  JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;

async function run(options: Partial<UpdateCheckOptions> = {}) {
  const refresh = vi.fn<(path: string) => void>();
  const lines: string[] = [];
  await startUpdateCheck({
    version: "0.14.0",
    arguments: ["status"],
    env: {},
    cachePath,
    now: () => 1_000 * day,
    refresh,
    ...options,
  })?.finish((text) => lines.push(text));
  return { notice: lines.join(""), refresh };
}

it("names the installed release in User-Agent", () => {
  expect(cliVersion).toBe(packageMetadata.version);
  expect(cliUserAgent).toBe(`agent-workplace-cli/${packageMetadata.version}`);
});

it("starts one background refresh for an empty cache and prints nothing yet", async () => {
  const first = await run();
  expect(first.notice).toBe("");
  expect(first.refresh).toHaveBeenCalledWith(cachePath);
  expect(readCache()).toEqual({ attemptedAt: 1_000 * day });
  // Another command within the hour doesn't start a second refresh.
  const second = await run({ now: () => 1_000 * day + hour - 1 });
  expect(second.refresh).not.toHaveBeenCalled();
});

it("records npm's latest release, then announces it on the next command", async () => {
  const fetch = registry("0.15.0");
  await refreshUpdateCache({ cachePath, fetch, now: () => 1_000 * day });
  expect(String(fetch.mock.calls[0]![0])).toBe(latestReleaseUrl);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  expect(readCache()).toEqual({ checkedAt: 1_000 * day, latest: "0.15.0" });

  const shown = await run();
  expect(shown.notice).toBe(notice);
  expect(shown.refresh).not.toHaveBeenCalled();
  // Repeated at most daily per release.
  expect((await run({ now: () => 1_000 * day + hour })).notice).toBe("");
  const nextDay = await run({ now: () => 1_001 * day });
  expect(nextDay.notice).toBe(notice);
  expect(nextDay.refresh).toHaveBeenCalledTimes(1);
});

it("announces a newer release without waiting for the daily repeat", async () => {
  await refreshUpdateCache({ cachePath, fetch: registry("0.15.0") });
  expect((await run()).notice).toContain("0.15.0");
  await refreshUpdateCache({ cachePath, fetch: registry("0.16.0") });
  expect(readCache()).toMatchObject({
    latest: "0.16.0",
    notifiedVersion: "0.15.0",
  });
  expect((await run()).notice).toContain("0.16.0");
});

it("stays quiet when this release is current or newer", async () => {
  for (const latest of ["0.14.0", "0.13.9"]) {
    await refreshUpdateCache({ cachePath, fetch: registry(latest) });
    expect((await run()).notice).toBe("");
  }
});

it("records nothing when npm misbehaves", async () => {
  const failures: (typeof globalThis.fetch)[] = [
    async () => {
      throw new TypeError("offline");
    },
    async () => new Response("not json"),
    async () => new Response("{}", { status: 503 }),
    async () => new Response("x".repeat(300 * 1024)),
    registry("0.15.0-next.1"),
    registry(15),
  ];
  for (const fetch of failures) {
    await refreshUpdateCache({ cachePath, fetch });
    expect(() => readCache()).toThrow();
  }
});

it("ignores a corrupt or oversized cache", async () => {
  const path = join(directory, "update-check.json");
  for (const text of [
    "{not json",
    JSON.stringify({ checkedAt: 1, latest: "9.9.9", pad: "x".repeat(5000) }),
    JSON.stringify({ checkedAt: "soon", latest: "9.9.9" }),
  ]) {
    writeFileSync(path, text);
    const result = await run({ cachePath: path });
    expect(result.notice).toBe("");
    expect(result.refresh).toHaveBeenCalledTimes(1);
  }
});

it("never throws when the cache can't be written", async () => {
  writeFileSync(join(directory, "file"), "");
  const result = await run({
    cachePath: join(directory, "file", "cache.json"),
  });
  expect(result.notice).toBe("");
});

it.each([
  [{ arguments: ["status", "--json"] }],
  [{ arguments: ["--version"] }],
  [{ arguments: ["-V"] }],
  [{ arguments: ["mail", "--help"] }],
  [{ arguments: ["help"] }],
  [{ arguments: [] }],
  [{ env: { CI: "true" } }],
  [{ env: { NO_UPDATE_NOTIFIER: "1" } }],
  [{ env: { NODE_ENV: "test" } }],
  [{ env: { AGENT_WORKPLACE_NO_UPDATE_CHECK: "1" } }],
  [{ env: { AGENT_WORKPLACE_API_URL: "http://127.0.0.1:3000" } }],
  [{ version: "0.0.0" }],
])("is disabled for %j", async (overrides) => {
  const options = {
    version: "0.14.0",
    arguments: ["status"],
    env: {},
    ...overrides,
  };
  expect(updateCheckEnabled(options)).toBe(false);
  const result = await run(overrides);
  expect(result.refresh).not.toHaveBeenCalled();
  expect(() => readCache()).toThrow();
});

it("still checks when --json only appears after the argument terminator", () => {
  expect(
    updateCheckEnabled({
      version: "0.14.0",
      arguments: ["files", "upload", "--", "--json"],
      env: {},
    }),
  ).toBe(true);
});

it("tells an older CLI to update when it can't read a successful response", () => {
  const error = new AgentWorkplaceError(
    "The Agent Workplace API returned an invalid response",
    { status: 200, code: "invalid_response" },
  );
  expect(presentError(error)).toMatchObject({
    code: "invalid_response",
    hint: `This CLI (${cliVersion}) may be older than the API; update with npm i -g agent-workplace@latest, then check the result before repeating the command`,
  });
  expect(presentError(error, { operation: true }).hint).toMatch(
    /then repeat with the same --operation, which can't apply twice$/,
  );
});
