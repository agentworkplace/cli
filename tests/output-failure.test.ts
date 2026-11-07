import { expect, test, vi } from "vitest";
import { OutputWriteError, presentError } from "../src/errors.js";
import { runCli } from "../src/program.js";

async function run(
  args: string[],
  outputFailure: () => Error | undefined,
  onWrite?: () => void,
) {
  let stderr = "";
  const code = await runCli(args, {
    version: "1.2.3",
    writeOut: () => onWrite?.(),
    writeErr: (value) => {
      stderr += value;
    },
    outputFailure,
  });
  return { code, stderr };
}

test("a failed write fails a command that otherwise succeeded", async () => {
  await expect(
    run(["--version"], () => new OutputWriteError("EIO")),
  ).resolves.toEqual({
    code: 1,
    stderr:
      "Error: Unable to write output (EIO)\nThe command may have finished; check its result before repeating it\n",
  });
});

test("--json reports it as one JSON line with a code", async () => {
  const { code, stderr } = await run(
    ["--version", "--json"],
    () => new OutputWriteError("EIO"),
  );
  expect(code).toBe(1);
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(JSON.parse(stderr)).toEqual({
    error: {
      message: "Unable to write output (EIO)",
      code: "cli_error",
      hint: "The command may have finished; check its result before repeating it",
    },
  });
});

test("a failure reported on a later tick still counts", async () => {
  let failure: Error | undefined;
  const { code } = await run(
    ["--version"],
    () => failure,
    () =>
      process.nextTick(() => {
        failure = new OutputWriteError("EIO");
      }),
  );
  expect(code).toBe(1);
});

test("a command that failed keeps its own status and error", async () => {
  const outputFailure = vi.fn(() => new OutputWriteError("EIO"));
  const { code, stderr } = await run(["no-such-command"], outputFailure);
  expect(code).toBe(1);
  expect(stderr).toMatch(/unknown command/);
  expect(outputFailure).not.toHaveBeenCalled();
});

test("no failure leaves a successful command alone", async () => {
  await expect(run(["--version"], () => undefined)).resolves.toEqual({
    code: 0,
    stderr: "",
  });
});

test("a saved operation says how to retry safely", () => {
  expect(
    presentError(new OutputWriteError(undefined), { operation: true }),
  ).toEqual({
    message: "Unable to write output",
    code: "cli_error",
    hint: "Retry with the same --operation, which can't apply twice",
  });
});
