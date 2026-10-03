# agent-workplace

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
