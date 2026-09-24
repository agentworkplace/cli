import { AgentWorkplace } from "@agent-workplace/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withCredentials } from "../src/credentials.js";
import { runCli } from "../src/program.js";

it.each([
  "status",
  "cancel",
  "resume",
  "command",
  "upgrade",
  "purchase",
  "payment",
  "invoices",
  "invoice-link",
] as const)(
  "prints exact %s billing JSON using only the SDK and saved credential",
  async (action) => {
    const directory = await mkdtemp(join(tmpdir(), "awp-billing-cli-"));
    const credentials = join(directory, "credentials.json");
    const id = "11111111-1111-4111-8111-111111111111";
    const status = {
      workplaceId: id,
      plan: "starter",
      pendingCommand: null,
      price: { currency: "usd", monthlyAmount: 2000 },
      subscription: null,
    };
    const command = {
      id,
      action: action === "resume" ? "resume" : "cancel",
      state: "pending",
      requestedAt: "2026-09-21T00:00:00.000Z",
    };
    const purchase = {
      id,
      state: "pending",
      requestedAt: command.requestedAt,
      expiresAt: "2026-09-21T01:00:00.000Z",
    };
    const output =
      action === "invoices"
        ? { invoices: [], next: "in_next" }
        : action === "invoice-link"
          ? { kind: "invoice", url: "https://invoice.stripe.com/i/private" }
          : action === "status"
            ? status
            : action === "payment"
              ? { kind: "pending" }
              : action === "upgrade" || action === "purchase"
                ? purchase
                : command;
    try {
      await withCredentials(credentials, (store) =>
        store.write({
          version: 1,
          kind: "account",
          origin: "https://api.example.test",
          credential: { accountId: id, workplaceId: id, key: "fixture-key" },
        }),
      );
      let stdout = "",
        stderr = "";
      const exitCode = await runCli(
        [
          "--credentials",
          credentials,
          "workplace",
          "billing",
          action,
          ...(action === "invoices"
            ? ["--after", "in_cursor"]
            : action === "invoice-link"
              ? ["in_example"]
              : action === "upgrade"
                ? ["--purchase-id", id]
                : action === "payment"
                  ? ["--purchase-id", id]
                  : action === "purchase"
                    ? [id]
                    : action === "command"
                      ? [id]
                      : action === "status"
                        ? []
                        : ["--command-id", id, "--revision", id]),
          "--json",
        ],
        {
          version: "0.0.0",
          writeOut: (value) => {
            stdout += value;
          },
          writeErr: (value) => {
            stderr += value;
          },
          createProductClient: (baseUrl) =>
            new AgentWorkplace({
              baseUrl,
              fetch: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === "/v1/access/account")
                  return Response.json({
                    accountId: id,
                    workplaceId: id,
                    kind: "agent",
                    role: "admin",
                    state: "active",
                    workplaceState: "unconfirmed",
                    cleanupAt: "2026-10-21T00:00:00.000Z",
                    cleanupWarning: null,
                    free: null,
                    starter: {
                      outboundLimit: 2,
                      inboundLimit: 20,
                      storageLimit: "100 MB",
                      outboundUsed: 0,
                      inboundUsed: 0,
                      storageUsedBytes: 0,
                    },
                  });
                expect(path).toBe(
                  action === "invoices"
                    ? "/v1/workplace/billing/invoices"
                    : action === "invoice-link"
                      ? "/v1/workplace/billing/invoices/in_example/link"
                      : action === "upgrade"
                        ? "/v1/workplace/billing/purchases"
                        : action === "purchase"
                          ? `/v1/workplace/billing/purchases/${id}`
                          : action === "payment"
                            ? "/v1/workplace/billing/payment"
                            : action === "status"
                              ? "/v1/workplace/billing"
                              : action === "command"
                                ? `/v1/workplace/billing/commands/${id}`
                                : "/v1/workplace/billing/commands",
                );
                if (action === "invoices")
                  expect(new URL(String(url)).searchParams.get("after")).toBe(
                    "in_cursor",
                  );
                if (action === "invoice-link")
                  expect(init?.method).toBe("POST");
                if (action === "upgrade" || action === "payment") {
                  expect(init?.method).toBe("POST");
                  expect(JSON.parse(String(init?.body))).toEqual(
                    action === "upgrade" ? { id } : { purchaseId: id },
                  );
                }
                if (action === "cancel" || action === "resume") {
                  expect(init?.method).toBe("POST");
                  expect(JSON.parse(String(init?.body))).toEqual({
                    id,
                    action,
                    expectedRevision: id,
                  });
                }
                expect(new Headers(init?.headers).get("Authorization")).toBe(
                  "Bearer fixture-key",
                );
                return Response.json(output);
              },
            }),
        },
      );
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe(JSON.stringify(output) + "\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
