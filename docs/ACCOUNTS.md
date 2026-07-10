# ACCOUNTS — account / API-key / quota subsystem (B3)

**As of:** 2026-07-02 · **Status:** LIVE — server-side rollout 2026-06-30, email signup live 2026-07-01; GitHub-OAuth =
owner-config (verify on box). Derived from the actual code in `packages/run/src/` + `packages/adapter-run/` +
`packages/cli/`. On any conflict, code + tests win and this doc must be fixed.

Business rationale + decision live in openpouch's internal decision log: the auth model, launch gating, and the product
requirements for agent-first access, abuse control, and no anti-agent barriers.

---

## 1. Why this exists

The instant lane runs anonymous third-party code on openpouch's own (paid) infra. To make that abuse-controllable — and
to support paid tiers + billing later — deployments need to be attributable to an **account** with **quotas**. SSOT D16
fixes the model:

- **Agent / daily-operation auth = an openpouch API key.** Headless, durable, no OAuth dance, no CAPTCHA — 1:1 with PRD
  R8.
- **Account anchor = email OR GitHub** (the human picks; billing/recovery hang off the account).
- **Tiers** with a configurable quota **mechanism**; exact numbers + prices stay open until dogfood (D16).

### Design: tiered, key-optional access (the R5/R8 ↔ D16 reconciliation)

PRD R5/R8 are non-negotiable: "say deploy → the agent deploys, no setup, no account friction," and never a human check.
D16 asks for the account/key/quota mechanism and "anonymous instant lane → key-gated." These are reconciled as **tiered,
key-optional** access:

1. **No `Authorization` header → the anonymous tier.** Exactly today's behaviour: per-IP rate limiter + the global caps.
   Deploying needs no account (R5 intact).
2. **A valid API key → that key's account tier.** Higher/configurable quotas, the deployment is owned by the account,
   usage is metered per account (billing later).
3. **`requireKey` (config, default OFF)** can gate the whole lane behind a key — an abuse lever. Even then it is a **401
   with a create-a-key fix**, never a CAPTCHA (R8). This is the "key-gated" capability D16 asks for, built as a
   mechanism without breaking R5 by default.

A presented-but-unresolvable credential (invalid / revoked / suspended) is a **401**, never a silent downgrade to
anonymous (HTTP norm; prevents a suspended account from quietly continuing as anonymous on its own quota).

---

## 2. Data model

Server-side state owned by the single run-d process, persisted as one JSON file written atomically (temp + rename), the
same local-first pattern as the deployment registry. Zero native deps (`node:crypto` only). File:
`<dataDir>/accounts.json` (`{ version, accounts[], keys[] }`). SQLite is a planned hardening step if volume needs it.

> Accounts are **not** repo files (unlike `deploy.manifest.json` etc. in [DATA-MODEL.md](DATA-MODEL.md)) — they are
box-server truth. This is the deliberate SSOT partition.

### `AccountRecord` (`packages/run/src/accounts.ts`)

| Field | Type | Notes |
|---|---|---|
| `id` | string | `acct_<16 hex>`. Stable account id. |
| `status` | `"pending" \| "active" \| "suspended"` | `pending` = email signup awaiting verification; `active` = usable; `suspended` = abuse hold (key auth denied). |
| `tier` | string | Tier name resolved against the server's tier table (default `free` on creation). |
| `identities` | `Identity[]` | One per anchor. Email or GitHub. |
| `createdAt` | string (ISO 8601) | |
| `pendingEmail` | string? | Email path only: the address awaiting verification (canonical lowercase). Cleared on verify. |
| `hashedVerifyToken` | string? | `sha256(token)` of the email-verification token. Cleared on verify. Raw token is never stored. |
| `verifyExpiresAt` | string? (ISO) | Verification deadline (default 24h). |
| `deployTimestamps` | number[] (ms epoch) | Recent deploy starts, pruned to the rolling 24h window — the only usage state kept here (live/dynamic counts are derived, see §5). |

