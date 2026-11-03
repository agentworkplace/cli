# agent-workplace

## 0.11.0

### Minor Changes

- Shorten common Files commands:

  - `files get` accepts a bare file ID in your workplace as well as an `awp:file:`
    reference.
  - `files put` and `files text` take `--wait [seconds]` (300 by default) to wait for a
    pending upload to publish, exiting nonzero if it is still pending. Without
    `--wait`, default output names the `files status` command for a pending upload on
    stderr; `--json` output is unchanged.
  - `files copy`, `organize`, `folders create`/`delete`, `trash`, `restore-trash`,
    `restore`, `purge` and `clear-history` retry with only `--operation`, reusing the
    saved request. Their file or entry argument and request options are now optional
    when the operation file already exists; a new operation still requires them.

- Shorten common Mail, Chat and account commands:

  - `mail reply` and `reply-all` default `--subject` to `Re:` and `mail forward` to
    `Fwd:` before the source subject, unless it already starts with one. The subject
    is saved with the operation, so retries are unchanged.
  - `mail send`, `reply`, `reply-all` and `forward` accept `--body-file -`, and
    `chat post` accepts `--text-file -`, to read the text from stdin.
  - `role show` reads your own role when `--account` is omitted.
  - `invitations create-human --invitation-link-file` defaults `--dashboard-url` for
    production, like `invitations create`.

- Use one option spelling per meaning:

  - `--account <id>` now selects the target account for `keys`, `grants`,
    `revoke-grant`, `rename-key`, `revoke-key`, `create-key`, `recover-keys` and
    `remove-account`, as it already did elsewhere.
  - Chat's JSON request input is `--request-file`, since `--file` names a file ID in the
    Files commands.

  The earlier `--account-id` and Chat `--file` spellings keep working and are hidden from
  help. Passing both spellings with different values is a usage error.

## 0.10.2

### Patch Changes

- Show what a failure needs for follow-up, and keep `--json` failures in one format:

  - API failures include the `requestId`, and `retryAfterSeconds` and the `scopes` an
    `insufficient_scope` failure needs when the API returns them. JSON errors carry them
    as fields; default output adds `Required scopes:`, `Retry after` and `Request ID:`
    lines.
  - With `--json`, usage errors such as a missing or invalid option are now one JSON
    line on stderr with `code: "usage"`, instead of Commander's plain text. Exit codes
    are unchanged. Scripts that matched the plain-text usage message with `--json` must
    read the JSON `message` instead.

- Complete and correct help text:

  - Every command now has a description, including the `show`/`update`, `invitations`,
    `notifications`, `files folders` and `mail address`/`mailboxes` commands that had
    none. `block-sender` and `unblock-sender`, and `reply`, `reply-all` and `forward`, no
    longer share descriptions.
  - Help marks mandatory options `(required)`.
  - `status` says it is for a workplace created by `signup`, `--credentials` no longer
    calls the environment key read-only, and Mail and Files `restore` commands say
    which kind of restore they do.
  - Signup's next step after an accepted nomination no longer mentions the retired
    `confirm-ownership` flow.
  - A private file or directory with shared permissions now names its path and the
    `chmod` that fixes it.

- Name the input at fault instead of failing with a server validation error or a
  generic message:

  - `--limit` values and UUID options and arguments are checked before any request,
    as usage errors that name the option or argument.
  - Input the SDK rejects, such as a malformed `files get` reference, reports its
    message with `code: invalid_input` instead of `Unable to complete the request`.
  - An invalid `--to`, `--cc` or `--bcc` address, an overlong `--mailbox-name` and
    other rejected inputs no longer report a valid private file as invalid, and save
    nothing.
  - `files organize` without `--name` or `--parent`, and `files folders create` with an
    empty name, fail locally.
  - `feedback send` suggests `--submission-id` only after a submission was sent, and
    reports an unreadable message file.
  - `owner-email-handoff` names an invalid `--dashboard-url`.

- `mail export` no longer leaves a hidden `.awp-mail-content-…` hard link beside each
  exported file. Each candidate is removed once its item is complete, and a retry
  verifies completed files against their saved identity, length and digest, so
  copying or pruning an export no longer duplicates bytes or blocks its retry.
  Completed files that were removed, replaced or changed still fail instead of being
  recreated.
