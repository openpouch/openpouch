# docs/INDEX — openpouch documentation map

**As of:** 2026-07-06 · Technical preview (`openpouch@0.2.15` on npm, `latest`).

These docs are derived from the actual code in this repo. **On any conflict, the code + tests win and the doc must be
fixed.** Product and design rationale (the "why") is recorded in openpouch's internal decision log; this folder is the
technical truth (the "what" and "how").

## Start here

| Doc | Covers |
|---|---|
| [../README.md](../README.md) | What openpouch is, the one-command quickstart, the safety model, license |
| [../llms.txt](../llms.txt) | Agent-facing entry point (llmstxt.org format) — the facts an agent needs before deploying |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute: setup, the gates, the design invariants, conventional commits |
| [../SECURITY.md](../SECURITY.md) | Security policy: how to report a vulnerability, scope, supported versions, security posture |

## Reference

| Doc | Covers |
|---|---|
| [CLI.md](CLI.md) | CLI spec, command by command — flags, `--json` shapes, exit codes, key resolution |
| [MCP.md](MCP.md) | MCP server spec, tool by tool; registration per harness; live-verification record |
| [HARNESSES.md](HARNESSES.md) | Harness-neutrality rule: the CLI / MCP / repo-files integration matrix + invariants |
| [DATA-MODEL.md](DATA-MODEL.md) | The three open file formats (`deploy.manifest/policy/evidence.json`) — every field with type, default, unit |
| [API.md](API.md) | Public API of `@openpouch/core` (every export, signature, behavior) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Monorepo layout, build pipeline, design principles, the adapter contract, delivery lanes |
| [INSTANT-LANE.md](INSTANT-LANE.md) | The instant lane (`openpouch deploy`): run-d, M1 static + M2 dynamic container runtime, routing, scale-to-zero, ops |
| [ACCOUNTS.md](ACCOUNTS.md) | Account / API-key / quota subsystem: data model, key format, quota engine + tiers, endpoints, key-gating, security |
| [WORKFLOWS.md](WORKFLOWS.md) | Agent workflows: happy-path, self-repair, build-then-deploy, claim-to-keep, production-approval, resume — the recipe schema + worked examples |

## What's built (technical preview)

- **Core** — manifest/policy schemas, the policy engine (read-only default · previews autonomous · production
  human-gated), the evidence writer, the provider-adapter interface.
- **CLI** — `deploy`, `init`, `inspect`, `plan`, `preview`, `prod`, `approve`, `verify`, `logs`, `rollback`, `signup`,
  `activate`, `whoami`, `feedback`, `--version`; `--json` everywhere, stable exit codes, classified errors with fix
  hints, a plain-language `summary` for the human, framework auto-detection, and a post-deploy **health gate**
  (`healthStatus` — a non-200 app is reported `degraded` instead of handing over a dead link).
- **MCP server** — the same capabilities as tools over stdio; deliberately **no approve tool** (production is
  human-only, in every interface).
- **Adapters** — Render and Vercel (optional BYO) + the openpouch-run instant-lane adapter.
- **Instant lane (run-d)** — M1 static previews, live on openpouch's own infrastructure; M2 dynamic Node apps in
  hardened containers (scale-to-zero, egress-filtered, WebSocket-capable); **server-side build-on-deploy** — a raw
  Vite/CRA/Svelte source folder or a framework app with a build step is built on the box (`openpouch deploy .`), no
  local build required; **data-durability detect-and-surface** — a data-writing app is flagged so an ephemeral preview
  never loses data silently; abuse controls (capacity cap, report + operator takedown); the account / API-key / quota
  subsystem (key-optional, default-safe).
- **Open file formats in your repo** — `deploy.manifest.json`, `deploy.policy.json`, `deploy.evidence.json` +
  `DEPLOYMENT.md`, so any agent can resume after context loss.

Apache-2.0 — see [../LICENSE](../LICENSE) and [../NOTICE](../NOTICE).
