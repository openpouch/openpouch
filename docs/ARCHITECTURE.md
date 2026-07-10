# Architecture

**As of:** 2026-07-02 (instant lane M1 **+ M2 both LIVE** on the production box; B3 account/API-key/quota subsystem
live; npm `openpouch@0.2.10` + `@openpouch/mcp@0.2.10`, `0.2.11` pending on main) · Build status per package is marked
BUILT / PLANNED.

## Shape

Local-first control plane (SSOT decision D5): the CLI and MCP server run on the agent's machine; durable state lives as
files in the **user's repo** (see DATA-MODEL.md); provider credentials stay in the user's env/keychain. The OSS core
(CLI/MCP) needs no server. **The product itself is openpouch's own agent-native hosting** — `run-d`, also in this repo,
live as the instant lane (SSOT **D14**); the same local-first CLI/MCP drives it and any optional BYO provider
identically. A managed paid tier (team sync, approvals, audit) follows without changing the file formats.

```
agent (Claude Code / Cursor / …)
   │  CLI calls / MCP tools
   ▼
@openpouch/cli  ──┐                 [BUILT: full command set]
@openpouch/mcp  ──┤ both thin shells over:  [BUILT: 12 stdio tools, no approve tool]
                  ▼
            @openpouch/core         [BUILT]
            • manifest/policy/evidence schemas (zod, strict)
            • policy engine (evaluateAction)
            • ProviderAdapter contract
                  │
        ┌─────────┬──────────┬───────────────┐
        ▼         ▼          ▼               ▼
adapter-render  adapter-vercel  adapter-run    [render/vercel live-verified;
        │         │          │ (instant lane)   run = M1 static LIVE,
        │         │          │                  M2 dynamic BUILT + LIVE on the production box (B2 go-live 2026-06-14)]
        ▼         ▼          ▼
   Render API  Vercel API  @openpouch/run (run-d on openpouch's own box)
   └── BYO lane: user's own account ──┘   └── Instant lane: openpouch infra ──┘
```

Files written into the user's repo: `deploy.manifest.json`, `deploy.policy.json`, `deploy.evidence.json` (+
human-readable `DEPLOYMENT.md`, week 2). These are the deployment memory agents read after context loss — and an open
format third parties can adopt.

## Design principles (binding)

1. **Policy before action:** every state-changing operation passes `evaluateAction` first; "requires-approval" routes
   through the approval flow (week 2: signed web link + CLI).
2. **Secrets never cross boundaries:** adapters expose env var names/presence only; schemas reject value-bearing fields.
3. **Machine-readable everything:** `--json` on every CLI command; classified errors with fix hints; meaningful exit
   codes.
4. **Provider neutrality:** core knows the adapter contract, not providers; adding a provider = new adapter package, no
   core change beyond the `PROVIDER_IDS` enum.
5. **Idempotent & resumable:** commands re-derive state from the manifest + provider APIs; safe to retry.

## Delivery lanes (SSOT D11)

| Lane | Infra | Cost bearer | Status |
|---|---|---|---|
| Instant (anonymous ephemeral previews, deploy-then-claim) | openpouch-run (Hetzner CX23 nbg1, Caddy wildcard TLS on `*.openpouch.sh`, expiry 72 h, caps) | openpouch (~5 €/mo) | **M1 static BUILT + LIVE 2026-06-13; M2 dynamic (containers) BUILT + LIVE on the production box (B2 go-live 2026-06-14)** — see INSTANT-LANE.md |
| Managed production ("customer only sees openpouch") | commodity substrate (Hetzner-class orchestrator or Fly-Machines-class API) resold with margin | paying customer | PLANNED month 2–3 |
| BYO (own Render/Vercel account) | provider's | customer pays provider directly | core of w1–4 MVP |

## Toolchain

npm workspaces monorepo · TypeScript ^5.5 strict, ES2022, NodeNext ESM, `noUncheckedIndexedAccess` · zod ^3.25 (only
runtime dep) · vitest ^3 · Node ≥ 20 (developed on 22.16) · License Apache-2.0 (final, 2026-06-12; `LICENSE` + `NOTICE`
at repo root).

**Build pipeline (BUILT 2026-06-12):** TypeScript project references — `npm run build` = `tsc -b tsconfig.build.json`
compiles each package `src/` → `dist/` (NodeNext ESM + `.d.ts` + source maps) in dependency order (core → adapters → cli
→ mcp). Package `exports` point at `dist/` (`types` + `default`); the bin launchers are plain Node scripts importing the
compiled output — **tsx is no longer a dependency**. A launcher without a build exits 1 with a `npm run build` hint.
Gate 1 (typecheck via root `paths` → src) and gate 2 (vitest via `vitest.config.ts` aliases → src) run on the sources
and never require a build. **Release/publish** is a second, separate step: `npm run build:release` = `tsc -b` then `node
release/build.mjs`, which uses **esbuild** to bundle the `openpouch` CLI and `@openpouch/mcp` server each into one
dependency-free ESM file (inlining the private `@openpouch/*` packages + zod + the MCP SDK, injecting the published
version via esbuild `define`). Full publish process in the internal release runbook (file RELEASE.md, not part of the
public tree).

## Repo layout (actual)

```
package.json            # workspaces root, scripts: build / clean / test / test:watch / typecheck
tsconfig.base.json      # shared strict compiler options (no paths, no emit settings)
tsconfig.json           # typecheck project: noEmit + paths → packages/*/src (gate 1, build-independent)
tsconfig.build.json     # `tsc -b` solution file referencing seven packages (core, adapter-render, adapter-vercel, adapter-run, cli, mcp, run)
vitest.config.ts        # aliases @openpouch/* → src so gate 2 tests sources without a build
packages/{core,adapter-render,adapter-vercel,adapter-run,cli,mcp,run}/
  tsconfig.json         # composite project: src → dist (declarations + source maps)
  src/  test/  dist/    # dist = compiled NodeNext ESM (gitignored)
  package.json          # exports { types: ./dist/*.d.ts, default: ./dist/*.js }, files: [dist(,bin)]
packages/cli/bin/openpouch.js      # node launcher → dist/main.js (exit 1 + build hint if unbuilt)
packages/mcp/bin/openpouch-mcp.js  # node launcher → dist/server.js (stdio MCP)
packages/run/                      # @openpouch/run — instant-lane daemon (run-d); see INSTANT-LANE.md
  src/{server,store,tar}.ts        #   M1 static: HTTP API, JSON registry, tar extract
  src/{detect,engine,ports,router,proxy,orchestrator}.ts  # M2 dynamic: classify, Docker, port pool, Caddy admin route, reverse proxy, lifecycle
  src/engine-wrapper.ts            #   B1: WrapperEngine — drive the root-owned op-docker wrapper (no Docker socket for run-d)
  src/{accounts,auth,quota,mailer,github}.ts  # B3: account/API-key/quota subsystem (ACCOUNTS.md) — key-optional, default-safe
  ops/op-docker.sh                 #   B1: root-owned sudo-gated wrapper; fixed verbs, owns the hardened profile (INSTANT-LANE.md §B1)
packages/adapter-run/              # @openpouch/adapter-run — ProviderAdapter + instantDeploy
.github/workflows/ci.yml # gates 1+2, build, built-artifact smokes (CLI + MCP) on Node 20/22
docs/                   # this documentation set (INDEX.md = entry)
LICENSE, README.md, .gitignore
```
