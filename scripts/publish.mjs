// Manual, reviewed-commit publication from a GitHub-hosted public repository.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const registry = "https://registry.npmjs.org";
const identities = {
  "@agent-workplace/sdk": "agentworkplace/sdk-ts",
  "agent-workplace": "agentworkplace/cli",
};

export function validatePublication(env, source, packed) {
  const repository = identities[source.name];
  assert.ok(repository, "Unexpected npm package identity");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.match(env.REVIEWED_SHA ?? "", /^[0-9a-f]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_SHA);
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${repository}/.github/workflows/publish.yml@refs/heads/main`,
  );
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  assert.equal(env.NPM_CONFIG_PROVENANCE, "true");
  assert.equal(source.name, packed.name);
  assert.equal(source.version, packed.version);
  assert.equal(source.version, env.RELEASE_VERSION);
  assert.equal(source.private, false);
  assert.equal(packed.private, false);
  assert.equal(source.license, "MIT");
  assert.equal(packed.license, "MIT");
  assert.equal(packed.scripts, undefined);
  assert.equal(packed.devDependencies, undefined);
  assert.equal(
    packed.repository?.url,
    `git+https://github.com/${repository}.git`,
  );
  assert.equal(source.repository?.url, packed.repository.url);
  assert.equal(packed.publishConfig?.registry, registry);
  assert.equal(packed.publishConfig?.access, "public");
  assert.notEqual(packed.publishConfig?.provenance, false);
  assert.ok(
    Object.keys(packed.dependencies ?? {}).every(
      (name) => !name.startsWith("@" + "repo/"),
    ) &&
      Object.values(packed.dependencies ?? {}).every(
        (range) => !range.startsWith("workspace" + ":"),
      ),
  );
  if (env.RELEASE_TAG === "latest")
    assert.match(source.version, /^(?!0\.0\.0$)\d+\.\d+\.\d+$/);
  else if (env.RELEASE_TAG === "next")
    assert.match(source.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
  else throw new Error("Unexpected npm distribution tag");
}

async function registryVersion(name, version) {
  const response = await fetch(
    `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`npm registry metadata request failed: ${response.status}`);
  return response.json();
}

async function main() {
  const env = process.env;
  const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const artifact = JSON.parse(
    await readFile(join(root, "tmp/release/artifact.json"), "utf8"),
  );
  const archivePath = resolve(artifact.archive);
  const releaseDir = join(root, "tmp/release");
  const archiveRel = relative(releaseDir, archivePath);
  assert.ok(
    archiveRel &&
      archiveRel !== ".." &&
      !archiveRel.startsWith(`..${sep}`) &&
      !archiveRel.startsWith(sep) &&
      archiveRel.endsWith(".tgz"),
    "Archive must be inside this checkout's release directory",
  );
  const archive = await readFile(archivePath);
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    artifact.sha256,
  );
  const { stdout } = await exec("tar", [
    "-xOf",
    archivePath,
    "package/package.json",
  ]);
  const packed = JSON.parse(stdout);
  validatePublication(env, source, packed);
  assert.equal(artifact.name, source.name);
  assert.equal(artifact.version, source.version);
  assert.equal(
    (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
    env.REVIEWED_SHA,
  );
  assert.equal(
    (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim(),
    "",
  );
  assert.equal((await exec("npm", ["--version"])).stdout.trim(), "11.11.0");
  if (await registryVersion(source.name, source.version))
    throw new Error("This npm version already exists; never republish it");
  await new Promise((resolvePublish, reject) => {
    const child = spawn(
      "npm",
      [
        "publish",
        archivePath,
        `--registry=${registry}`,
        "--access=public",
        "--ignore-scripts",
        `--tag=${env.RELEASE_TAG}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePublish()
        : reject(new Error("npm publication failed; inspect registry state")),
    );
  });
  console.log(
    `Published ${source.name}@${source.version} from reviewed public source`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
