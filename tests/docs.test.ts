import { DocumentationError } from "@agent-workplace/sdk";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/program.js";
import type { RunCliOptions } from "../src/program.js";

const pages = [
  {
    path: "/documentation/get-started/quick-start",
    title: "Quick Start",
    description: "Sign up",
    group: ["Documentation", "Get Started"],
  },
  {
    path: "/api/reference/mail/sendMail",
    title: "Send Mail API",
    description: "POST /v1/mail",
    group: ["API Reference", "Endpoints", "Mail"],
  },
];
const results = [
  {
    path: "/documentation/get-started/quick-start",
    title: "Quick Start",
    excerpt: "Create a workplace",
  },
];

async function invoke(args: string[], override: Partial<RunCliOptions> = {}) {
  let stdout = "";
  let stderr = "";
  const createDocsClient = vi.fn(() => ({
    list: vi.fn(async () => pages),
    search: vi.fn(async () => results),
    read: vi.fn(async (path: string) => ({
      path: path.startsWith("/") ? path : `/${path}`,
      title: "Send Mail",
      markdown: "# Send Mail\n\n```sh\necho hello\n```",
    })),
  }));
  const exitCode = await runCli(args, {
    version: "0.1.1",
    createDocsClient,
    ...override,
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr, createDocsClient };
}

describe("docs command", () => {
  it("lists grouped titles, descriptions and canonical paths without credentials", async () => {
    vi.stubEnv("AGENT_WORKPLACE_API_URL", "https://another-api.example");
    vi.stubEnv(
      "AGENT_WORKPLACE_CREDENTIALS_FILE",
      "/missing/private/credentials.json",
    );
    try {
      const result = await invoke(["docs"]);
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toBe(
        "Documentation / Get Started\n" +
          "  Quick Start — /documentation/get-started/quick-start\n" +
          "    Sign up\n\n" +
          "API Reference / Endpoints / Mail\n" +
          "  Send Mail API — /api/reference/mail/sendMail\n" +
          "    POST /v1/mail\n",
      );
      expect(result.createDocsClient).toHaveBeenCalledExactlyOnceWith(
        "https://docs.agentworkplace.dev",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads a bare path as Markdown and preserves code fences", async () => {
    const result = await invoke(["docs", "documentation/guides/send-mail"]);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "# Send Mail\n\n```sh\necho hello\n```\n",
      stderr: "",
    });
  });

  it("searches and emits plain or structured output", async () => {
    expect(await invoke(["docs", "search", "signup"])).toMatchObject({
      exitCode: 0,
      stdout:
        "Quick Start — /documentation/get-started/quick-start\n  Create a workplace\n",
      stderr: "",
    });
    expect(await invoke(["docs", "search", "signup", "--json"])).toMatchObject({
      exitCode: 0,
      stdout: `${JSON.stringify({ results })}\n`,
      stderr: "",
    });
    expect(await invoke(["docs", "--json"])).toMatchObject({
      exitCode: 0,
      stdout: `${JSON.stringify({ pages })}\n`,
    });
  });

  it("reports no matches successfully", async () => {
    const createDocsClient = () => ({
      list: async () => pages,
      read: async () => {
        throw new Error();
      },
      search: async () => [],
    });
    expect(
      await invoke(["docs", "search", "none"], { createDocsClient }),
    ).toMatchObject({
      exitCode: 0,
      stdout: "No documentation pages found.\n",
      stderr: "",
    });
    expect(
      await invoke(["docs", "search", "none", "--json"], { createDocsClient }),
    ).toMatchObject({
      exitCode: 0,
      stdout: '{"results":[]}\n',
      stderr: "",
    });
  });

  it("escapes terminal controls in human output and JSON text", async () => {
    const markdown =
      "# Hello\n\u001b[31m\u202e \u007f\u009b\u009c\u009d text\n";
    const createDocsClient = () => ({
      list: async () => pages,
      search: async () => results,
      read: async () => ({ path: "/documentation", title: "Hello", markdown }),
    });
    expect(
      await invoke(["docs", "/documentation"], { createDocsClient }),
    ).toMatchObject({
      exitCode: 0,
      stdout: "# Hello\n\\u001b[31m\\u202e \\u007f\\u009b\\u009c\\u009d text\n",
      stderr: "",
    });
    const structured = await invoke(["docs", "/documentation", "--json"], {
      createDocsClient,
    });
    for (const character of ["\u202e", "\u007f", "\u009b", "\u009c", "\u009d"])
      expect(structured.stdout).not.toContain(character);
    expect(JSON.parse(structured.stdout)).toEqual({
      path: "/documentation",
      title: "Hello",
      markdown,
    });

    const listWithControl = () => ({
      list: async () => [{ ...pages[0]!, title: "Hello\n\u001b[31m" }],
      search: async () => results,
      read: async () => {
        throw new Error();
      },
    });
    const listed = await invoke(["docs"], {
      createDocsClient: listWithControl,
    });
    expect(listed.stdout).toContain("Hello\\u000a\\u001b[31m");

    const special = "Name\u007f\u009b\u009c\u009d\u202e";
    const structuredClient = () => ({
      list: async () => [
        { ...pages[0]!, title: special, description: special },
      ],
      search: async () => [
        { ...results[0]!, title: special, excerpt: special },
      ],
      read: async () => ({ path: "/documentation", title: special, markdown }),
    });
    for (const args of [
      ["docs", "--json"],
      ["docs", "search", "x", "--json"],
    ]) {
      const result = await invoke(args, { createDocsClient: structuredClient });
      for (const character of [
        "\u007f",
        "\u009b",
        "\u009c",
        "\u009d",
        "\u202e",
      ])
        expect(result.stdout).not.toContain(character);
      expect(result.stdout).toContain("\\u009b");
      const parsed = JSON.parse(result.stdout);
      expect(
        args.length === 2 ? parsed.pages[0].title : parsed.results[0].title,
      ).toBe(special);
    }
  });

  it("puts safe typed failures on stderr with exit 1", async () => {
    for (const [code, status] of [
      ["invalid_path", undefined],
      ["not_found", 404],
    ] as const) {
      const createDocsClient = () => ({
        list: async () => pages,
        search: async () => results,
        read: async () => {
          throw new DocumentationError(
            "Documentation unavailable",
            code,
            status,
          );
        },
      });
      const result = await invoke(["docs", "/documentation", "--json"], {
        createDocsClient,
      });
      expect(result).toMatchObject({ exitCode: 1, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code, ...(status ? { status } : {}) },
      });
    }
  });

  it("keeps command help local", async () => {
    const createDocsClient = vi.fn();
    const result = await invoke(["docs", "--help"], { createDocsClient });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("search");
    expect(createDocsClient).not.toHaveBeenCalled();
  });
});
