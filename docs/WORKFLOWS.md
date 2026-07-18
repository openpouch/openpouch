# WORKFLOWS — the agent-legible recipes (PRD R9)

**As of:** 2026-07-10 · derived from the actual CLI/MCP code in this repo. On any conflict, the code + tests win and this doc must be fixed.

openpouch's surfaces (CLI, MCP, `AGENTS.md`, `llms.txt`) list *verbs*. This doc lists the **workflows** — the ordered sequences those verbs combine into — so an agent runs a recipe, not a guess. R9 ("agent-legibility") treats this as a standing requirement: every multi-step thing an agent should do has a named recipe here, written so any harness can follow it.

The CLI commands and the MCP tools are the same functions (SSOT D13), so every recipe below works identically whether you shell out (`openpouch <cmd> --json`) or call the MCP tool (`openpouch_<cmd>`). Exit codes are the CLI contract; the MCP tool sets `isError` on a non-zero exit and carries the same JSON.

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
- **`url`** (top-level, on a live deploy): the primary shareable result. On the instant lane, **`claimUrl`** is also top-level.

Exit codes (CLI; documented in [CLI.md](CLI.md)): `0` ok · `1` unexpected · `2` usage · `3` manifest/policy missing or invalid · `4` auth · `5` provider · `6` policy gate (approval required/denied/human-required) · `7` deploy failed · `8` verify failed.

---

## 1. Ship a preview (the happy path)

- **Goal:** a live, shareable URL for the current project.
- **When:** you have a project to put online and just want a preview link.

**Steps — instant lane (zero-config, no account):**

1. `openpouch deploy` — packages the folder and ships it to openpouch's own infra.
   - Read: exit `0`, top-level `url`, `pending`, and **`healthStatus`**. The deploy probes `GET /` for you, so a `0` exit alone isn't "ready to share":
     - `healthStatus: "healthy"` → reachable, safe to relay.
     - `healthStatus: "pending"` (`pending: true`) → a dynamic container is still starting → workflow 2 before sharing.
     - `healthStatus: "degraded"` → the container is live but `/` didn't return 200 (`deployment.httpStatus` has the code) → **don't share the URL** → workflow 2.
2. Relay the `summary` and the `url` to your human — only once `healthStatus` is `"healthy"`.

**Steps — configured lane (Render/Vercel via a manifest):**

1. `openpouch init` — detects framework/build/env vars, writes `deploy.manifest.json` + `deploy.policy.json` (idempotent).
2. `openpouch inspect` and/or `openpouch plan` — read what's deployed and what's ready (read-only; never acts).
3. `openpouch preview` — deploys the preview environment (autonomous under the default policy: policy → deploy → poll → smoke → evidence).
   - Read: exit `0` and top-level `url`.

- **Done when:** exit `0` and a top-level `url` (and, on the instant lane, `healthStatus: "healthy"` — not `"pending"`/`"degraded"`).
- **If it fails:** unbuilt-frontend refusal (exit `2`, message "unbuilt frontend") → workflow 3. Deploy/verify failure (exit `7`/`8`), a `degraded`/`pending` instant deploy, or an unhealthy app → workflow 2.

---

## 2. Self-repair loop (the signature move)

- **Goal:** turn a broken or not-yet-healthy deploy into a healthy one without a human.
- **When:** a deploy came back unhealthy — a deploy failure (exit `7`), a failed smoke/verify (exit `8`), a non-200 app, or an instant deploy whose `healthStatus` is `"degraded"` (live but `/` ≠ 200, e.g. an unbuilt frontend served by an app server → workflow 3) or `"pending"` (still starting).

**Steps:**

1. `openpouch logs` (optionally `--limit <n>`) — the runtime logs of the mapped service. **This is the entry point of the loop.**
   - Read: the log lines for the actual cause (crash, missing env var, wrong start command, bad path). For an instant-lane dynamic app the logs include the captured install and app startup output (lines tagged `[install]`/`[app]`), so the real error is visible — e.g. an `[install]` failure, or an `[app]` crash / a server serving an unbuilt frontend. Widen with `--limit` if the tail is truncated.
