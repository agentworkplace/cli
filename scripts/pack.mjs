// Build an npm archive from reviewed release files, without development scripts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = join(root, "tmp/release");

async function modules(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await modules(directory, path)));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    )
      result.push(path.slice(0, -3));
    else if (!entry.isFile()) throw new Error("Unexpected source entry");
  }
  return result.sort();
}

assert.equal(source.private, false);
assert.equal(source.license, "MIT");
assert.match(
  source.repository?.url ?? "",
  /^git\+https:\/\/github\.com\/agentworkplace\/(sdk-ts|cli)\.git$/,
);
assert.equal(source.publishConfig?.registry, "https://registry.npmjs.org");
assert.ok(
  Object.keys(source.dependencies ?? {}).every(
    (name) => !name.startsWith("@" + "repo/"),
  ) &&
    Object.values(source.dependencies ?? {}).every(
      (range) => !range.startsWith("workspace" + ":"),
    ),
);
const isSdk = source.name === "@agent-workplace/sdk";
assert.ok(isSdk || source.name === "agent-workplace");
assert.ok(source.repository.url.endsWith(isSdk ? "/sdk-ts.git" : "/cli.git"));

const staging = await mkdtemp(join(tmpdir(), "awp-public-source-pack-"));
try {
  const packageDir = join(staging, "package");
  const archives = join(staging, "archives");
  await mkdir(packageDir);
  await mkdir(archives);
  const release = Object.fromEntries(
    [
      "name",
      "version",
      "private",
      "type",
      "description",
      "license",
      "author",
      "homepage",
      "bugs",
      "repository",
      "engines",
      "files",
      "publishConfig",
      "dependencies",
      "exports",
      ...(isSdk ? ["sideEffects"] : ["bin"]),
    ].map((key) => [key, source[key]]),
  );
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(release, null, 2) + "\n",
  );
  for (const name of ["README.md", "LICENSE", "NOTICE", "CHANGELOG.md"])
    await copyFile(join(root, name), join(packageDir, name));
  const readme = await readFile(join(packageDir, "README.md"), "utf8");
  assert.ok(readme.includes(`${source.name}@${source.version}`));
  for (const module of await modules(join(root, "src"))) {
    for (const extension of [".js", ".d.ts"]) {
      const name = module + extension;
      const content = await readFile(join(root, "dist", name), "utf8");
      assert.ok(
        !["@" + "repo/", "workspace" + ":", "sourceMappingURL"].some((value) =>
          content.includes(value),
        ),
      );
      const destination = join(packageDir, "dist", name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
  if (!isSdk) await chmod(join(packageDir, "dist/index.js"), 0o755);
  const { stdout } = await exec(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", archives],
    { cwd: packageDir },
  );
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.id, `${source.name}@${source.version}`);
  assert.ok(
    packed.files.every(
      ({ path }) =>
        [
          "package.json",
          "README.md",
          "LICENSE",
          "NOTICE",
          "CHANGELOG.md",
        ].includes(path) || /^dist\/[a-zA-Z0-9_./-]+\.(js|d\.ts)$/.test(path),
    ),
  );
  const archive = await readFile(join(archives, packed.filename));
  const sha256 = createHash("sha256").update(archive).digest("hex");
  await mkdir(output, { recursive: true });
  const destination = join(output, packed.filename);
  try {
    const existing = await readFile(destination);
    assert.equal(
      createHash("sha256").update(existing).digest("hex"),
      sha256,
      "An existing archive for this version has different bytes",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(destination, archive, { flag: "wx" });
  }
  const result = {
    name: source.name,
    version: source.version,
    archive: destination,
    sha256,
  };
  await writeFile(
    join(output, "artifact.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(staging, { recursive: true, force: true });
}
