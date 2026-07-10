# MCP server specification — tool by tool

**Derived from:** `packages/mcp/src/server.ts` · **As of:** 2026-07-06 · Transport: **stdio** (open MCP standard — works
with any MCP client; harness neutrality is design rule D13).

Start (published path): **`npx -y @openpouch/mcp`** — a 0-dependency stdio server, instant via npx, no clone needed.
`--version` / `--help` print the version and setup guidance (on 0.2.15 and earlier they exit 0 silently — not a hang);
**without flags the binary speaks MCP on stdio and is deliberately quiet on stdout until a client connects**, so
register it in a harness rather than running it by hand. Copy-paste harness config blocks (Claude Code, Codex, Cursor,
Windsurf) are in the package README and [HARNESSES.md](HARNESSES.md). *(`@openpouch/mcp` is **published and live on
npm** and listed in the MCP registry (`io.github.openpouch/openpouch`, status active). The current version is whatever
`npm view @openpouch/mcp version` says — it is released in lockstep with the `openpouch` CLI, and this doc deliberately
carries no hard-coded number (a stale one reads as untrustworthy to agents — Hermes 2026-07-04). `npm run build:release`
builds `release/openpouch-mcp/openpouch-mcp.js` alongside the CLI (publish steps: internal release runbook, RELEASE.md —
not part of the public tree). From a monorepo checkout you can also run it directly: `node
packages/mcp/bin/openpouch-mcp.js` after `npm run build`.)*

## Design rules

1. Every tool wraps the same command functions as the CLI (`@openpouch/cli` exports) — no shell round-trip, no behavior
   drift between CLI and MCP.
2. **Tool result content blocks (PRD R3):** the result carries the command's `--json` payload as a text content block
   (one JSON object; the same contract as CLI `--json`, including the top-level `summary` field — D13). The one field
   that differs: the optional `feedbackHint` (R10.1) is added only in the CLI's `render()` and is **not** present on MCP
   results; every other field is identical. When a `summary` is present it is **prepended as a second leading text
   block** of the form `Relay this to your human:\n<summary>`, so the agent sees the relay-ready, jargon-free text first
   and passes it to its (often non-technical) human. Non-zero exit → `isError: true`. Parsing tip: the JSON payload is
   the block whose text starts with `{`.
3. **There is intentionally NO approve tool.** Approving production actions is human-only (interactive terminal; hosted
   approvals in phase 1.5). `openpouch_deploy_production` returns `approvalRequest{id}` (with a `summary` telling the
   human how to approve) and instructs the agent to ask its human.
4. All tools accept optional `cwd` (project directory; default: server cwd) **EXCEPT
   `openpouch_whoami`/`openpouch_list`/`openpouch_delete`** — those are account-scoped or slug-only and take no project
   dir.
5. **The live link is the primary result (PRD R5):** on a successful `deploy_preview`/`deploy_production` the live URL
   is at top-level `url` in the JSON; the instant lane (`openpouch deploy`, CLI-only) also adds top-level `claimUrl`.

## Tools

**All 13 tool names in one line** (authoritative name inventory — if your fetcher mangles the wide table rows below,
trust this line and confirm with the shell probe in §Smoke-test): `openpouch_init`, `openpouch_inspect`,
`openpouch_plan`, `openpouch_deploy`, `openpouch_deploy_preview`, `openpouch_deploy_production`, `openpouch_verify`,
`openpouch_logs`, `openpouch_rollback`, `openpouch_whoami`, `openpouch_list`, `openpouch_delete`,
`openpouch_list_approvals` — and deliberately **no** `openpouch_approve`.

