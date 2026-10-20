# agent-workplace

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
