# WORKFLOWS — the agent-legible recipes (PRD R9)

**As of:** 2026-07-02 · derived from the actual CLI/MCP code in this repo. On any conflict, the code + tests win and
this doc must be fixed.

openpouch's surfaces (CLI, MCP, `AGENTS.md`, `llms.txt`) list *verbs*. This doc lists the **workflows** — the ordered
sequences those verbs combine into — so an agent runs a recipe, not a guess. R9 ("agent-legibility") treats this as a
standing requirement: every multi-step thing an agent should do has a named recipe here, written so any harness can
follow it.

The CLI commands and the MCP tools are the same functions (SSOT D13), so every recipe below works identically whether
you shell out (`openpouch <cmd> --json`) or call the MCP tool (`openpouch_<cmd>`). Exit codes are the CLI contract; the
MCP tool sets `isError` on a non-zero exit and carries the same JSON.

---

## The workflow-spec schema

Every workflow here is written in one shape, so it's mechanically followable:

| Field | Meaning |
|---|---|
| **Goal** | the end state, in one line |
| **When** | the trigger — what makes this the right recipe |
| **Steps** | ordered actions; each names the command **and the signal to read** before the next step |
| **Done when** | the success signal to stop on |
| **If it fails** | the failure signal and which workflow to hand off to |

Two cross-cutting signals every recipe relies on:

- **`summary`** (top-level, every result): plain-language text for the human — relay it verbatim.
- **`url`** (top-level, on a live deploy): the primary shareable result. On the instant lane, **`claimUrl`** is also
  top-level.

Exit codes (CLI; documented in [CLI.md](CLI.md)): `0` ok · `1` unexpected · `2` usage · `3` manifest/policy missing or
invalid · `4` auth · `5` provider · `6` policy gate (approval required/denied/human-required) · `7` deploy failed · `8`
verify failed.

---

## 1. Ship a preview (the happy path)

- **Goal:** a live, shareable URL for the current project.
- **When:** you have a project to put online and just want a preview link.

**Steps — instant lane (zero-config, no account):**

1. `openpouch deploy` — packages the folder and ships it to openpouch's own infra.
   - Read: exit `0`, top-level `url`, `pending`, and **`healthStatus`**. The deploy probes `GET /` for you, so a `0`
     exit alone isn't "ready to share":
     - `healthStatus: "healthy"` → reachable, safe to relay.
     - `healthStatus: "pending"` (`pending: true`) → a dynamic container is still starting → workflow 2 before sharing.
     - `healthStatus: "degraded"` → the container is live but `/` didn't return 200 (`deployment.httpStatus` has the
       code) → **don't share the URL** → workflow 2.
2. Relay the `summary` and the `url` to your human — only once `healthStatus` is `"healthy"`.

**Steps — configured lane (Render/Vercel via a manifest):**

1. `openpouch init` — detects framework/build/env vars, writes `deploy.manifest.json` + `deploy.policy.json`
   (idempotent).
2. `openpouch inspect` and/or `openpouch plan` — read what's deployed and what's ready (read-only; never acts).
3. `openpouch preview` — deploys the preview environment (autonomous under the default policy: policy → deploy → poll →
   smoke → evidence).
   - Read: exit `0` and top-level `url`.

- **Done when:** exit `0` and a top-level `url` (and, on the instant lane, `healthStatus: "healthy"` — not
  `"pending"`/`"degraded"`).
- **If it fails:** unbuilt-frontend refusal (exit `2`, message "unbuilt frontend") → workflow 3. Deploy/verify failure
  (exit `7`/`8`), a `degraded`/`pending` instant deploy, or an unhealthy app → workflow 2.

---

## 2. Self-repair loop (the signature move)

- **Goal:** turn a broken or not-yet-healthy deploy into a healthy one without a human.
- **When:** a deploy came back unhealthy — a deploy failure (exit `7`), a failed smoke/verify (exit `8`), a non-200 app,
  or an instant deploy whose `healthStatus` is `"degraded"` (live but `/` ≠ 200, e.g. an unbuilt frontend served by an
  app server → workflow 3) or `"pending"` (still starting).

**Steps:**

