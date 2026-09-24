import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  AgentWorkplaceError,
  type AgentWorkplace,
  type MailExportScope,
} from "@agent-workplace/sdk";
import { CliConfigurationError, presentError } from "./errors.js";
import { withPrivateJsonFile } from "./private-file.js";
import { exportMailBytes } from "./mail-export-bytes.js";
import {
  checkMailExportDirectory,
  createMailInventory,
  invalidMailExport,
  mailExportIdentity,
  mailExportPrivateStat,
  readMailInventory,
  syncMailExportDirectory,
  type MailExportIdentity,
  type MailInventory,
} from "./mail-export-inventory.js";

type Context = { origin: string; accountId: string; workplaceId: string };
type Receipt = {
  version: 1;
  binding: string;
  output: string;
  storage: string;
  outputIdentity: MailExportIdentity | null;
  storageIdentity: MailExportIdentity | null;
  inventory: MailInventory | null;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function validIdentity(value: MailExportIdentity | null) {
  return (
    value === null ||
    (typeof value === "object" &&
      Object.keys(value).sort().join() === "dev,ino" &&
      /^\d{1,24}$/.test(value.dev) &&
      /^\d{1,24}$/.test(value.ino))
  );
}
async function exists(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** HTTP/SDK-only retained Mail export. The private inventory freezes observed
 * bodies and immutable attachment metadata; every retry uses the same plan.
 * Completed local payloads remain local even if their source later disappears. */
export async function exportMailLocally(
  client: AgentWorkplace,
  key: string,
  context: Context,
  input: {
    mailboxId: string;
    scope: MailExportScope;
    output: string;
    operation: string;
  },
) {
  if (process.platform === "win32")
    throw new CliConfigurationError(
      "Secure Mail export recovery requires a POSIX filesystem",
    );
  const mailboxId = input.mailboxId.toLowerCase();
  if (
    !uuid.test(mailboxId) ||
    !["mailbox", "message", "thread"].includes(input.scope.kind) ||
    (input.scope.kind !== "mailbox" && !uuid.test(input.scope.messageId))
  )
    throw new CliConfigurationError(
      "Specify a Mailbox UUID and valid export scope",
    );
  const scope = { ...input.scope };
  const output = join(
      await realpath(dirname(resolve(input.output))),
      basename(resolve(input.output)),
    ),
    operation = join(
      await realpath(dirname(resolve(input.operation))),
      basename(resolve(input.operation)),
    );
  const relation = relative(output, operation);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !relation.startsWith(sep))
  )
    throw new CliConfigurationError(
      "Mail export operation must be outside the destination directory",
    );
  const binding = sha(JSON.stringify({ ...context, mailboxId, scope, output }));
  return withPrivateJsonFile(
    operation,
    {
      label: "Mail export operation",
      maximumBytes: 16384,
      validate(value): Receipt {
        try {
          const r = value as Receipt;
          if (
            !r ||
            Object.keys(r).sort().join() !==
              "binding,inventory,output,outputIdentity,storage,storageIdentity,version" ||
            r.version !== 1 ||
            r.binding !== binding ||
            r.output !== output ||
            dirname(r.storage) !== dirname(operation) ||
            !/^\.awp-mail-export-[0-9a-f-]{36}$/.test(basename(r.storage)) ||
            !validIdentity(r.outputIdentity) ||
            !validIdentity(r.storageIdentity)
          )
            throw invalidMailExport();
          const i = r.inventory;
          if (
            i !== null &&
            (!i ||
              Object.keys(i).sort().join() !==
                "checkpoint,count,hash,identity,indexIdentity,name" ||
              !/^inventory-[A-Za-z0-9]+$/.test(i.name) ||
              !i.identity ||
              !i.indexIdentity ||
              !validIdentity(i.identity) ||
              !validIdentity(i.indexIdentity) ||
              !Number.isSafeInteger(i.count) ||
              i.count < 2 ||
              !/^[a-f0-9]{64}$/.test(i.hash) ||
              typeof i.checkpoint !== "string" ||
              !i.checkpoint.length ||
              i.checkpoint.length > 512)
          )
            throw invalidMailExport();
          return r;
        } catch {
          throw invalidMailExport();
        }
      },
    },
    async (store) => {
      let r = await store.read();
      if (!r) {
        if (await exists(output))
          throw new CliConfigurationError(
            "Export destination already exists; choose a new directory",
          );
        r = {
          version: 1,
          binding,
          output,
          storage: join(dirname(operation), `.awp-mail-export-${randomUUID()}`),
          outputIdentity: null,
          storageIdentity: null,
          inventory: null,
        };
        await store.write(r);
      }
      for (const [path, field] of [
        [r.storage, "storageIdentity"],
        [output, "outputIdentity"],
      ] as const) {
        const stat = await exists(path);
        if (stat && !r[field]) throw invalidMailExport();
        if (!stat) {
          if (r[field]) throw invalidMailExport();
          await mkdir(path, { mode: 0o700 });
          await syncMailExportDirectory(dirname(path));
          const created = await lstat(path, { bigint: true });
          mailExportPrivateStat(created, true);
          r = { ...r, [field]: mailExportIdentity(created) };
          await store.write(r);
        }
        await checkMailExportDirectory(path, r[field]!);
      }
      const check = async () => {
        store.assertOwned();
        await checkMailExportDirectory(output, r!.outputIdentity!);
        await checkMailExportDirectory(r!.storage, r!.storageIdentity!);
      };
      if (!r.inventory) {
        const inventory = await createMailInventory(
          r.storage,
          check,
          (visits) =>
            client.walkRetainedMail(
              { apiKey: key },
              { mailboxId, scope },
              visits,
            ),
        );
        r = { ...r, inventory };
        await store.write(r);
      }
      const inventory = r.inventory!;
      const payload = (
        name: string,
        bytes: number,
        digest: string,
        load: () => Promise<Uint8Array>,
      ) => {
        if (!/^[A-Za-z0-9.-]+$/.test(name)) throw invalidMailExport();
        return exportMailBytes({
          operation: join(r!.storage, `${name}.operation.json`),
          output: join(output, name),
          binding: sha(JSON.stringify([binding, inventory.hash, name])),
          bytes,
          sha256: digest,
          load,
          assertOwned: check,
        });
      };
      const json = async (name: string, value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value) + "\n");
        await payload(name, bytes.length, sha(bytes), async () => bytes);
      };
      const attempt = randomUUID();
      let records = 0,
        copied = 0,
        failed = 0,
        issues = 0,
        pendingParts = 0,
        omittedParts = 0,
        unknownBodies = 0,
        pendingPreparation = false,
        stopped = false;
      let changes: "observed" | "none_observed" | "unknown" = "unknown";
      for await (const item of readMailInventory(r.storage, inventory, check)) {
        await check();
        const index = records++;
        let metadata: unknown = item;
        const results: unknown[] = [];
        const copy = async (
          name: string,
          bytes: number,
          digest: string,
          load: () => Promise<Uint8Array>,
        ) => {
          if (stopped) {
            results.push({ state: "not_attempted", path: name });
            return;
          }
          try {
            await payload(name, bytes, digest, load);
            copied++;
            results.push({
              state: "copied",
              path: name,
              bytes,
              sha256: digest,
            });
          } catch (error) {
            failed++;
            results.push({
              state: "failed",
              path: name,
              error: presentError(error),
            });
            if (
              error instanceof AgentWorkplaceError &&
              [401, 403].includes(error.status)
            )
              stopped = true;
          }
        };
        if (item.kind === "message") {
          const m = item.message;
          const body = async (
            representation: typeof m.text,
            kind: "text" | "html",
          ) => {
            if (representation.state !== "present") {
              if (representation.state === "unknown") unknownBodies++;
              return representation;
            }
            const name = `message-${m.messageId}.${kind}`,
              bytes = Buffer.from(representation.content);
            await copy(name, bytes.length, sha(bytes), async () => bytes);
            return {
              state: "present",
              path: name,
              bytes: bytes.length,
              sha256: sha(bytes),
            };
          };
          metadata = {
            kind: item.kind,
            message: {
              ...m,
              text: await body(m.text, "text"),
              html: await body(m.html, "html"),
            },
          };
        } else if (item.kind === "attachments") {
          if (item.page.preparation?.state === "pending")
            pendingPreparation = true;
          const paths: Record<string, string> = {};
          for (const part of item.page.attachments) {
            if (part.state !== "retained") {
              if (part.state === "pending") pendingParts++;
              else omittedParts++;
              continue;
            }
            const name = `attachment-${part.attachmentId}.bin`;
            paths[part.attachmentId] = name;
            await copy(name, part.bytes, part.sha256, async () => {
              const downloaded = await client.downloadMailAttachment(
                { apiKey: key },
                {
                  mailboxId,
                  messageId: item.page.messageId,
                  attachmentId: part.attachmentId,
                },
              );
              if (
                downloaded.messageId !== item.page.messageId ||
                downloaded.attachment.attachmentId !== part.attachmentId ||
                downloaded.attachment.bytes !== part.bytes ||
                downloaded.attachment.sha256 !== part.sha256
              )
                throw invalidMailExport();
              return downloaded.bytes;
            });
          }
          metadata = { ...item, paths };
        } else if (item.kind === "issue") issues++;
        else if (item.kind === "preparations" && item.page.preparations.length)
          pendingPreparation = true;
        await json(`record-${index}.json`, metadata);
        await json(`attempt-${attempt}-${index}.json`, {
          record: `record-${index}.json`,
          results,
        });
        if (stopped) break;
      }
      if (!stopped) {
        try {
          const change = await client.listMailChanges(
            { apiKey: key },
            { mailboxId, cursor: inventory.checkpoint, limit: 1 },
          );
          changes =
            change.state === "gap"
              ? "unknown"
              : change.items.length
                ? "observed"
                : "none_observed";
        } catch (error) {
          failed++;
          stopped =
            error instanceof AgentWorkplaceError &&
            [401, 403].includes(error.status);
          await json(`attempt-${attempt}-coverage.json`, {
            error: presentError(error),
          });
        }
      }
      const manifest = join(output, `manifest-${attempt}.json`);
      const result = {
        state:
          failed ||
          issues ||
          pendingParts ||
          pendingPreparation ||
          unknownBodies ||
          changes === "unknown" ||
          stopped
            ? "partial"
            : "complete",
        coverage: "non_snapshot",
        mailboxChanges: changes,
        mailboxId,
        scope,
        output,
        manifest,
        inventory: join(r.storage, inventory.name),
        checkpoint: inventory.checkpoint,
        attempt,
        plannedRecords: inventory.count,
        records,
        copied,
        failed,
        issues,
        pendingParts,
        pendingPreparation,
        omittedParts,
        unknownBodies,
        stopped,
        unattemptedRecords: inventory.count - records,
      };
      await json(basename(manifest), result);
      return result;
    },
  );
}