2. Decide where the fault is: the app code/config, or the openpouch manifest/policy. (`openpouch inspect` confirms what's mapped and which required env vars are missing — names only.)
3. Fix it in the source/repo.
4. Re-deploy: `openpouch deploy` (instant lane — redeploys without refusing; note the URL changes each time — unless it's a named app: `deploy --app <name>` keeps ONE stable URL and updates the app behind it, with a failed update never breaking the live version) or `openpouch preview` (configured lane).
5. `openpouch verify` — runs the healthcheck/smoke against the live URL and appends the result to evidence. **Full-stack app?** Add `--health-path /api/health` (or deploy with it, which records it in the manifest): `verify` then proves BOTH `/` and the API path — a live shell can hide a dead backend.
   - Read: exit `0` ("healthy") vs exit `8` ("has a problem", with the failing check's detail).
6. If still failing, go back to step 1.

- **Done when:** `openpouch verify` exits `0`.
- **If it fails repeatedly:** report the `summary` and the failing check detail to your human — don't hand over a broken or still-`pending` URL.

> This is the W3-DoD behaviour proven live (see [INDEX.md](INDEX.md) BUILT log, "Self-repair drill"). Default `preview` deploys are autonomous, so the whole loop runs without an approval.

---

## 3. Build then deploy (framework frontends)

- **Goal:** put a React/Vite/Next/Svelte app online correctly (its *built* output, not its source).
- **When:** the project is a framework frontend, **or** `openpouch deploy` refused with exit `2` "refusing to deploy what looks like unbuilt frontend source".

**Steps:**

1. `npm run build` — produces the build output directory.
2. `openpouch deploy <dir>` — deploy that directory: Vite → `dist`, CRA → `build`, Next static export → `out`.
   - The refusal message names the exact folder to use.
3. Continue as workflow 1 (read `url`, relay `summary`).

- **Done when:** exit `0` and a top-level `url`.
- **Escape hatch:** `openpouch deploy .` ships the current folder as-is (bypasses the guard) — only if you really mean to serve it unbuilt.
- **Note:** server-side **build-on-deploy is done (PRD L9)** for both **dynamic** apps (Express/Node with a `start` + `build` script → built then run) **and unbuilt static SPAs** (a Vite/CRA frontend with *no* server → built, then the output served as files). So you can deploy a *source* folder directly: pass it explicitly with `openpouch deploy .` and the server builds it. The client-side guard still refuses a *no-dir* `openpouch deploy` of unbuilt source (a safety net for older servers), so either `openpouch deploy .` (server builds) or build locally and `openpouch deploy dist` — both work.

---

## 4. Keep a preview (claim-to-keep)

- **Goal:** keep an instant preview alive. The claim page offers the human two ways: a one-click token claim extends it from ~72h to **7 days**, or saving it with a **free account keeps it live as long as it's used** — it then expires only after ~90 days without a single request (warning mail first; any visit resets the clock).
- **When:** you deployed via the instant lane and the human wants to keep the result around. Anonymous previews are ephemeral — they vanish after ~72h unless claimed — and **every `openpouch deploy` produces a NEW URL** (there is no in-place update), so claim the specific preview you want to keep.

**Steps:**

1. After `openpouch deploy`, take the top-level **`claimUrl`** from the result (also saved locally to `.openpouch/claim.json`).
2. Give that link to your human **privately** and tell them to open it. The claim link carries a single-use token (flagged `claimUrlIsPrivate: true`) — treat it like a password: **do not post it in a public report, issue, or chat** (the relayable `summary` deliberately omits it for this reason). The shareable address is `url`; the `claimUrl` is not. Claiming is theirs to do — there is no agent claim path.
3. Deploys made with an API key (`openpouch signup` → key) are account-owned from the start — no claim step needed; they stay live while they're used.

- **Done when:** you've relayed the `claimUrl` privately. Nothing else is needed from you.
- **Note:** the `expiresAt` timestamp (in the deployment record and the `summary`) is honest and ROLLING for account-owned apps (last activity + 90-day window). For a stable, *updatable* URL instead of a fresh preview on each deploy, use the governed lane (workflow 5 — bring-your-own Render/Vercel).

---

## 5. Deploy to production (human-approved)

- **Goal:** a governed production deploy.
- **When:** the project has a `production` environment and you're asked to go live.

**Steps:**

1. `openpouch prod`.
   - If exit `0`: it deployed (policy allowed it). Read the top-level `url`. Done.
   - If exit `6` with `approvalRequest{id}`: production needs human approval.
2. Ask your human to run `openpouch approve <id>` **in their own terminal**. You cannot approve — there is intentionally no agent approve path, in any harness (the MCP server ships no approve tool).
3. After they approve, re-run `openpouch prod`.

- **Done when:** exit `0` and a top-level `url`.
- **If it fails:** deploy/verify failure (exit `7`/`8`) → workflow 2. `rollback` is the same approval-gated shape (see workflow 6).

---

## 6. Roll back a bad production deploy

- **Goal:** restore the previous working production version.
- **When:** a governed (Render/Vercel) production deploy went bad and a prior good one exists.

**Steps:**

1. `openpouch rollback` — redeploys the recorded rollback anchor commit (the deploy that was live before the latest). Approval-gated like any write: may return `approvalRequest{id}` (exit `6`) → workflow 5's approval step, then re-run.

- **Done when:** exit `0`, top-level `url`, and the evidence's newest record notes the rollback.
- **Does NOT apply to the instant lane:** instant previews ship a fresh ephemeral preview each time, not versioned releases — there is no earlier version to restore. `rollback` on an instant project returns exit `3` "instant-lane previews can't be rolled back"; the fix is to deploy again (workflow 2/3), not to roll back.

---

## 7. Resume after context loss

- **Goal:** pick up a project's deployment state with no prior conversation.
- **When:** a fresh agent/session lands in a repo that already uses openpouch.

**Steps (read-only, in order):**

1. `DEPLOYMENT.md` — human-readable: what is live, where, on which commit, the rollback anchor. Fastest orientation.
2. `deploy.evidence.json` — the append-only machine record (newest first): every deploy, its status, URL, anchors.
3. `deploy.manifest.json` (what/where) + `deploy.policy.json` (what you may do autonomously vs. what needs approval).
4. `openpouch inspect` — reconcile the files against the provider's current truth (drift, missing env vars).

- **Done when:** you can state what's deployed and what you're allowed to do next. These files are designed so re-reading them is always sufficient to resume — no hidden state.

---

## 8. Full-stack from scratch (React + Express)

- **Goal:** create a brand-new full-stack app (React frontend + Node API) and put it live in one deploy.
- **When:** the human asks for a new app with both a UI and an API and you're starting from an empty directory. (Requested as an exact recipe by an agent field test, 2026-07-06 — the docs sufficed, but this removes trial-and-error.)

**Steps:**

1. `npm create vite@latest my-app -- --template react` → `cd my-app` → `npm install express`.
2. Add `server.js`: serve the built frontend from `dist/` and expose your API — at minimum `GET /api/health` returning `{ "ok": true }`.
3. In `package.json` set `"start": "node server.js"` and keep Vite's `"build"`. openpouch detects a dynamic app, builds on deploy (`vite build`), then runs `start`.
4. Local check: `npm run build && npm start` → `/` and `/api/health` both return 200. (In permission-restricted sandboxes the local `npm start` may fail with `listen EPERM` on bind — skip the local run check then, it doesn't predict the deploy; step 5 + `verify` prove it live.)
5. `openpouch deploy . --json --health-path /api/health --redact-secrets` (redaction keeps the private claim link out of your report JSON — field agents paste raw results into docs and chats; add `--var NAME=value` for deploy-time env vars — names are recorded in evidence, values never).
6. Continue as workflow 1 (read `url`, relay `summary`); `openpouch verify --json` re-checks `/` AND the recorded health path.

- **Done when:** exit `0`, top-level `url`, `healthStatus: "healthy"`, `healthPathCheck.passed: true`.
- **Note (Express 5):** the catch-all SPA fallback `app.get("*", …)` is invalid under Express 5's path-to-regexp — use `app.get(/.*/, …)` (or `app.use`). This is the most common app-start failure in this recipe; `openpouch logs` shows it under `[app]`.

---

## 9. Upgrade to a paid tier (human pays)

- **Goal:** more capacity or operating-class features — always-on apps, a persistent `/data` volume, higher deploy/live limits.
- **When:** a deploy hits an honest 403/429 naming a tier limit (`quota`/`upgrade` in the fix), or the human asks for persistence guarantees.

**Steps:**

1. `openpouch upgrade --plan <starter|pro|scale|business> --json` → the result carries a **`checkoutUrl`**.
2. Hand that URL to your human. **Payment is deliberately a human step** (same class as `approve` and claiming): the human pays in the browser at our Merchant of Record — there is no pay command, and card data never touches an agent surface.
3. After payment the account tier updates automatically (signed webhook). Confirm with `openpouch whoami --json` (`tier` field), then rerun whatever hit the limit.

- **Done when:** `whoami` shows the paid tier and the blocked action succeeds.
- **Note:** paid features at deploy time: `openpouch deploy --always-on` (never idle-stopped) and `openpouch deploy --volume` (persistent `/data`, keyed to account + project — it survives redeploys). Both return honest, agent-readable denials on tiers that lack them.

---

## 10. Migrate an app from another host ONTO openpouch hosting

- **Goal:** the app RUNS on openpouch's own infrastructure afterwards (its `https://<slug>.openpouch.sh` URL) — the old host can be retired.
- **When:** the human says "move/switch/migrate my app to openpouch" or wants to leave their current host.

**⚠️ Intent fork — read this first (field report 2026-07-16: an agent missed it).** openpouch has TWO distinct relationships to an existing host, and "switch to openpouch" usually means (b):

- **(a) Govern the existing host (BYO lane):** `openpouch init` in a project with a reachable Render service **auto-maps that service** — the app KEEPS RUNNING on the old host; openpouch adds previews/approvals/rollback/logs on top. Choosing this is fine — but it is NOT a migration, and you must say so to your human.
- **(b) Migrate onto openpouch hosting (this recipe):** the app itself moves. This does NOT go through `init`'s auto-match — it's a `deploy --app` of the app folder. Since 0.4.0 the CLI forks this intent itself: on a project whose manifest maps another provider, `openpouch deploy` REFUSES without `--app` and names the migration move; with `--app` the deploy proceeds and the result carries `migratingFrom`.

**Steps:**

1. **Check the honest fit first** (tell your human about any mismatch BEFORE moving): runtime must be static or **Node.js** (other runtimes aren't hosted yet — hand off honestly); openpouch has **no managed database** (an external DB keeps working — pass its URL via `--var`; an on-disk DB needs `--volume`, a paid feature); **no custom domains yet** (the app gets a `<name>.openpouch.sh` URL — if the old URL must survive, keep a redirect on the old host or wait for custom domains).
2. **Deploy the app itself as a NAMED app:** `npx openpouch deploy . --app <name> --json` (account key; build-on-deploy) — with its real env vars: `--env-file .env` / `--var KEY=value` (values are injected at runtime, never echoed). Add `--volume` when the app stores data on disk (paid tiers); app data then lives under `/data`. The first deploy mints the app's ONE stable URL — every future `deploy --app <name>` updates the app behind that same URL (health-gated; a failed update never breaks the live version), so the link you hand over in step 4 keeps working across all later updates.
3. **Bring the stored data (if any):** export it from the old host with your own means — its shell, a dashboard download, or a temporary export route you add to the app (you own the code) — then `openpouch data push <name> <dir>`: it REPLACES the app's `/data` deterministically (container stopped for the write, restarted health-gated — a SQLite file is never swapped under a running process). Verify with `openpouch data ls <name>`; `openpouch data pull <name>` is your tar backup at any time.
4. **Verify on openpouch before touching the old host:** `openpouch verify --json` (add `--health-path /api/…` for a full-stack app), `openpouch logs --json` on anything unhealthy — the self-repair loop (recipe 2). If the app holds data, prove a data-bearing route returns the migrated records.
5. **Cut over:** point whatever references the old URL (links, DNS redirect on the old host, webhook receivers, uptime checks) at the new `https://<name>.openpouch.sh` URL — it stays stable across future updates. Relay `tellYourUser` to your human: the new URL, the keep/expiry story, and that the OLD host keeps running untouched as the rollback anchor.
6. **Only after the human confirms the cutover works: retire the old host.** Never delete the old service in the same run that created the new deploy — the old host IS the rollback anchor until the new URL is proven in real use. Retiring it is the human's decision, not yours.

- **Done when:** the app answers healthy on its stable openpouch URL, its data moved (`data ls` shows it; a data-bearing route serves it) or its data story is explicit (external DB / stateless), the human knows the keep/expiry story, and the old host is retired only after confirmed cutover.
- **Not this recipe:** if the human wants approvals/governance OVER their existing host, that's the BYO lane — `openpouch init` + `openpouch plan`/`deploy_production` (recipe 5) — and the app stays where it is. Say which lane you're on.

---

## Coverage note

Workflows 1–10 are the recipes openpouch's own surfaces should teach. The agent-facing surfaces point here:

- `AGENTS.md` (written into every project by `openpouch init`) carries the short form of workflows 1, 2, 4, 5, 9.
- The MCP `openpouch_logs` tool description names the self-repair loop (workflow 2) as its purpose.
- [HARNESSES.md](HARNESSES.md) §Discovery and the repo-root `llms.txt` point at this doc for the full set.
