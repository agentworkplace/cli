![Agent Workplace CLI](./.github/assets/readme-banner.png)

<p align="center">
  <a href="https://www.npmjs.com/package/agent-workplace"><img alt="npm version" src="https://shieldcn.dev/npm/agent-workplace.svg?label=npm&amp;logo=npm&amp;color=000000&amp;font=geist" /></a>
  <a href="https://www.npmjs.com/package/agent-workplace"><img alt="npm provenance" src="https://shieldcn.dev/badge/provenance-SLSA-000000.svg?logo=lu:ShieldCheck&amp;font=geist" /></a>
  <a href="./package.json"><img alt="Node.js 22.12 or later and 24" src="https://shieldcn.dev/badge/Node.js-22.12%2B%20%7C%2024-000000.svg?logo=nodedotjs&amp;font=geist" /></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://shieldcn.dev/badge/license-MIT-000000.svg?logo=lu:Scale&amp;font=geist" /></a>
  <a href="https://docs.agentworkplace.dev"><img alt="Documentation" src="https://shieldcn.dev/badge/docs-000000.svg?logo=lu:BookOpen&amp;font=geist" /></a>
  <a href="https://github.com/agentworkplace/cli/actions/workflows/ci.yml"><img alt="CI status on main" src="https://shieldcn.dev/github/ci/agentworkplace/cli.svg?workflow=ci.yml&amp;branch=main&amp;color=000000&amp;font=geist" /></a>
</p>

## Agent Workplace CLI

Command-line access to Agent Workplace for humans and externally operated agents.

> [!WARNING]
> **Early beta**\
> Agent Workplace is actively evolving. APIs, SDKs, CLI commands, and product behavior may change, including breaking changes. Check the [product changelog](https://agentworkplace.dev/changelog) before upgrading and pin SDK and CLI versions for repeatable workflows. Client pinning does not pin the hosted API or guarantee continued compatibility.

```sh
npm install --global agent-workplace@0.6.0
agent-workplace --help
agent-workplace health --json
agent-workplace docs search "signup"
agent-workplace docs /documentation/guides/send-mail
```

Supported runtimes: Node.js 22.12 or later in the 22.x series, and Node.js 24.x. The CLI uses the Agent
Workplace SDK and HTTP API. No infrastructure or provider credentials are required.
Fresh signup and health checks use `https://api.agentworkplace.dev` by default.
For staging or local development, set `AGENT_WORKPLACE_API_URL` to that API
origin. Saved credentials and invitations remain bound to their original origin;
an environment setting for another origin is rejected before a request.
`docs` lists the current published docs, searches pages with excerpts, and prints
guide or generated API reference Markdown by canonical path. It works before
signup and never reads account credentials. Add `--json` for structured output;
installed `--help` owns version-specific command options.

If you already have an account and its saved credential, run
`agent-workplace account-status --json` to check current access. Otherwise, follow
the [quick start](https://docs.agentworkplace.dev/documentation/get-started/quick-start)
to create a workplace or use the invitation path for an existing one. The
[Accounts guide](https://docs.agentworkplace.dev/documentation/guides/create-workplace)
covers ownership confirmation and recovery. Store credential and receipt files
with owner-only permissions; do not paste them into logs or public messages.
Successful JSON results go to stdout; diagnostics go to stderr and failures use
nonzero exit codes.

See the [documentation](https://docs.agentworkplace.dev) for Mail, Files, Billing,
permissions and recovery. API availability and access are controlled by the hosted
service independently of package installation.

MIT license. Support: support@agentworkplace.dev.
Source and contributions: [agentworkplace/cli](https://github.com/agentworkplace/cli).

## Troubleshooting commands

Check `agent-workplace --version` and the affected command's `--help` when the
published documentation describes an option your installation does not recognize.
For scripts, check the exit code and capture stderr separately from stdout;
`--json` does not turn a failed command into a successful result.

If a mutation is interrupted, follow that command's documented recovery procedure
and retain its private receipt or original operation/submission ID. A timeout
alone does not establish that the server rejected the operation. Never include
credential files or private receipts in a support report.

## Development

For a source checkout, run `npm ci` and `npm run verify`. Contribution guidance
is in the source repository.
