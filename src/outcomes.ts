/** A mutation reported that the requested change did not happen. Its result is
 * already on stdout; this adds the failure, its state and the next step. */
export class OperationNotCompletedError extends Error {
  constructor(
    message: string,
    readonly state: string,
  ) {
    super(message);
    this.name = "OperationNotCompletedError";
  }
}

const retry = "then retry with a new --operation";
const changed = `The file changed since --expected-version; read it with files entry, ${retry}`;
const evidenceExpired = `The service no longer holds this operation's result; read the current file, ${retry} if the change is still needed`;
const storageLimit = `The workplace storage allowance blocked this change; free storage, ${retry}`;
const alreadyEnded = "The upload already ended without publishing";

/** States that mean each kind of mutation did not happen. In-progress and
 * uncertain states are absent: they are not failures, and repeating them is
 * what the operation record exists to prevent. */
const failures = {
  upload: {
    limited: storageLimit,
    conflict: `The file version changed or the name is taken; read it with files entry or files search, ${retry}`,
    cancelled: `The upload was cancelled; ${retry}`,
    expired: `The upload expired before it finished; ${retry}`,
    invalid: `The uploaded bytes failed verification; ${retry}`,
    revoked: `The upload stopped because access to it ended; check your access, ${retry}`,
    evidence_expired: evidenceExpired,
  },
  uploadCancel: {
    published: "The upload already published; there was nothing to cancel",
    limited: alreadyEnded,
    conflict: alreadyEnded,
    invalid: alreadyEnded,
    revoked: alreadyEnded,
    evidence_expired: evidenceExpired,
  },
  restoration: {
    limited: storageLimit,
    conflict: changed,
    evidence_expired: evidenceExpired,
  },
  trash: { conflict: changed, evidence_expired: evidenceExpired },
  organization: { evidence_expired: evidenceExpired },
  deletion: { conflict: changed, evidence_expired: evidenceExpired },
  mail: {
    failed:
      "The email provider did not accept this message; send it again with a new --operation",
    canceled:
      "The send stopped before the provider accepted it; send it again with a new --operation",
  },
  billingCommand: {
    failed: "The billing change failed; read workplace billing status",
    superseded:
      "A newer billing change replaced this one; read workplace billing status",
  },
  nomination: {
    throttled: ({ retryAt }: { retryAt?: unknown }) =>
      `No email was queued because a send limit was reached; run resend-nomination again after ${String(retryAt)}`,
  },
  billingPurchase: {
    failed: "The purchase failed; read workplace billing status",
    expired: "The purchase expired; request it again with a new --purchase-id",
    superseded:
      "A newer purchase replaced this one; read workplace billing status",
  },
} satisfies Record<
  string,
  Record<string, string | ((result: { retryAt?: unknown }) => string)>
>;

export type OperationKind = keyof typeof failures;

/** Fail a command whose result reports that its change did not happen. */
export function requireCompleted(kind: OperationKind, result: object) {
  const state = "state" in result ? result.state : undefined;
  if (typeof state !== "string") return;
  const failure = (
    failures[kind] as Record<string, string | ((value: object) => string)>
  )[state];
  if (failure !== undefined)
    throw new OperationNotCompletedError(
      typeof failure === "string" ? failure : failure(result),
      state,
    );
}