| Tool | Inputs (besides `cwd`) | Wraps | Notes |
|---|---|---|---|
| `openpouch_init` | `force?: boolean` | `initCommand` | idempotent project setup + service auto-match |
| `openpouch_inspect` | — | `inspectCommand` | read-only deployment truth |
| `openpouch_plan` | — | `planCommand` | read-only readiness/blockers/next steps |
| `openpouch_deploy` | `dir?`, `env?` (NAME→value), `healthPath?`, `redactSecrets?` (default **true**) | `instantCommand` | zero-config INSTANT preview (was CLI-only — Codex 2026-07-04); claim link redacted by default (tool results flow through chat context), saved to `.openpouch/claim.json` |
| `openpouch_deploy_preview` | — | `deployCommand(preview)` | governed lane; autonomous if policy allows |
| `openpouch_deploy_production` | — | `deployCommand(production)` | approval-gated; returns request id for the human |
| `openpouch_verify` | `environment?`, `healthPath?` | `verifyCommand` | smoke + evidence append; `healthPath` (e.g. `/api/health`) is checked IN ADDITION to `/` |
| `openpouch_logs` | `environment?`, `limit?: int ≤500` | `logsCommand` | structured `{timestamp?, message}`; the tool description names it the entry point of the self-repair loop (logs → fix → redeploy → verify). Note: the MCP `limit` is schema-capped at 500; the CLI `--limit` has no upper cap |
| `openpouch_rollback` | `environment?` | `rollbackCommand` | anchor-commit redeploy, approval-gated |
| `openpouch_whoami` | — | `whoamiCommand` | read-only account status (tier + usage), or anonymous; key from env/file, never echoed (B3, [ACCOUNTS.md](ACCOUNTS.md)) |
| `openpouch_list` | — | `listCommand` | read-only: your own live instant-lane apps (name/kind/status/URL/expiry); needs an account key, anonymous → empty + signup pointer; never a token (D7) |
| `openpouch_delete` | `slug: string` | `deleteCommand` | delete one of your OWN apps → frees a quota slot (Befund #8); owner-only (account key, server-verified); an ephemeral preview is not a production action → no approval (D13) |
| `openpouch_list_approvals` | — | `approveCommand(undefined)` | list pending only — approving is not exposed |

**Account signup/activation are deliberately CLI + web only** (they involve a human email or browser step, SSOT D16) —
not MCP tools. `openpouch_whoami`, `openpouch_list`, and `openpouch_delete` are the account-surface tools exposed to
agents (whoami + list are read-only; delete is self-service quota management on an ephemeral preview — not a
governed-production action, so it needs no approval). There is still no approve tool (D13).

`environment` enum: `preview | production` — the two environments openpouch creates and governs; the MCP enum deliberately doesn't advertise other names an agent could pick but nothing produces (e.g. `staging`), R9.9. When **omitted**, the target is resolved from `deploy.manifest.json` via the same helper the CLI uses (`targetEnvironment`): `production` if the manifest has one, else the single mapped env (e.g. an instant-lane `preview`), else `preview` — so CLI and MCP defaults can't diverge (R9.8). It is **not** a hard `production` default.

## Registration per harness (examples)

- **Claude Code:** `claude mcp add openpouch -- node <repo>/packages/mcp/bin/openpouch-mcp.js`
- **Codex CLI / Cursor / Windsurf / others:** add a stdio MCP server with command `node <repo>/packages/mcp/bin/openpouch-mcp.js` in the client's MCP config.
- **OpenClaw & harnesses without MCP preference:** the CLI is equivalent (`openpouch … --json`, same JSON, same exit codes) — see HARNESSES.md.

## Smoke-test from any shell (no MCP client needed)

Some harnesses cannot attach a new MCP server mid-session (reported independently by three agent harnesses, 2026-07-05) — that makes the MCP surface look untestable from their side. It isn't: the server speaks plain JSON-RPC over stdio, so ONE shell command proves the toolset and the no-approve guarantee without any MCP client:

```sh
( printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
\
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 2 ) \
  | npx -y @openpouch/mcp 2>/dev/null \
  | grep -o '"name":"openpouch_[a-z_]*"' | sort -u
```

Expected (POSIX shell; the `sleep` keeps stdin open long enough for the reply): **13 tool names, and `openpouch_approve` is NOT among them** — approving stays human-only in every harness. Count them with `… | wc -l` → `13`. This is the same probe our own release gate runs against the built bundle before every publish; agent test suites should use it instead of marking MCP checks as SKIP when the harness can't load servers dynamically (tool EXECUTION parity still needs a real MCP client — only that part remains harness-dependent).

## Live verification (2026-06-12)

Full MCP round-trip from a real Claude Code session (stdio, registered server) against the isolated dogfood service (rule D12): `openpouch_init` (fresh temp project, incl. AGENTS.md writer), `inspect`, `plan`, `list_approvals`, `deploy_preview` (live deploy `dep-…`, smoke passed, evidence + rollback anchor written), `verify`, `logs` — 7/9 tools exercised live. Evidence landed in the project's `deploy.evidence.json` + `DEPLOYMENT.md` exactly as via the CLI.

**Operational note — host permission layers stack in front of openpouch.** In the same session, Claude Code's own permission classifier (auto mode) denied `openpouch_deploy_production` and `openpouch_rollback` before the calls reached the server. That is defense in depth, not a malfunction: the host harness and openpouch's policy/approval gates are independent layers that reach the same conclusion — production-affecting actions need a human. Agents should treat a host-level denial like a policy denial and surface it to their human instead of working around it. openpouch's own behavior on these two paths (`approvalRequest{id}` / policy denial) is unit-tested and was proven live via the CLI (governed prod cycle, 2026-06-12).

## Test coverage

`packages/mcp/test/mcp.test.ts` via the SDK's `InMemoryTransport` (client ↔ server, no stdio needed): toolset completeness incl. the no-approve-tool guarantee, inspect round-trip, the plain-language summary surfaced as a leading relay block **and** inside `json.summary` (R3 / D13 parity), production approval gate (`isError` + request id, visible in `openpouch_list_approvals`), logs with limit, and `openpouch_whoami` (anonymous path). The leading-relay-block + 13-tools/no-approve invariants were also smoke-checked over real stdio against the built `bin/openpouch-mcp.js`.
