import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { CliConfigurationError } from "./errors.js";

function checkPermissions(stat: Stats, directory: boolean, label: string) {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new CliConfigurationError(
      `${label} files and directories must be owned by you and accessible only to you`,
    );
}

export async function withPrivateJsonFile<Value, Result>(
  configuredPath: string,
  options: {
    label: string;
    maximumBytes: number;
    validate(value: unknown): Value;
  },
  operation: (store: {
    assertOwned(): void;
    read(): Promise<Value | undefined>;
    write(value: Value): Promise<void>;
  }) => Promise<Result>,
) {
  const name = options.label.toLowerCase();
  // POSIX mode bits cannot establish a restrictive Windows ACL. Fail closed.
  if (process.platform === "win32")
    throw new CliConfigurationError(
      `Secure ${name} storage currently requires a POSIX filesystem`,
    );
  const path = resolve(configuredPath);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  checkPermissions(await lstat(directory), true, options.label);
  let compromised = false;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 10_000,
      update: 2000,
      retries: { retries: 12, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch {
    throw new CliConfigurationError(
      `${options.label} storage is busy; retry after the other process finishes`,
    );
  }
  const checkLock = () => {
    if (compromised)
      throw new CliConfigurationError(
        `${options.label} storage lock was lost; retry the command`,
      );
  };
  try {
    return await operation({
      assertOwned: checkLock,
      async read() {
        checkLock();
        let handle;
        try {
          handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw new CliConfigurationError(`Unable to open ${name} file safely`);
        }
        try {
          checkPermissions(await handle.stat(), false, options.label);
          if ((await handle.stat()).size > options.maximumBytes)
            throw new CliConfigurationError(`Invalid ${name} file`);
          return options.validate(
            JSON.parse(await handle.readFile("utf8")) as unknown,
          );
        } catch (error) {
          if (error instanceof CliConfigurationError) throw error;
          throw new CliConfigurationError(`Invalid ${name} file`);
        } finally {
          await handle.close();
        }
      },
      async write(value) {
        checkLock();
        options.validate(value);
        const serialized = JSON.stringify(value) + "\n";
        if (Buffer.byteLength(serialized, "utf8") > options.maximumBytes)
          throw new CliConfigurationError(`Invalid ${name} file`);
        // Reject an existing unsafe destination rather than silently replacing it.
        try {
          checkPermissions(await lstat(path), false, options.label);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
        const handle = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
          await handle.close();
          checkLock();
          await rename(temporary, path);
          const parent = await open(directory, constants.O_RDONLY);
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await handle.close();
          await unlink(temporary).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
      },
    });
  } finally {
    await release();
  }
}
