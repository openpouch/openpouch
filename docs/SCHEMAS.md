# JSON Schemas — the machine-readable contract

**As of:** 2026-07-05 (0.2.15) · **Location:** [`docs/schemas/`](schemas/) · **Live URLs:** `https://openpouch.dev/docs/schemas/<name>.schema.json`

Agents read contracts literally (field lesson from the 2026-07-05 agent-test-suite runs) — so the output shapes are published as formal JSON Schemas (draft 2020-12) instead of prose only. Every core result and the universal error shape:

| Schema | Produced by | Notes |
|---|---|---|
| [`deploy.schema.json`](schemas/deploy.schema.json) | `openpouch deploy [dir] --json` · MCP `openpouch_deploy` | success shape; exactly one of `claimUrl` / `claimUrlRedacted` |
| [`verify.schema.json`](schemas/verify.schema.json) | `openpouch verify --json` · MCP `openpouch_verify` | `ok` is the verdict (false = checks failed, exit 8) |
| [`inspect.schema.json`](schemas/inspect.schema.json) | `openpouch inspect --json` · MCP `openpouch_inspect` | the resume surface; optional top-level `url` |
| [`logs.schema.json`](schemas/logs.schema.json) | `openpouch logs --json` · MCP `openpouch_logs` | instant lane: `[install]/[build]/[app]`-tagged lines |
| [`whoami.schema.json`](schemas/whoami.schema.json) | `openpouch whoami --json` · MCP `openpouch_whoami` | `account`/`tier`/`usage` present iff `authenticated` |
| [`list.schema.json`](schemas/list.schema.json) | `openpouch list --json` · MCP `openpouch_list` | account's own deployments, secret-free |
| [`delete.schema.json`](schemas/delete.schema.json) | `openpouch delete <slug> --json` · MCP `openpouch_delete` | anonymous callers get the error shape (auth) by design |
| [`error.schema.json`](schemas/error.schema.json) | every command on failure | 10-category enum, `fix` always present, optional `suggestedCommand`/`failureLogs` |

## The contract rules

1. **`required` fields are the guarantee.** They are stable API — removing or renaming one is a breaking change and will not happen within a minor line.
2. **Results evolve additively.** New OPTIONAL fields may appear at any time — validate with unknown properties ALLOWED (the schemas deliberately do not set `additionalProperties: false`). If your client rejects unknown fields, it will break on releases that only add information.
3. **`summary` is for humans.** Machine logic should branch on the structured fields, never parse the prose.
4. **Exit codes are part of the contract** — documented in [CLI.md](CLI.md) §Invocation.

## Drift protection

[`packages/cli/test/schemas.test.ts`](../packages/cli/test/schemas.test.ts) validates every published schema against REAL command results produced by the actual command code on every CI run (deploy healthy path, verify/inspect/logs on a deployed project, whoami/list anonymous + authenticated, delete success, and error results across `usage`/`quota`/`auth`). A contract change that isn't reflected here fails the build — the schemas cannot drift into fiction.