1. `openpouch logs` (optionally `--limit <n>`) — the runtime logs of the mapped service. **This is the entry point of
   the loop.**
   - Read: the log lines for the actual cause (crash, missing env var, wrong start command, bad path). For an
     instant-lane dynamic app the logs include the captured install and app startup output (lines tagged
     `[install]`/`[app]`), so the real error is visible — e.g. an `[install]` failure, or an `[app]` crash / a server
     serving an unbuilt frontend. Widen with `--limit` if the tail is truncated.
2. Decide where the fault is: the app code/config, or the openpouch manifest/policy. (`openpouch inspect` confirms
   what's mapped and which required env vars are missing — names only.)
3. Fix it in the source/repo.
4. Re-deploy: `openpouch deploy` (instant lane — redeploys without refusing; note the URL changes each time) or
   `openpouch preview` (configured lane).
5. `openpouch verify` — runs the healthcheck/smoke against the live URL and appends the result to evidence. **Full-stack
   app?** Add `--health-path /api/health` (or deploy with it, which records it in the manifest): `verify` then proves
   BOTH `/` and the API path — a live shell can hide a dead backend.
   - Read: exit `0` ("healthy") vs exit `8` ("has a problem", with the failing check's detail).
6. If still failing, go back to step 1.

- **Done when:** `openpouch verify` exits `0`.
- **If it fails repeatedly:** report the `summary` and the failing check detail to your human — don't hand over a broken
  or still-`pending` URL.

> This is the W3-DoD behaviour proven live (see [INDEX.md](INDEX.md) BUILT log, "Self-repair drill"). Default `preview`
deploys are autonomous, so the whole loop runs without an approval.

---

## 3. Build then deploy (framework frontends)

- **Goal:** put a React/Vite/Next/Svelte app online correctly (its *built* output, not its source).
- **When:** the project is a framework frontend, **or** `openpouch deploy` refused with exit `2` "refusing to deploy
  what looks like unbuilt frontend source".

**Steps:**

1. `npm run build` — produces the build output directory.
2. `openpouch deploy <dir>` — deploy that directory: Vite → `dist`, CRA → `build`, Next static export → `out`.
   - The refusal message names the exact folder to use.
3. Continue as workflow 1 (read `url`, relay `summary`).

- **Done when:** exit `0` and a top-level `url`.
- **Escape hatch:** `openpouch deploy .` ships the current folder as-is (bypasses the guard) — only if you really mean
  to serve it unbuilt.
- **Note:** server-side **build-on-deploy is done (PRD L9)** for both **dynamic** apps (Express/Node with a `start` +
  `build` script → built then run) **and unbuilt static SPAs** (a Vite/CRA frontend with *no* server → built, then the
  output served as files). So you can deploy a *source* folder directly: pass it explicitly with `openpouch deploy .`
  and the server builds it. The client-side guard still refuses a *no-dir* `openpouch deploy` of unbuilt source (a
  safety net for older servers), so either `openpouch deploy .` (server builds) or build locally and `openpouch deploy
  dist` — both work.

---

## 4. Keep a preview (claim-to-keep)

- **Goal:** make a temporary instant preview permanent.
- **When:** you deployed via the instant lane and the human wants to keep the result. Instant previews are ephemeral —
  they vanish after ~72h unless claimed — and **every `openpouch deploy` produces a NEW URL** (there is no in-place
  update), so claim the specific preview you want to keep.

**Steps:**

1. After `openpouch deploy`, take the top-level **`claimUrl`** from the result (also saved locally to
   `.openpouch/claim.json`).
2. Give that link to your human **privately** and tell them to open it. The claim link carries a single-use token
   (flagged `claimUrlIsPrivate: true`) — treat it like a password: **do not post it in a public report, issue, or chat**
   (the relayable `summary` deliberately omits it for this reason). The shareable address is `url`; the `claimUrl` is
   not. Claiming is theirs to do — there is no agent claim path.

- **Done when:** you've relayed the `claimUrl` privately. Nothing else is needed from you.
- **Note:** the `expiresAt` timestamp (in the deployment record and the `summary`) is when an unclaimed preview
  disappears. For a stable, *updatable* URL instead of a fresh preview on each deploy, use the governed lane (workflow 5
  — bring-your-own Render/Vercel).

---

## 5. Deploy to production (human-approved)

- **Goal:** a governed production deploy.
- **When:** the project has a `production` environment and you're asked to go live.

**Steps:**

1. `openpouch prod`.
   - If exit `0`: it deployed (policy allowed it). Read the top-level `url`. Done.
   - If exit `6` with `approvalRequest{id}`: production needs human approval.
2. Ask your human to run `openpouch approve <id>` **in their own terminal**. You cannot approve — there is intentionally
   no agent approve path, in any harness (the MCP server ships no approve tool).
3. After they approve, re-run `openpouch prod`.

- **Done when:** exit `0` and a top-level `url`.
- **If it fails:** deploy/verify failure (exit `7`/`8`) → workflow 2. `rollback` is the same approval-gated shape (see
  workflow 6).

---

## 6. Roll back a bad production deploy

- **Goal:** restore the previous working production version.
- **When:** a governed (Render/Vercel) production deploy went bad and a prior good one exists.

**Steps:**

1. `openpouch rollback` — redeploys the recorded rollback anchor commit (the deploy that was live before the latest).
   Approval-gated like any write: may return `approvalRequest{id}` (exit `6`) → workflow 5's approval step, then re-run.

- **Done when:** exit `0`, top-level `url`, and the evidence's newest record notes the rollback.
- **Does NOT apply to the instant lane:** instant previews ship a fresh ephemeral preview each time, not versioned
  releases — there is no earlier version to restore. `rollback` on an instant project returns exit `3` "instant-lane
  previews can't be rolled back"; the fix is to deploy again (workflow 2/3), not to roll back.

---

## 7. Resume after context loss

- **Goal:** pick up a project's deployment state with no prior conversation.
- **When:** a fresh agent/session lands in a repo that already uses openpouch.

**Steps (read-only, in order):**

1. `DEPLOYMENT.md` — human-readable: what is live, where, on which commit, the rollback anchor. Fastest orientation.
2. `deploy.evidence.json` — the append-only machine record (newest first): every deploy, its status, URL, anchors.
3. `deploy.manifest.json` (what/where) + `deploy.policy.json` (what you may do autonomously vs. what needs approval).
4. `openpouch inspect` — reconcile the files against the provider's current truth (drift, missing env vars).

- **Done when:** you can state what's deployed and what you're allowed to do next. These files are designed so
  re-reading them is always sufficient to resume — no hidden state.

---

## 8. Full-stack from scratch (React + Express)

- **Goal:** create a brand-new full-stack app (React frontend + Node API) and put it live in one deploy.
- **When:** the human asks for a new app with both a UI and an API and you're starting from an empty directory.
  (Requested as an exact recipe by an agent field test, 2026-07-06 — the docs sufficed, but this removes
  trial-and-error.)

**Steps:**

1. `npm create vite@latest my-app -- --template react` → `cd my-app` → `npm install express`.
2. Add `server.js`: serve the built frontend from `dist/` and expose your API — at minimum `GET /api/health` returning
   `{ "ok": true }`.
3. In `package.json` set `"start": "node server.js"` and keep Vite's `"build"`. openpouch detects a dynamic app, builds
   on deploy (`vite build`), then runs `start`.
4. Local check: `npm run build && npm start` → `/` and `/api/health` both return 200. (In permission-restricted
   sandboxes the local `npm start` may fail with `listen EPERM` on bind — skip the local run check then, it doesn't
   predict the deploy; step 5 + `verify` prove it live.)
5. `openpouch deploy . --json --health-path /api/health` (add `--var NAME=value` for deploy-time env vars — names are
   recorded in evidence, values never).
6. Continue as workflow 1 (read `url`, relay `summary`); `openpouch verify --json` re-checks `/` AND the recorded health
   path.

- **Done when:** exit `0`, top-level `url`, `healthStatus: "healthy"`, `healthPathCheck.passed: true`.
- **Note (Express 5):** the catch-all SPA fallback `app.get("*", …)` is invalid under Express 5's path-to-regexp — use
  `app.get(/.*/, …)` (or `app.use`). This is the most common app-start failure in this recipe; `openpouch logs` shows it
  under `[app]`.

---

## Coverage note

Workflows 1–8 are the recipes openpouch's own surfaces should teach. The agent-facing surfaces point here:

- `AGENTS.md` (written into every project by `openpouch init`) carries the short form of workflows 1, 2, 4, 5.
- The MCP `openpouch_logs` tool description names the self-repair loop (workflow 2) as its purpose.
- [HARNESSES.md](HARNESSES.md) §Discovery and the repo-root `llms.txt` point at this doc for the full set.