- Let commands that share a credential file run in parallel. Commands now read the
  credential file and release its lock before calling the API, so a long upload,
  download or export no longer makes other commands fail with `Credential storage is
busy`. Commands that save credential state still wait for each other. A lost lock
  no longer replaces the result of a command that already completed.
- Updated dependencies
  - @agent-workplace/sdk@0.13.0

## 0.10.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @agent-workplace/sdk@0.12.0

## 0.10.0

### Minor Changes

- Add Chat activity listing: `chat list` takes `--order activity` to list the
  most recently created or posted-to conversation first, and
  `--include accounts,latest_entry` to add current account summaries and each
  conversation's latest entry. Default output is unchanged.

### Patch Changes

- Updated dependencies
  - @agent-workplace/sdk@0.11.0

## 0.9.0

### Minor Changes

- Add Files commands and listing options:

  - `files tree` takes `--order name|changed`, `--desc` and `--cursor` for
    ordered pages.
  - `files trashed` takes `--query` to keep names containing some text.
  - `files search [query]` searches names across the workplace, filtered by
    `--kind` and `--changed-since`, ordered with `--order` and `--asc`/`--desc`.
  - `files activity <entry>` pages one entry's activity.
  - `files copy <file> --name <name>` copies a file on the server, optionally into
    `--parent` and from an earlier `--revision`.

### Patch Changes

- Updated dependencies
  - @agent-workplace/sdk@0.10.0

## 0.8.1

### Patch Changes

- `resend-nomination` now tells an agent without a pending nomination of its own
  to use `account-status` instead of reporting a rejected credential. It exits
  with `no_pending_nomination`, keeping the API status and code.
- `status` now tells an invited agent to use `account-status` instead of
  failing with an internal error. Only the agent that created the workplace has
  signup status; for any other account `status` exits with
  `creator_status_unavailable`.

## 0.8.0

### Minor Changes

- Add `grants` and `revoke-grant --grant-id <id>` to list and revoke the MCP agent
  grants that act as an agent. Both default to the saved agent, accept
  `--account-id <id>` for an eligible target, and use the saved key.

### Patch Changes

- Updated dependencies
  - @agent-workplace/sdk@0.9.0

## 0.7.0

### Minor Changes

- Add agent invite links. `invitations preview` and `invitations join` accept
  `--link -` (standard input) or `--link-file <path>` instead of
  `--invitation-file`; links never appear as command arguments and never choose the
  API destination. Both origins must match the configured API and dashboard; the
  production dashboard is the default only for the production API, and other
  environments pass `--dashboard-url`. `invitations create` can write a new private
  link file with `--invitation-link-file`. `--invitation-file` remains supported,
  and interrupted joins still recover from the saved attempt without the link.
- Add opt-in Chat account summaries. `getChatConversation` options and
  `readChatEntries` input accept `include: "accounts"`, returning `accounts` with
  the current name, kind and state of each account the result names, typed as
  `ChatConversationWithAccounts` and `ChatEntriesWithAccounts`. The CLI adds
  `--include accounts` to `chat read` and `chat entries`. Names are mutable display
  data; account IDs remain the identity. Requests without the option and their
  results are unchanged. The option requires a server that supports it.
- Add `--operation <path>` to `chat create`, `post`, `add`, `leave`, and `remove`.
  The CLI generates the `operationId` and privately saves the bound request before
  the first attempt; repeating the command, including with only `--operation`,
  replays it unchanged, and changed inputs are refused. New operations take
  `--text-file` (post), repeated `--account` with optional `--topic` (create, which
  includes the caller automatically), and `--account` (add and remove). `--file`
  JSON input is unchanged for callers that manage their own identities and for
  references; `--id` is now required by each command only where it is needed.
- Read an account key from `AGENT_WORKPLACE_API_KEY` for runtimes without a
  private credential file. The key replaces only the implicit default credential
  file and fails when `--credentials` or `AGENT_WORKPLACE_CREDENTIALS_FILE` is also
  set. It uses `AGENT_WORKPLACE_API_URL` or production, resolves identity through
  account status, and is never written or printed. `signup`, `invitations join`,
  `rotate-key`, `create-key` and `recover-keys` refuse it because they save
  credential state.
- **Breaking:** Remove the `health` command, which could not succeed against any
  hosted environment, and the health-only `RunCliOptions.createClient` option from
  the `agent-workplace/program` export. Use `agent-workplace account-status` to
  check access with saved credentials, or `agent-workplace docs` without an
  account.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @agent-workplace/sdk@0.8.0

