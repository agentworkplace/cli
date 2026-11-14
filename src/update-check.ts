import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** npm's record of the release `npm i -g agent-workplace` installs. */
export const latestReleaseUrl =
  "https://registry.npmjs.org/agent-workplace/latest";
const hour = 60 * 60 * 1000;
const day = 24 * hour;
/** The background refresh gives npm this long; the command never waits. */
const refreshTimeoutMs = 15_000;
/** The latest-release manifest is a few KiB; refuse anything far larger. */
const maximumManifestBytes = 256 * 1024;
const stableVersion = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

interface UpdateCache {
  /** When npm last answered, and the release it named. */
  checkedAt?: number;
  latest?: string;
  /** When a refresh last started, so concurrent commands start only one. */
  attemptedAt?: number;
  notifiedAt?: number;
  notifiedVersion?: string;
}

export function defaultUpdateCachePath() {
  return join(homedir(), ".config", "agent-workplace", "update-check.json");
}

export interface UpdateCheckOptions {
  version: string;
  arguments: readonly string[];
  env: Record<string, string | undefined>;
  cachePath?: string;
  now?: () => number;
  /** Starts the background refresh; defaults to a detached CLI process. */
  refresh?: (cachePath: string) => void;
}

export interface UpdateCheck {
  /** Writes at most one notice line; never throws or changes the exit status. */
  finish(writeErr: (text: string) => unknown): Promise<void>;
}

/** The commands and environments that never check: machine output, help,
 * version, CI, tests and development against another API origin. */
export function updateCheckEnabled(
  options: Pick<UpdateCheckOptions, "version" | "arguments" | "env">,
) {
  const { env, version } = options;
  const terminator = options.arguments.indexOf("--");
  const own =
    terminator === -1
      ? options.arguments
      : options.arguments.slice(0, terminator);
  return !(
    own.length === 0 ||
    own[0] === "help" ||
    own.some((argument) =>
      ["--json", "--version", "-V", "--help", "-h"].includes(argument),
    ) ||
    !stableVersion.test(version) ||
    version === "0.0.0" ||
    Boolean(env.CI) ||
    Boolean(env.NO_UPDATE_NOTIFIER) ||
    env.NODE_ENV === "test" ||
    env.AGENT_WORKPLACE_NO_UPDATE_CHECK === "1" ||
    env.AGENT_WORKPLACE_API_URL !== undefined
  );
}

function parts(version: string) {
  const match = stableVersion.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

function newer(candidate: string, installed: string) {
  const a = parts(candidate);
  const b = parts(installed);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function validCache(value: unknown): UpdateCache {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const cache: UpdateCache = {};
  const checkedAt = number(record.checkedAt);
  if (
    checkedAt !== undefined &&
    typeof record.latest === "string" &&
    stableVersion.test(record.latest)
  ) {
    cache.checkedAt = checkedAt;
    cache.latest = record.latest;
  }
  const attemptedAt = number(record.attemptedAt);
  if (attemptedAt !== undefined) cache.attemptedAt = attemptedAt;
  const notifiedAt = number(record.notifiedAt);
  if (
    notifiedAt !== undefined &&
    typeof record.notifiedVersion === "string" &&
    stableVersion.test(record.notifiedVersion)
  ) {
    cache.notifiedAt = notifiedAt;
    cache.notifiedVersion = record.notifiedVersion;
  }
  return cache;
}

async function readCache(path: string): Promise<UpdateCache> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > 4096 ? {} : validCache(JSON.parse(text));
  } catch {
    return {};
  }
}

async function writeCache(path: string, cache: UpdateCache) {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(cache) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // A missing or read-only home only means a later command checks again.
  }
}

async function fetchLatest(
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(latestReleaseUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok || response.body === null) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumManifestBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const manifest: unknown = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks)),
    );
    const version =
      typeof manifest === "object" && manifest !== null
        ? (manifest as { version?: unknown }).version
        : undefined;
    return typeof version === "string" && stableVersion.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

/** Asks npm for the latest release and records it; run by the background process. */
export async function refreshUpdateCache(
  options: {
    cachePath?: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
  } = {},
) {
  const cachePath = options.cachePath ?? defaultUpdateCachePath();
  const now = options.now ?? Date.now;
  const latest = await fetchLatest(
    options.fetch ?? globalThis.fetch,
    AbortSignal.timeout(refreshTimeoutMs),
  );
  if (latest === undefined) return;
  // Read again: a notice may have been recorded while npm answered.
  const current = await readCache(cachePath);
  await writeCache(cachePath, { ...current, checkedAt: now(), latest });
}

/** Network settings the refresh may need; never credentials or API keys. */
const refreshEnvironment =
  /^(?:https?_proxy|no_proxy|all_proxy|node_use_env_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir)$/i;

function spawnRefresh(cachePath: string) {
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        refreshEnvironment.test(name),
      ),
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./update-refresh.js", import.meta.url)),
        cachePath,
      ],
      { detached: true, stdio: "ignore", windowsHide: true, env },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Without a refresh, the cached result (if any) still applies.
  }
}

/**
 * Reads the cached latest release, prints a one-line stderr notice (at most
 * daily per release) when it is newer than this CLI, and starts a detached
 * refresh when the cache is a day old. The command itself never waits on npm.
 * Returns undefined when the check is disabled.
 */
export function startUpdateCheck(
  options: UpdateCheckOptions,
): UpdateCheck | undefined {
  if (!updateCheckEnabled(options)) return undefined;
  const now = options.now ?? Date.now;
  const cachePath = options.cachePath ?? defaultUpdateCachePath();
  const refresh = options.refresh ?? spawnRefresh;
  const cached = readCache(cachePath);

  return {
    async finish(writeErr) {
      try {
        let cache = await cached;
        const time = now();
        const due =
          (cache.checkedAt === undefined || time - cache.checkedAt >= day) &&
          (cache.attemptedAt === undefined || time - cache.attemptedAt >= hour);
        const announce =
          cache.latest !== undefined &&
          newer(cache.latest, options.version) &&
          !(
            cache.notifiedVersion === cache.latest &&
            cache.notifiedAt !== undefined &&
            time - cache.notifiedAt < day
          );
        if (announce)
          writeErr(
            `agent-workplace ${cache.latest} is available (you have ${options.version}). ` +
              "Update: npm i -g agent-workplace@latest. " +
              "Changes: https://agentworkplace.dev/changelog\n",
          );
        if (!due && !announce) return;
        cache = {
          ...cache,
          ...(due ? { attemptedAt: time } : {}),
          ...(announce
            ? { notifiedAt: time, notifiedVersion: cache.latest! }
            : {}),
        };
        await writeCache(cachePath, cache);
        if (due) refresh(cachePath);
      } catch {
        // The notice is advisory; a failure never affects the command.
      }
    },
  };
}
