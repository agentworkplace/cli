// Verify the exact local archive in a clean consumer directory. Never publishes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const artifact = JSON.parse(
  await readFile(join(root, "tmp/release/artifact.json"), "utf8"),
);
const archive = await readFile(artifact.archive);
assert.equal(
  createHash("sha256").update(archive).digest("hex"),
  artifact.sha256,
);
const { stdout } = await exec("tar", [
  "-xOf",
  artifact.archive,
  "package/package.json",
]);
const manifest = JSON.parse(stdout);
assert.equal(manifest.name, artifact.name);
assert.equal(manifest.version, artifact.version);
assert.equal(manifest.private, false);
assert.equal(manifest.license, "MIT");
assert.equal(manifest.scripts, undefined);
assert.equal(manifest.devDependencies, undefined);
assert.match(
  manifest.repository.url,
  /^git\+https:\/\/github\.com\/agentworkplace\/(sdk-ts|cli)\.git$/,
);
assert.ok(
  Object.keys(manifest.dependencies ?? {}).every(
    (name) => !name.startsWith("@" + "repo/"),
  ) &&
    Object.values(manifest.dependencies ?? {}).every(
      (value) => !value.startsWith("workspace" + ":"),
    ),
);

const consumer = await mkdtemp(join(tmpdir(), "awp-public-source-consumer-"));
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "archive-validation",
      private: true,
      type: "module",
    }),
  );
  await writeFile(join(consumer, ".npmrc"), "");
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      "--userconfig",
      join(consumer, ".npmrc"),
      artifact.archive,
    ],
    { cwd: consumer },
  );
  if (artifact.name === "agent-workplace") {
    const { stdout: version } = await exec(
      join(consumer, "node_modules/.bin/agent-workplace"),
      ["--version"],
      { cwd: consumer },
    );
    assert.equal(version.trim(), artifact.version);
  } else {
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { AgentWorkplace } from "@agent-workplace/sdk"; new AgentWorkplace({baseUrl:"https://api.example.test"});',
      ],
      { cwd: consumer },
    );
  }
  console.log(
    `Validated ${artifact.name}@${artifact.version} from its release archive`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
