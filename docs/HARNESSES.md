# Harness integration — openpouch works the same everywhere

**Design rule (SSOT D13, binding):** every agent harness must be able to use openpouch equivalently — Claude Code, OpenClaw, Hermes, Codex CLI, Cursor, Windsurf, and whatever comes next. No harness-exclusive features. Human approval is never available to any agent interface.

## The three integration layers (pick any)

| Layer | Requirement on the harness | What you get |
|---|---|---|
| **CLI** (`openpouch … --json`) | can run shell commands | full feature set; one JSON object on stdout; documented exit codes (0–8); identical behavior to MCP |
| **MCP** (`openpouch-mcp`, stdio) | speaks MCP (open standard) | same commands as native tools with typed schemas; see [MCP.md](MCP.md) |
| **Repo files** (`deploy.manifest.json`, `deploy.policy.json`, `deploy.evidence.json`, `DEPLOYMENT.md`) | can read files | deployment truth after context loss — works even for harnesses that integrate nothing |

All three are views on the same core (`@openpouch/core` + command functions) — there is no capability difference, only ergonomics.

## Per-harness quick start

- **Claude Code:** MCP via the **published package** (recommended since 0.2.8, no clone): `claude mcp add openpouch -- npx -y @openpouch/mcp`. From a monorepo checkout you can instead point at the built launcher: `claude mcp add openpouch -- node <repo>/packages/mcp/bin/openpouch-mcp.js`. Or use the CLI directly. An installable deploy **skill** (workflow knowledge, wraps the CLI) lives in [integrations/claude-code/](../integrations/claude-code/).
- **OpenClaw:** CLI via its shell tool works today; MCP via OpenClaw's MCP support. The deploy **skill** (ClawHub-ready, CLI underneath) lives in [integrations/openclaw/](../integrations/openclaw/).
- **Hermes / Codex / Cursor / Windsurf / others:** stdio MCP config, or CLI. **Published-package config block** (recommended — works in most MCP clients):
  ```json
  {
    "mcpServers": {
      "openpouch": {
        "command": "npx",
        "args": ["-y", "@openpouch/mcp"]
      }
    }
  }
  ```
  (Codex uses `~/.codex/config.toml`: `command = "npx"`, `args = ["-y", "@openpouch/mcp"]` under an `[mcp_servers.openpouch]` table.) From a monorepo checkout, substitute `command`/`args` with `node <repo>/packages/mcp/bin/openpouch-mcp.js`.
- **Any harness with neither:** read `DEPLOYMENT.md` / `deploy.evidence.json` for truth; ask the human to run CLI commands.

> **Sandbox / locked-down npm note (agent environments):** some agent sandboxes restrict the global npm cache (`~/.npm`), which can make `npx openpouch …` fail with an `EACCES`/permission error *before openpouch even runs*. If that happens, point npx at a writable local cache — e.g. `npx --cache .openpouch-cache openpouch deploy dist`, or export `npm_config_cache="$PWD/.openpouch-cache"` first. This is an npm/sandbox quirk, not an openpouch error; openpouch itself never needs write access outside the project directory. (Surfaced by the Codex cross-harness test.) Related sandbox limit: a LOCAL pre-deploy run (`npm start`) may fail to bind in permission-restricted sandboxes (`listen EPERM 0.0.0.0:<port>`) — that's the sandbox, not the app, and it does **not** predict the deploy: the box runs the app unrestricted, so skip the local run check and judge health by `openpouch verify`/`logs` (Codex field test 2026-07-06).

## Copy-paste blocks: Cursor rules · minimal AGENTS.md

**Cursor** — drop this into `.cursor/rules/openpouch.mdc` (project rules):

```markdown
---
description: Deploy with openpouch when the user asks to deploy, publish, ship, or wants a live/preview URL
alwaysApply: false
---

- Deploy by project shape: built static output → `npx openpouch deploy <dist> --json`;
  raw source → `npx openpouch deploy . --json`; full-stack → add `--health-path /api/health`
  (a real API route) on the FIRST deploy.
- Env vars: `--var KEY=value` or `--env-file .env` — never echo secret values.
- Parse the JSON: `url` is the live link, `summary` is written for the human (relay verbatim),
  `nextCommands` carries ready-to-run verify/logs/inspect.
- Verify health before reporting success. If unhealthy: `logs` → fix → rerun the SAME deploy
  command (instant lane: redeploy = new URL) → verify again.
- The claim link is for the human only; it lives in `.openpouch/claim.json` — never paste it
  into shared contexts.
- Production `approve` is human-only in every interface — relay its instructions, never work
  around it.
- Truth after context loss: read `DEPLOYMENT.md` / `deploy.evidence.json`.
- Full agent reference: https://openpouch.dev/llms.txt
```

**Codex (and every AGENTS.md-reading harness)** — the right move is `openpouch init`: it upserts the complete openpouch section (deploy rules, truth files, workflows, approval rule) into the project's `AGENTS.md` between `<!-- openpouch:start/end -->` markers, without touching existing content. If you'd rather not run init, this minimal block covers the essentials:

