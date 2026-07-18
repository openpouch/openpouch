# Contributing to openpouch 🦘

Thanks for your interest! openpouch is open source (Apache-2.0) and built in the open. This guide is intentionally light — it covers what you need to make a good change.

> **Status:** technical preview. APIs, file formats, and the CLI surface may still change between `0.2.x` releases. Open an issue to discuss anything substantial before you build it.

## Ways to contribute

- **Report bugs** and rough edges (especially anything in the deploy lifecycle that needed a human when it shouldn't have — that's our north star).
- **Improve docs.** The documentation is a release gate here; clearer docs are a first-class contribution.
- **Submit code.** Adapters, harness integrations, and instant-lane hardening are especially welcome.
- **Security issues:** do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Project layout

A TypeScript monorepo (npm workspaces, Node ≥ 20). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture and [docs/INDEX.md](docs/INDEX.md) to find the right spec.

```
packages/
  core/            # manifest & policy schemas, evidence writer, adapter interface
  cli/             # the openpouch binary
  mcp/             # MCP server over the same core (stdio)
  adapter-render/  # Render adapter
  adapter-vercel/  # Vercel adapter
  adapter-run/     # instant-lane client adapter
  run/             # run-d — instant-lane host daemon + accounts/quota
docs/              # product documentation (start at docs/INDEX.md)
```

## Local setup

```bash
npm install
npm run typecheck          # tsc --noEmit, must be clean
npm run test               # vitest, all green
npm run build              # tsc -b — produces each package's dist/
node packages/cli/bin/openpouch.js --help
```

Live end-to-end tests against real provider accounts are **opt-in** and auto-skip without credentials (e.g. `RENDER_API_KEY=… npm run test`). You never need provider credentials to develop or to run the default test suite.

## Definition of done (for a PR)

Before you open a pull request, make sure:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run test` is all green (add tests for new behavior — this project is test-first)
- [ ] `npm run build` succeeds
- [ ] docs are updated when behavior changes (the docs must stay accurate enough to rebuild and verify the project from them alone)
- [ ] commits use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, …)

## Design invariants (please don't break these)

These are non-negotiable product guarantees. Changes that violate them won't be merged:

- **Harness neutrality** — no feature exclusive to one agent harness. The CLI (`--json` + exit codes) and the MCP server (stdio) are the universal contract.
- **No agent-accessible approve** — approving production is human-only, via an interactive terminal, in *every* interface. There is no approve MCP tool and no agent-usable approve path.
- **Secrets never leak** — env-var values must never reach model context, output, logs, or evidence. Report by name and presence only.
- **Read-only / preview is safe; production is gated** — previews may be autonomous; production requires a signed, single-use human approval.
- **No destructive action class in the governed lane** — the core policy has no delete/destroy action class, and none may be added to the governed/production lane. The one exception is intentional: owner-scoped self-service deletion of one's *own* ephemeral instant preview (`openpouch delete` / `openpouch_delete`), server-verified as the caller's own app and not approval-gated (a re-creatable preview, not a governed-production action).

## Pull requests

- Branch from `main`, keep PRs focused, and describe the change and its motivation.
- Link the issue you're addressing (open one first for anything non-trivial).
- By contributing, you agree your contributions are licensed under the project's [Apache-2.0](LICENSE) license.

## Code of conduct

Be respectful and constructive. Harassment, discrimination, or hostile behavior aren't welcome. Maintainers may remove comments, commits, and contributions that don't meet this standard, and may block repeat offenders. Report conduct concerns privately to the maintainers (see [SECURITY.md](SECURITY.md) for a private channel).
