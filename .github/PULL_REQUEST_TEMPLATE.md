<!-- Thanks for contributing! Keep PRs focused — one change per PR. -->

## What & why

<!-- What does this change, and what problem does it solve? Link the issue (open one first for anything non-trivial). -->

Closes #

## Definition of done

<!-- From CONTRIBUTING.md — all boxes must be checked before review. -->

- [ ] `npm run typecheck` exits 0
- [ ] `npm run test` all green (new behavior has tests)
- [ ] `npm run build` succeeds
- [ ] Docs updated where behavior changed (`docs/` must stay accurate enough to rebuild from)
- [ ] Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, …)

## Design invariants check

<!-- These are product guarantees; PRs that violate them won't be merged (see CONTRIBUTING.md). -->

- [ ] Harness-neutral (no feature exclusive to one agent harness)
- [ ] No agent-accessible production approve (human-only, every interface)
- [ ] No secret values in output, logs, evidence, or model context (names/presence only)
- [ ] Preview stays autonomous-safe; production stays human-gated
