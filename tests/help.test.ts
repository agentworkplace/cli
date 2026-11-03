import { Command } from "commander";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../src/program.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build the real command tree without parsing anything. */
async function commandTree() {
  const parse = vi
    .spyOn(Command.prototype, "parseAsync")
    .mockImplementation(function (this: Command) {
      return Promise.resolve(this);
    });
  await runCli([], { version: "0.0.0", writeOut() {}, writeErr() {} });
  const root = parse.mock.contexts[0] as Command | undefined;
  if (!root) throw new Error("The program was not constructed");
  const commands: { path: string; command: Command }[] = [];
  const visit = (command: Command, path: string) => {
    for (const child of command.commands) {
      const childPath = `${path} ${child.name()}`.trim();
      commands.push({ path: childPath, command: child });
      visit(child, childPath);
    }
  };
  visit(root, "");
  return commands;
}

test("every command has a description", async () => {
  const blank = (await commandTree())
    .filter(({ command }) => !command.description().trim())
    .map(({ path }) => path);
  expect(blank).toEqual([]);
});

test("commands in a family do not share a description", async () => {
  const commands = await commandTree();
  const duplicates = commands
    .filter(
      ({ path, command }, index) =>
        command.description() &&
        commands.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.command.parent === command.parent &&
            other.command.description() === command.description() &&
            other.path !== path,
        ),
    )
    .map(({ path }) => path);
  expect(duplicates).toEqual([]);
});
