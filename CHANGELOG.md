# agent-workplace

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