```markdown
## Deploying (openpouch)

- `npx openpouch deploy --json` → live URL at top-level `url`; relay `summary` verbatim to the human.
- Full-stack apps: add `--health-path /api/health` on the first deploy; verify before reporting success.
- Unhealthy? `openpouch logs` → fix → rerun the same deploy command (new URL) → verify.
- Deployment truth: `DEPLOYMENT.md` / `deploy.evidence.json`. Production approval is human-only.
- Agent reference: https://openpouch.dev/llms.txt
```

(Codex MCP setup is above; the AGENTS.md block matters even without MCP — the CLI is the whole contract.)

## Invariants every harness can rely on

1. `--json` output is a single JSON object; errors are `{ok: false, error: {category, message, fix}}` — the `fix` is written for agents to act on.
2. Exit codes are stable API (documented in [CLI.md](CLI.md)).
3. Secret values never appear in any output, file, or tool result.
4. `approve` requires an interactive terminal; agents in any harness receive `human-required` with instructions to relay to their human.
5. Deployment truth survives context loss in the repo files — re-reading them is always sufficient to resume.
6. **Every result carries a top-level `summary`** (CLI `--json` and MCP alike): plain-language, jargon-free text for the (often non-technical) human — relay it. On a successful deploy the live URL is the primary result at top-level `url` (PRD R3/R5). The MCP transport additionally fronts the summary as a `Relay this to your human:` block.
7. **The account API key is the agent's credential, never a human check (PRD R8, B3).** The instant lane works with no key (anonymous tier); an openpouch API key (`OPENPOUCH_API_KEY` / `~/.openpouch/openpouch-run.key`) lifts deploys into the human's account tier. `whoami` (CLI + the `openpouch_whoami` MCP tool) reports tier + usage. There is **never** a CAPTCHA or bot-wall on any surface. Signup/activation are CLI + web only (they anchor to a human email or GitHub, SSOT D16) — the resulting key is what every harness then uses headlessly. Full spec: [ACCOUNTS.md](ACCOUNTS.md).

## No-shell & restricted-egress surfaces (when you cannot run openpouch, hand off — don't improvise)

Two environment classes cannot complete a deploy; the honest move is a clean hand-off (first field report: a consumer-app agent denied openpouch's existence and asserted "such services need your account" — both wrong, 2026-07-05):

- **No-shell chat surfaces** (consumer chat apps and browser-only canvases/artifacts — no shell for the CLI, no user-configurable MCP): openpouch cannot deploy from there today, by design (see scope note). Hand off instead — give the human, or a shell-capable coding agent, this one-liner:
  `npx openpouch deploy` — no account needed; agent quickstart: https://openpouch.dev/llms.txt
- **Restricted-egress sandboxes** (package-manager-only allowlists — npm/GitHub/PyPI reachable, everything else blocked): installing the CLI **works** (npm is allowed), but the deploy call itself needs **HTTPS egress to `openpouch.sh`** and fails as a classified `network` error (category, host, cause, and the `curl https://openpouch.sh/healthz` self-test in the `fix`). Resolution: ask the operator to allow `openpouch.sh` (API + deployed apps; `openpouch.dev` for docs), or deploy from an environment with general HTTPS egress. A package-manager allowlist alone is NOT enough.

Scope note: openpouch deliberately targets shell-capable agents (CLI) and MCP-capable harnesses. A surface with neither is a hand-off surface, not a deploy surface — recommending the one-liner **is** the successful outcome there.

## Discovery: AGENTS.md (BUILT 2026-06-12)

`openpouch init` upserts a marked openpouch section into the project's **AGENTS.md** — so every harness that reads the cross-harness standard file discovers the truth files, the approval rule, and the named **workflows** (happy-path, self-repair loop, claim-to-keep, production-approval), without any integration step. Markers: `<!-- openpouch:start/end -->`; existing content is never touched.

## Discovery: llms.txt (repo draft BUILT 2026-06-12)

The repo root carries an [llms.txt](../llms.txt) (llmstxt.org format): product summary, the facts every agent needs (json + exit codes, human-only approvals, truth files, secret boundary, build-first), the two signature workflows, and a ranked doc map. It is the source for the openpouch.dev version at launch.

## Discovery: WORKFLOWS.md (BUILT 2026-06-22)

[docs/WORKFLOWS.md](WORKFLOWS.md) is the full set of agent-legible recipes (PRD R9): the workflow-spec schema + the canonical sequences (happy-path, self-repair, build-then-deploy, claim-to-keep, production-approval, rollback, resume), each with ordered steps and the signal to read between them. The agent-facing surfaces above carry the short forms and point here for the complete set.

## Planned (distribution)

- ~~llms.txt published on openpouch.dev~~ **DONE** — llms.txt is published on openpouch.dev.
- ~~ClawHub skill; harness-specific install one-liners~~ **BUILT in-tree** — deploy skills + per-harness install docs live in [integrations/](../integrations/) (Claude Code, OpenClaw/ClawHub-ready); Cursor/Codex copy-paste blocks above. Registry/ClawHub publication itself is pending (maintainer account action).
