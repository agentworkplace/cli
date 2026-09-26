import { DocumentationClient } from "@agent-workplace/sdk";
import type {
  DocumentationPage,
  DocumentationReadResult,
  DocumentationSearchResult,
} from "@agent-workplace/sdk";
import type { WriteOutput } from "../output.js";

export const productionDocsOrigin = "https://docs.agentworkplace.dev";

export interface DocsClient {
  list(): Promise<DocumentationPage[]>;
  search(query: string): Promise<DocumentationSearchResult[]>;
  read(path: string): Promise<DocumentationReadResult>;
}

export type CreateDocsClient = (baseUrl: string) => DocsClient;

const defaultCreateClient: CreateDocsClient = (baseUrl) =>
  new DocumentationClient({ baseUrl });

const unsafeTerminalText =
  // eslint-disable-next-line no-control-regex -- Terminal output must visibly escape these bytes.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const unsafeInlineText =
  // eslint-disable-next-line no-control-regex -- Titles and excerpts must stay on one terminal line.
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function visible(value: string, multiline = false): string {
  return value.replace(
    multiline ? unsafeTerminalText : unsafeInlineText,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

function json(value: unknown): string {
  return `${JSON.stringify(value).replace(
    /[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  )}\n`;
}

export interface DocsCommandOptions {
  createClient?: CreateDocsClient;
  json: boolean;
  write: WriteOutput;
}

function client(options: DocsCommandOptions): DocsClient {
  return (options.createClient ?? defaultCreateClient)(productionDocsOrigin);
}

export async function executeDocsListOrRead(
  path: string | undefined,
  options: DocsCommandOptions,
): Promise<void> {
  if (path !== undefined) {
    const page = await client(options).read(path);
    options.write(
      options.json
        ? json(page)
        : `${visible(page.markdown, true)}${page.markdown.endsWith("\n") ? "" : "\n"}`,
    );
    return;
  }

  const pages = await client(options).list();
  if (options.json) {
    options.write(json({ pages }));
    return;
  }
  let previous = "";
  for (const page of pages) {
    const group = page.group.join(" / ");
    if (group !== previous) {
      options.write(`${previous ? "\n" : ""}${visible(group)}\n`);
      previous = group;
    }
    options.write(`  ${visible(page.title)} — ${visible(page.path)}\n`);
    if (page.description) options.write(`    ${visible(page.description)}\n`);
  }
}

export async function executeDocsSearch(
  query: string,
  options: DocsCommandOptions,
): Promise<void> {
  const results = await client(options).search(query);
  if (options.json) {
    options.write(json({ results }));
    return;
  }
  if (results.length === 0) {
    options.write("No documentation pages found.\n");
    return;
  }
  for (const result of results) {
    options.write(`${visible(result.title)} — ${visible(result.path)}\n`);
    if (result.excerpt) options.write(`  ${visible(result.excerpt)}\n`);
  }
}
