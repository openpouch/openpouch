# openpouch 🦘

![CI](https://github.com/openpouch/openpouch/actions/workflows/ci.yml/badge.svg)

### We never ask if you're human.

**The agent-native hosting platform — built *for* coding agents, not walled against them.** Your coding agent says "deploy this," and it does: one command, no account, no dashboard, no CAPTCHA. openpouch runs your app on **its own infrastructure** and hands your human back a live URL and a plain-language summary.

![openpouch demo — an agent deploys with one command: no account, no CAPTCHA, live URL in seconds](docs/assets/openpouch-hero-loop.gif)

> Your app is the joey; openpouch carries it safely. 🦘

**Status: technical preview.** [`openpouch`](https://www.npmjs.com/package/openpouch) and [`@openpouch/mcp`](https://www.npmjs.com/package/@openpouch/mcp) are on npm, and the instant lane (`npx openpouch deploy`) is live on openpouch's own infrastructure — static sites and real Node.js apps in hardened containers, with server-side build-on-deploy. Expect rough edges and changing APIs while we dogfood toward a broader launch — feedback and issues welcome.

**Works with any agent harness** — Claude Code, Codex, OpenClaw, Hermes, Cursor, or none at all: plain CLI with `--json` everywhere, plus an MCP server. Setup snippets per harness: [docs/HARNESSES.md](docs/HARNESSES.md).

## Why

AI coding agents already initiate >30% of weekly deployments on major platforms — but every platform is human-first with agent features bolted on. Agents fight browser OAuth, interactive prompts, account-wide tokens, human-prose logs, and they lose deployment truth between sessions. The humans operating them have no policy layer: nothing enforces "previews are autonomous, production needs my approval."

openpouch is the missing combination: **open source + agent-native + governed deployment lifecycle.**

## Quickstart

Deploy any folder to a live URL in one command — no account, no provider key, no setup:

```bash
npx openpouch deploy
```

You get a live `https://<slug>.openpouch.sh` preview plus a claim link. The agent deploys autonomously; a human claims the preview via the link (unclaimed previews vanish after 72 h). openpouch writes the deployment truth (`deploy.manifest.json`, `deploy.evidence.json`, `DEPLOYMENT.md`) back into your repo, so any agent can pick up where the last one left off.

Prefer your own provider? openpouch can also drive Render or Vercel (BYO): `openpouch init` detects your project and maps the existing service, then `openpouch preview` / `openpouch prod` run the same governed pipeline (previews autonomous, production gated behind a human approval). The product itself, though, is openpouch's **own** hosting — see [docs/INDEX.md](docs/INDEX.md).

## What agents say

We commission independent agent harnesses to test openpouch end-to-end (build an app from scratch, deploy, verify, report) — their own words:

> "OpenPouch currently feels **genuinely agent-native**." — OpenClaw, rating it 9/10 for agent-native usability

> "Already **very agent-native** for the tested use case … no dashboard, no account, no CAPTCHA." — Codex *(translated)*

> Hermes' end-to-end run: **all 23 core checks passed** — source-only upload, server-side build, healthy dynamic app, zero browser errors.

These are commissioned test runs we publish honestly, not organic reviews — full methodology lives in the harness reports the agents wrote themselves. Friction reports from *your* agent are the feedback we value most: [file a harness report](.github/ISSUE_TEMPLATE/harness_feedback.yml).

## What it is

**Agent-native hosting:** your app runs on openpouch's own infrastructure, wrapped in a governed, agent-readable deployment lifecycle. Every surface is built for agents — CLI, MCP, the file formats, the claim pages — with zero human-verification walls.

- **CLI** (`openpouch deploy/init/inspect/plan/preview/prod/approve/verify/logs/rollback/list/delete/signup/activate/whoami/feedback`) — zero-config detection, `--json` everywhere, meaningful exit codes, machine-readable errors with fix hints, and a plain-language `summary` to relay to your (possibly non-technical) human
- **MCP server** — the same capabilities as native tools in any MCP-capable agent harness
- **Open file formats in the user's repo** (the "package.json of deployment"):
  - `deploy.manifest.json` — project config, environments, build/start, healthchecks, env-var manifest (names/status, never values)
  - `deploy.policy.json` — what agents may do per environment; approval rules
  - `DEPLOYMENT.md` + `deploy.evidence.json` — what is live (URL, commit, time, smoke results, rollback anchor)
- **Optional BYO adapters** — point openpouch at your own Render or Vercel instead, same governed lifecycle; the product is openpouch's own hosting, not a layer over other clouds

**Safety, non-negotiable:** read-only by default; previews can be autonomous; production requires a signed, single-use approval granted by a human in an interactive terminal; no destructive action class in the governed/production lane (the only delete is `openpouch delete` — owner-scoped self-service removal of your own ephemeral instant preview, not approval-gated by design); secret values never enter model context; full audit trail. Because we run untrusted code on our own infra, abuse is controlled with **agent-compatible** means (accounts/quotas, rate/resource limits, egress filtering, takedown) — never CAPTCHAs.

The **instant lane** (free, ephemeral previews — `openpouch deploy`) is live now as a technical preview — static sites and dynamic Node apps both run today; durable production hosting and self-service billing under the openpouch brand follow. The open-source core (CLI, MCP, adapters, run-d) stays complete and self-hostable forever.

## Monorepo layout (actual)

```
packages/
  core/            # manifest & policy schemas, evidence writer, adapter interface
  cli/             # openpouch binary (compiled dist + plain-Node launcher)
  mcp/             # MCP server over the same core (stdio; every capability except approve — human-only)
  adapter-render/  # Render API adapter (live-verified)
  adapter-vercel/  # Vercel API adapter (live-verified incl. redeploy)
  adapter-run/     # instant-lane adapter (openpouch-run) + instantDeploy
  run/             # run-d — instant-lane host daemon + account/API-key/quota subsystem
docs/              # product & rebuild-grade documentation (start: docs/INDEX.md)
llms.txt           # agent-facing entry point (llmstxt.org format)
```

## Documentation rule (release gate)

All documentation must be complete enough that any developer or AI harness can understand and functionally rebuild the project from the docs alone: business rules, data model with units, full API reference, workflows, architecture, test gates, and a rebuild guide with acceptance criteria — derived from actual code, with an index separating current truth from history.

## Community

- **[Contributing](CONTRIBUTING.md)** — light-weight guide; docs improvements are a first-class contribution, and `good first issue` marks mentored entry points.
- **[Discussions](https://github.com/openpouch/openpouch/discussions)** — Q&A, ideas, and **Show & Tell** (post what your agent deployed).
- **[Harness feedback](.github/ISSUE_TEMPLATE/harness_feedback.yml)** — your agent hit friction? That's a bug in *our* product; reports written by the agent itself are welcome.
- **[Security](SECURITY.md)** — private disclosure via GitHub Security Advisories or security@openpouch.dev. Never a public issue.

## License

Apache-2.0 (decided 2026-06-12; explicit patent grant — see `LICENSE` and `NOTICE`).
