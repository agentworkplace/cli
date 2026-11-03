import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { CliConfigurationError } from "./errors.js";

function checkPermissions(
  stat: Stats,
  directory: boolean,
  label: string,
  path: string,
) {
  const kind = directory ? "directory" : "file";
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new CliConfigurationError(
      `${label} files and directories must be owned by you and accessible only to you; ${path} is not a regular ${kind}`,
    );
  if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new CliConfigurationError(
      `${label} files and directories must be owned by you and accessible only to you; make ${path} yours and run chmod ${directory ? "700" : "600"} on it`,
    );
}

type PrivateFileOptions<Value> = {
  label: string;
  maximumBytes: number;
  validate(value: unknown): Value;
  createOnly?: boolean;
};
type PrivateFileOperation<Value, Result> = (store: {
  assertOwned(): void;
  read(): Promise<Value | undefined>;
  write(value: Value): Promise<void>;
}) => Promise<Result>;

export function withPrivateJsonFile<Value, Result>(
  path: string,
  options: PrivateFileOptions<Value>,
  operation: PrivateFileOperation<Value, Result>,
) {
  return withPrivateFile(
    path,
    {
      ...options,
      decode: (text: string) => JSON.parse(text) as unknown,
      encode: (value: Value) => JSON.stringify(value) + "\n",
    },
    operation,
  );
}

export function withPrivateTextFile<Result>(
  path: string,
  options: PrivateFileOptions<string>,
  operation: PrivateFileOperation<string, Result>,
) {
  return withPrivateFile(
    path,
    {
      ...options,
      decode: (text: string) => text.trimEnd(),
      encode: (value: string) => value + "\n",
    },
    operation,
  );
}

async function withPrivateFile<Value, Result>(
  configuredPath: string,
  options: PrivateFileOptions<Value> & {
    decode(text: string): unknown;
    encode(value: Value): string;
  },
  operation: PrivateFileOperation<Value, Result>,
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
  checkPermissions(await lstat(directory), true, options.label, directory);
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
          checkPermissions(await handle.stat(), false, options.label, path);
          if ((await handle.stat()).size > options.maximumBytes)
            throw new CliConfigurationError(`Invalid ${name} file`);
          return options.validate(
            options.decode(await handle.readFile("utf8")),
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
        // Values being saved come from this command's inputs, so a rejection
        // here is an input problem, not a damaged file.
        const rejected = () =>
          new CliConfigurationError(
            `The command's options don't form a valid ${name}; check them and retry`,
          );
        try {
          options.validate(value);
        } catch {
          throw rejected();
        }
        const serialized = options.encode(value);
        if (Buffer.byteLength(serialized, "utf8") > options.maximumBytes)
          throw rejected();
        // Reject an existing unsafe destination rather than silently replacing it.
        try {
          checkPermissions(await lstat(path), false, options.label, path);
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
          if (options.createOnly) await link(temporary, path);
          else await rename(temporary, path);
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
    // A compromised lock makes release() reject; never let that replace the
    // operation's own outcome, which may already have been printed.
    await release().catch(() => {});
  }
}