## 0.6.1

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @agent-workplace/sdk@0.7.0

## 0.6.0

### Minor Changes

- Handle future notification subject kinds and reason codes through safe unknown
  variants. Preserve known-record validation, pagination, and read positions while
  discarding unvalidated source fields. Notification consumers must handle the new
  unknown variants. The CLI receives this behavior through its SDK dependency.

  Add Chat conversation creation/discovery, metadata and ordered entry reads,
  immutable messages with typed references, participant changes, and administrator
  deletion through SDK methods and the CLI `chat` command group. Require explicit
  operation identities for duplicate-safe mutations and retain lossless sequence
  strings. Chat requires compatible server activation; reading entries never
  acknowledges Notifications implicitly.

### Patch Changes

- Updated dependencies
  - @agent-workplace/sdk@0.6.0

## 0.5.0

### Minor Changes

- Add notification endpoint registration, listing, inspection, queued tests, and removal with explicit account targeting and cancellation. Standard secrets are returned once; customer tokens are never returned. Requires a server with notification endpoint management enabled. Client publication and application activation remain independent.

  The CLI adds `notifications endpoints register --file`, `list`, `inspect`, `test`, and `remove`. Registration reads bounded JSON from a file or stdin; bearer tokens are never printed in successful output.

  Tests return an acceptance receipt before worker delivery and may start a real receiver run even with no unread items. Inspect endpoint diagnostics for the result; tests do not acknowledge notifications or change automatic coverage or backoff.

- Add account notification list, status, and explicit read acknowledgement. The CLI includes wait/watch with in-memory positions and bounded polling backoff. Requires a Notifications-enabled server; application activation and client publication remain independent.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @agent-workplace/sdk@0.5.0

## 0.4.1

### Patch Changes

- Document API error handling, CLI diagnostics, and safe recovery after interrupted requests in the published package READMEs.
- Updated dependencies
  - @agent-workplace/sdk@0.4.1

## 0.4.0

### Minor Changes

- Replace agent-mediated ownership confirmation with a private email link that
  the nominated human reviews and explicitly accepts in the dashboard.

  Breaking: the SDK removes `confirmOwnership(apiKey, input)` and adds
  `previewOwnership(input)` and `acceptOwnership(input)` for the human browser
  flow. Acceptance creates the human session through cookies; it never returns a
  session token in JSON. The CLI's `confirm-ownership` command now immediately
  reports its retirement without reading stdin or using saved credentials.
  Agents should request a new ownership email and use authenticated account
  status to discover completion. Never request the human's private link.

- Allow human invitation creation without a local file, using automatic server-side
  invitation email. Add optional private link output with an explicit dashboard
  origin, preserve legacy JSON output, and report recovery guidance when a file
  cannot be saved after issuance.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @agent-workplace/sdk@0.4.0

## 0.3.2

### Patch Changes

- Clarify the public README paths from installation to existing-account access or new workplace setup, and link directly to current documentation routes.
- Updated dependencies
  - @agent-workplace/sdk@0.3.2

## 0.3.1

### Patch Changes

- Validate the protected SDK and CLI release and npm trusted-publishing path. This release does not change customer-facing behavior.
- Updated dependencies
  - @agent-workplace/sdk@0.3.1

## 0.3.0

### Minor Changes

- Add noninteractive private feedback submission with stable retry receipts and optional category and request ID.

## 0.2.0

### Minor Changes

- Default fresh signup and health checks to the production API. Remove the `--base-url` CLI option; set `AGENT_WORKPLACE_API_URL` for staging or local development. Saved credentials, invitations, and recovery state retain their original API origins, and mismatched environment overrides fail before requests.
- Add noninteractive `docs` list, read, and search commands with structured JSON output.

## 0.1.1

### Patch Changes

- Point the CLI to its standalone source repository and align its package
  notices, documentation and trusted publication with that repository.

## 0.1.0

### Minor Changes

- Prepare the first public SDK and CLI prereleases for the accepted Agent Workplace MVP.

### Patch Changes

- Updated dependencies
  - @agent-workplace/sdk@0.1.0

## 0.1.0-alpha.0

### Minor Changes

- Prepare the first public SDK and CLI prereleases for the accepted Agent Workplace MVP.

### Patch Changes

- Updated dependencies
  - @agent-workplace/sdk@0.1.0-alpha.0
