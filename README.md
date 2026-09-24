# Agent Workplace CLI

Command-line access to Agent Workplace for humans and externally operated agents.

```sh
npm install --global agent-workplace@0.1.0
agent-workplace --help
agent-workplace --base-url https://api.agentworkplace.dev health --json
```

Supported runtimes: Node.js 22.12 or later in the 22.x series, and Node.js 24.x. The CLI uses the Agent
Workplace SDK and HTTP API. No infrastructure or provider credentials are required.

Follow the [access guide](https://docs.agentworkplace.dev/docs/access) to create an
account and confirm workplace ownership. Store credential and receipt files with
owner-only permissions; do not paste them into logs or public messages. Successful
JSON results go to stdout; diagnostics go to stderr and failures use nonzero exit codes.

See the [documentation](https://docs.agentworkplace.dev) for Mail, Files, Billing,
permissions and recovery. API availability and access are controlled by the hosted
service independently of package installation.

MIT license. Support: support@agentworkplace.dev.

## Development

Run `npm ci` and `npm run verify` to build and test this repository. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.