### `Identity`

| Field | Type | Notes |
|---|---|---|
| `kind` | `"email" \| "github"` | |
| `value` | string | Canonical match key: a lowercased email, or `github:<numericId>`. |
| `label` | string? | Human label (e.g. the GitHub login), never used for matching. |

### `ApiKeyRecord`

| Field | Type | Notes |
|---|---|---|
| `keyId` | string | Public id (hex). Used for O(1) lookup + the `op_live_<keyId>` prefix shown to users. **Not secret.** |
| `accountId` | string | Owning account. |
| `hashedSecret` | string | `sha256(secret)` hex. **The only persisted form of the secret.** |
| `createdAt` | string (ISO) | |
| `lastUsedAt` | string? (ISO) | Updated in memory on each successful resolve; persisted lazily by the next write (best-effort telemetry — no read-path write amplification). |
| `revoked` | boolean | A revoked key never authenticates. |
| `label` | string? | Optional user label (`default`, `github`, `ci`, …). |

### Deployment ownership (`packages/run/src/store.ts`)

`DeploymentRecord` gains an optional `accountId`. A keyed deploy sets it; an anonymous deploy leaves it absent. `Store.countOwned(accountId)` derives `{ live, dynamic }` from the live records — the single source of truth for the concurrency quotas (no duplicated counter to drift).

**Self-service list/delete (Befund #8).** `Store.listOwned(accountId)` returns those live records behind **`openpouch list`**, and `Store.remove(id, { accountId })` is the owner-checked delete behind **`openpouch delete`**: only the owning account may remove a deployment (`not-owner` otherwise), it never falls through to the token path, and an account-owned record can't be tokenlessly deleted via the anonymous claim path (only a truly anonymous unclaimed preview stays tokenlessly removable). These surface as the key-gated `GET /api/deployments` + the owner branch of `DELETE /api/deployments/:slug` (see [INSTANT-LANE.md](INSTANT-LANE.md)) and as the agent-usable `list`/`delete` CLI + MCP tools — secret-free (D7), and since deleting an ephemeral preview is not a governed-production action it needs no approval (still no approve tool, D13). This is the self-service answer to a quota `429`: the quota `fix` now points at `openpouch list` → `openpouch delete <slug>`.

---

## 3. API keys (`packages/run/src/auth.ts`)

**Format:** `op_live_<keyId>_<secret>`
- `op_live_` — stable prefix (greppable for secret scanners; fast pre-check before parsing).
- `keyId` — 16 hex chars (8 bytes). Contains no `_`, so the secret splits off unambiguously.
- `secret` — 32 random bytes, base64url (43 chars).

**Hashing:** only `sha256(secret)` is persisted. The full key is returned to the caller **exactly once**, at creation. `keyPrefix(keyId)` = `op_live_<keyId>` is the safe display/log form.

**Verification:** `parseKey` (strict; never throws → null on any malformation) → lookup by `keyId` → `verifySecret` compares `sha256(presentedSecret)` against the stored hash with `crypto.timingSafeEqual` (constant-time). `parseBearer` extracts the credential from an `Authorization: Bearer …` header (case-insensitive).

**Tokens:** `randomToken()` (32 bytes base64url) for email verification; stored as `sha256(token)`, compared with `verifyToken` (constant-time). Single-use: a successful verify clears the stored hash. The instant-lane **claim/mgmt tokens** and the operator **`x-admin-token`** are likewise compared in constant time (`constantTimeEqual`, `packages/run/src/auth.ts`) — an empty `OPENPOUCH_RUN_ADMIN_TOKEN` makes the comparator always false, disabling `/api/admin/*`.

**Secret discipline (global rule 7):** secrets never appear in logs or the public key views; only hashes are persisted; the raw key/token crosses the boundary once (HTTP response / web page / written to a 0600 file by the CLI).

---

## 4. Quota engine (`packages/run/src/quota.ts`)

Pure functions (no I/O, caller passes `now`) so the window math is exhaustively unit-testable.

### `Tier`

| Field | Unit | Meaning |
|---|---|---|
| `name` | — | Tier id. |
| `deploysPerHour` | count | Max deploy starts in any rolling 1h window. |
| `deploysPerDay` | count | Max deploy starts in any rolling 24h window. |
| `maxLiveDeployments` | count | Max concurrently live deployments the account may own. |
| `maxBytes` | bytes | Max upload size per deploy (effective limit = `min(tier.maxBytes, OPENPOUCH_RUN_MAX_BYTES)`; see §7). |
| `maxDynamic` | count | Max concurrently live *dynamic* (container) deployments owned. |

### Default tiers — **PROVISIONAL** (D16: numbers open until dogfood)

| Tier | /hour | /day | maxLive | maxBytes | maxDynamic |
|---|---|---|---|---|---|
| `anonymous` | 10 | 30 | 20 | 25 MB | 3 |
| `free` | 30 | 100 | 50 | 50 MB | 10 |
| `pro` | 120 | 1000 | 500 | 250 MB | 100 |

`anonymous` mirrors today's per-IP instant-lane limits so flipping a key on/off changes only the ceiling, never the agent flow. Numbers are **configurable without a code change** via `OPENPOUCH_TIERS_JSON` (a JSON object `{ [name]: Tier }` that fully replaces the table; an invalid value falls back to the defaults **with a warning**, and the `anonymous` tier must be present).

### `checkQuota(tier, usage, { now, bytes, dynamic })`

Returns `{ ok: true }` or `{ ok: false, reason, status, message, fix, retryAfterMs? }`. Checks in order, every denial
agent-readable:

| Order | Reason | HTTP | When |
|---|---|---|---|
| 1 | `too-large` | 413 | `bytes > tier.maxBytes` |
| 2 | `max-dynamic` | 429 | dynamic deploy && `dynamicCount >= tier.maxDynamic` |
| 3 | `max-live` | 429 | `liveCount >= tier.maxLiveDeployments` |
| 4 | `rate-day` | 429 | deploys in last 24h `>= tier.deploysPerDay` (+ `retryAfterMs`) |
| 5 | `rate-hour` | 429 | deploys in last 1h `>= tier.deploysPerHour` (+ `retryAfterMs`) |

`usage` = `{ recentDeploys: number[], liveCount, dynamicCount }`; the server builds it from `AccountStore.usageWindows(accountId, now)` + `Store.countOwned(accountId)`.

---

## 5. HTTP API (run-d)

Base URL = run-d origin (e.g. `https://openpouch.sh`). Every account route is agent-usable — no human check, no CAPTCHA (R8). `Authorization: Bearer <key>` authenticates; `x-admin-token: <token>` gates operator routes (also blocked from the public edge by Caddy).

### Signup + verification (email path)

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/api/accounts` | none (per-IP rate-limited) | `{ email }` | `201 { ok, accountId, message, [devVerifyToken, devVerifyUrl] }` | `400 invalid-email`, `409 exists`, `429` |
| POST/GET | `/api/accounts/verify` | none | POST `{ account, token }` or GET `?account=&token=` | POST `200 { ok, key, account }` · GET → HTML page showing the key | `404 not-found`, `403 bad-token`, `403 expired`, `409 already-active` |

`devVerifyToken`/`devVerifyUrl` appear **only** when `OPENPOUCH_RUN_DEV_TOKENS=1` (local/dogfood, since the placeholder mailer doesn't send real email — never enable in production). The first API key is minted on verify and returned **once**.

**`409 exists` fires only for a VERIFIED (or GitHub-linked) email** — one already in the identity index. A repeat `POST
/api/accounts` for an email that is still **pending** (signed up but never verified) does **not** create a second
account: `createPendingEmail` finds the existing pending record via `findPendingByEmail`, refreshes its verification
token + expiry in place, and returns it (`201`, same `accountId`). This both prevents duplicate pending accounts from
piling up and doubles as "resend the verification link" (the previously-sent link is superseded). The email send is
still per-IP rate-limited.

### Signup (GitHub path) — dormant unless configured

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/auth/github/start` | `302` redirect to GitHub authorize (with a CSRF `state`); `503` if `OPENPOUCH_RUN_GITHUB_CLIENT_ID`/`SECRET` unset. |
| GET | `/api/auth/github/callback?code=&state=` | Validates `state`, exchanges the code, links-or-creates the GitHub-anchored account, renders an HTML page showing the freshly minted key. `403` on bad/expired state, `502` if the GitHub exchange fails, `503` if unconfigured. |

### Account + keys (authenticated)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/api/account` | — | `200 { ok, account, tier, usage }` (usage = liveDeployments, dynamicDeployments, deploysLastHour, deploysLastDay) | `401` |
| POST | `/api/keys` | `{ label? }` | `201 { ok, key, keyId }` (key shown once) | `401`, `400` |
| GET | `/api/keys` | — | `200 { ok, keys: ApiKeyView[] }` (prefix only, never the secret) | `401` |
| DELETE | `/api/keys/:keyId` | — | `200 { ok }` | `401`, `404` |

### Operator (admin-token)

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/admin/accounts/:id/tier` | `{ tier }` | Set the account's tier (must exist in the table). `400 unknown tier`, `404`. |
| POST | `/api/admin/accounts/:id/status` | `{ status: "active" \| "suspended" }` | Suspend (key auth denied) or reinstate. `400`, `404`. |

### Deploy key-gating

`POST /api/deployments` now reads the bearer:
- No header → anonymous tier (per-IP limiter + global caps, unchanged).
- Header present but unresolved → `401`.
- Valid key → resolve account; if `requireKey` on and no key → `401`. `checkQuota` runs against the account's usage (rate, concurrency, size) **after extraction + classification** (the flow is: read body → global cap → `extractTarball` → `classifyUpload` → `checkQuota`; the classification feeds the `dynamic` flag into the check, and the extracted temp dir is `rm`-ed on a quota denial). On success the record is stamped with `accountId` and the deploy start is metered (`recordDeploy`).
- The global `maxDeployments` / `maxDynamicDeployments` caps still apply to everyone (box disk/RAM protection).

---

## 6. Configuration (env, `configFromEnv`)

| Env var | Default | Meaning |
|---|---|---|
| `OPENPOUCH_RUN_REQUIRE_KEY` | `0` (off) | `1` → require a key on every deploy (lane key-gated). |
| `OPENPOUCH_TIERS_JSON` | — | Full tier-table override (JSON). Invalid → defaults + warning. |
| `OPENPOUCH_RUN_VERIFY_TTL_MS` | `86400000` (24h) | Email-verification token lifetime. |
| `OPENPOUCH_RUN_ACCOUNT_PUBLIC_BASE` | `publicBase` | Origin for verification/claim links. |
| `OPENPOUCH_RUN_GITHUB_CLIENT_ID` | `""` | GitHub OAuth app id (empty → GitHub path dormant). |
| `OPENPOUCH_RUN_GITHUB_CLIENT_SECRET` | `""` | GitHub OAuth app secret. **Secret** — provide via env/EnvironmentFile, never in the repo. |
| `OPENPOUCH_RUN_GITHUB_CALLBACK_URL` | `<publicBase>/api/auth/github/callback` | Registered redirect URI. |
| `OPENPOUCH_RUN_DEV_TOKENS` | `0` (off) | DEV ONLY: return raw verify tokens in the signup response. |
| `OPENPOUCH_RUN_SMTP_HOST` | `""` | SMTP server host. **Empty → mailer dormant** (verification emails spool to `mail.outbox.jsonl`). Set it to deliver real email. |
| `OPENPOUCH_RUN_SMTP_PORT` | `587` | `465` = implicit TLS (set `SECURE=1`); `587`/`25` = plain + STARTTLS upgrade. |
| `OPENPOUCH_RUN_SMTP_USER` | `""` | SMTP auth user (AUTH LOGIN). Empty → no AUTH. |
| `OPENPOUCH_RUN_SMTP_PASS` | `""` | SMTP auth password / API token. **Secret** — via env/EnvironmentFile, never the repo. |
| `OPENPOUCH_RUN_SMTP_FROM` | `openpouch <noreply@<baseDomain>>` | From header + envelope sender. |
| `OPENPOUCH_RUN_SMTP_SECURE` | `0` | `1` → connect over implicit TLS (port 465). Otherwise plain + STARTTLS when the server offers it. |

**Mailer.** `createMailer` picks the real `SmtpMailer` when `OPENPOUCH_RUN_SMTP_HOST` is set, else the `OutboxMailer` spool (default-safe — no provider needed). The `SmtpMailer` is **dependency-free** (`node:net`/`node:tls`, so `@openpouch/run` stays zero-dependency) and works with any SMTP provider (Resend, Postmark, SES, Mailgun, Gmail, …) — no lock-in. It refuses to send credentials over a connection that never reached TLS (use port 465 or a STARTTLS server). Activating it is a config-only owner step (provide a provider + credential); no code change.

---

## 7. CLI surface (`packages/cli`)

The agent's credential is resolved from `OPENPOUCH_API_KEY`, then the key file (default `~/.openpouch/openpouch-run.key`, chmod 600; override the path with `OPENPOUCH_KEY_FILE`, honoured by both reading and writing). No key → anonymous (PRD R5). The value is sent as `Authorization: Bearer …` by the adapter and never logged.

| Command | What it does |
|---|---|
| `openpouch signup --email <addr>` | Starts an email signup → a verification link is emailed; prints the account id + the `activate` command. |
| `openpouch signup --github` | Prints the GitHub authorize URL to open in a browser. |
| `openpouch activate --account <id> --token <token>` | Completes an email signup; **saves the issued key to the key file (default `~/.openpouch/openpouch-run.key`, 0600; override via `OPENPOUCH_KEY_FILE` or `--key-file <path>`)** so future deploys are keyed (PRD R4 — no manual step). **Data-loss guard:** the file is written only when it is absent, empty, or already an openpouch key — it **never** overwrites a foreign file (e.g. a private key); an existing openpouch key is copied to `<path>.bak` (0600) first. The JSON carries only the non-secret `keyPrefix`; the raw key appears in the output (with `saved:false` + `reason`) **only** when it could not be saved — write failure *or* the guard refused — because the token is single-use and would otherwise be lost. |
| `openpouch whoami` | Shows the account behind the key (tier + usage), or that the caller is anonymous. Read-only. |
| `openpouch list` | Lists the live instant-lane apps owned by the configured account key (name/kind/status/URL/expiry). Read-only; anonymous → empty + signup pointer. Secret-free (no capability token, D7). |
| `openpouch delete <name>` | Deletes one of your OWN instant-lane apps by name → frees a quota slot (Befund #8). Owner-only (account key, server-verified); an ephemeral preview is not a governed-production action → no approval, agent-usable (D13). |
| `openpouch deploy` | The instant lane — now sends the key if one is configured (deploy runs under the account), else anonymous. |

All outputs carry the universal jargon-free `summary` (PRD R3, [CLI.md](CLI.md) §summary). `--json` and MCP carry the identical structure (D13).

## 8. MCP surface (`packages/mcp`)

- **`openpouch_whoami`** — read-only account status (tier + usage), wrapping the same `whoamiCommand`. Carries the relay `summary` block.
- **`openpouch_list`** — read-only: your own live instant-lane apps (name/kind/status/URL/expiry), wrapping `listCommand`; needs an account key (anonymous → empty + signup pointer), never a capability token (D7).
- **`openpouch_delete`** (`slug`) — delete one of your OWN apps → frees a quota slot, wrapping `deleteCommand`; owner-only (account key, server-verified). Deleting an ephemeral preview is not a governed-production action → no approval (D13). These three (`whoami`/`list`/`delete`) take no `cwd` (account-scoped or slug-only).
- Signup/activation are **CLI + web only** — they involve a human email or browser step, so they are deliberately not MCP tools. There is still **no approve tool** (D13).

---

## 9. Persistence + files on disk

| File (in `dataDir`) | Content |
|---|---|
| `accounts.json` | `{ version, accounts[], keys[] }` (keys hold only hashed secrets). |
| `mail.outbox.jsonl` | Mailer spool (one JSON line per verification email) — written by the default `OutboxMailer` when no SMTP host is configured. Once `OPENPOUCH_RUN_SMTP_HOST` is set, the `SmtpMailer` delivers real email and this file is no longer used. Lives in the protected data dir. |

## 10. Security model + what's dormant

- **Built + tested, default-safe:** the whole subsystem ships behind defaults that preserve today's behaviour — `requireKey=off` (anonymous lane open, R5), GitHub path dormant (no client id/secret), dev tokens off. M1/M2 behaviour is unchanged when no key is presented.
- **Rolled out (LIVE):** the subsystem is **live on the production box** (server-side rollout 2026-06-30; email signup live 2026-07-01) — `requireKey` stays default-OFF (anonymous lane open, R5); flip it only if abuse demands.
- **Still owner-config (DINO):** (a) **GitHub OAuth app** — register it, set `OPENPOUCH_RUN_GITHUB_CLIENT_ID/SECRET/CALLBACK_URL` (verify on box); (b) **real mailer** — the `SmtpMailer` is **built + live** where `OPENPOUCH_RUN_SMTP_HOST` is set (+ `USER`/`PASS`/`FROM` = an SMTP provider + credential); with no host set the verification link spools to `mail.outbox.jsonl`; (c) **tier numbers/prices** — set after dogfood via `OPENPOUCH_TIERS_JSON`.
- **Suspension nuance:** suspending an account revokes its key auth (its keyed requests → 401). It does not block the same human from deploying *anonymously* (per-IP + global caps still apply, and specific content is handled by report/takedown). Hard per-identity blocking is out of B3 scope.

## 11. How to verify (acceptance)

Run gate 2 (`npm run test`). The subsystem is covered by:
- `packages/run/test/auth.test.ts` — key format, hashing, parsing, constant-time verify (adversarial).
- `packages/run/test/quota.test.ts` — tier defaults, `OPENPOUCH_TIERS_JSON` override/fallback, every quota limit + window.
- `packages/run/test/mailer.test.ts` — `SmtpMailer` against a fake SMTP server: full dialog + verification body, AUTH LOGIN (base64 user/pass), recipient rejection, refusal to AUTH over an unencrypted connection, timeout; `createMailer` picks SmtpMailer vs OutboxMailer by config.
- `packages/run/test/accounts.test.ts` — store: email signup→verify→key, GitHub link-or-create, mint/list/revoke, resolve (malformed/suspended/revoked), usage pruning, persistence round-trip (file never holds a raw secret/token).
- `packages/run/test/accounts-server.test.ts` — HTTP: signup→key→owned deploy, whoami, `requireKey`, per-account quota (max-live 429), key lifecycle endpoints, admin tier/suspend, GitHub OAuth (start 302 → callback key, dormant 503, CSRF), deploy-auth 401 (invalid/suspended key).
- `packages/adapter-run/test/run.test.ts` — client: Bearer threading, whoami/signup/verify, 401→auth, GitHub start URL.
- `packages/cli/test/accounts.test.ts` — whoami (anon/keyed, key threaded), signup (email/github/usage error), activate (writes 0600 key file, secret kept out of JSON).
- `packages/cli/test/summary.test.ts` — the account summaries are jargon-free (R3).
- `packages/mcp/test/mcp.test.ts` — `openpouch_whoami` registered + anonymous path through MCP.
