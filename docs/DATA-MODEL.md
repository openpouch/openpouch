# Data model — the three openpouch file formats

**Derived from:** `packages/core/src/manifest.ts`, `policy.ts`, `evidence.ts`, `approvals.ts` (zod schemas, v0) · **As
of:** 2026-07-02

All three files live in the **user's repo root**. All schemas are **strict**: unknown keys are rejected (this is a
security feature — e.g. a `secrets` key in a manifest fails validation). All files share `"version": 0` (literal) and an
optional `"$schema"` string.

> **Server-side state is separate.** The instant lane's deployment registry and the B3 account/API-key/quota records are
**box-server truth**, not repo files — they live in run-d's data dir, documented in [INSTANT-LANE.md](INSTANT-LANE.md)
and [ACCOUNTS.md](ACCOUNTS.md). This page covers only the repo-file formats produced/consumed by the local CLI/MCP.

## Shared enums

| Enum | Values | Notes |
|---|---|---|
| `ProviderId` | `"render"`, `"vercel"`, `"openpouch-run"` | `openpouch-run` = instant lane; extending = code change in `PROVIDER_IDS` |
| `EnvironmentName` | `"preview"`, `"staging"`, `"production"` | fixed set in v0 |
| `ActionClass` | `"read"`, `"deploy-preview"`, `"deploy-production"`, `"env-write"`, `"rollback"` | **deliberately no delete/destroy class in v0** |

## 1. `deploy.manifest.json` — durable deployment truth

| Field | Type | Required | Default | Constraints / unit |
|---|---|---|---|---|
| `version` | literal `0` | yes | — | |
| `project.name` | string | yes | — | min length 1 |
| `project.repo` | string | no | — | e.g. `github.com/org/repo` |
| `project.framework` | string | no | — | e.g. `node`, `nextjs` |
| `build.buildCommand` | string | no | — | |
| `build.startCommand` | string | no | — | |
| `build.rootDir` | string | no | — | |
| `healthcheck.path` | string | yes (if healthcheck set) | — | must start with `/` |
| `healthcheck.expectStatus` | integer | no | `200` | 100–599 |
| `healthcheck.timeoutMs` | integer | no | `10000` | **milliseconds**, > 0 |
| `env[]` | array | no | `[]` | env var **names only — never values** |
| `env[].name` | string | yes | — | min length 1 |
| `env[].required` | boolean | no | `true` | |
| `env[].environments` | EnvironmentName[] | no | — | omitted = applies to all |
| `env[].description` | string | no | — | |
| `environments` | record EnvironmentName → config | yes | — | at least the keys you deploy to |
| `environments.*.provider` | ProviderId | yes | — | |
| `environments.*.serviceId` | string | no | — | provider-side id, e.g. Render `srv-…` |
| `environments.*.url` | string (URL) | no | — | |
| `environments.*.branch` | string | no | — | |
| `environments.*.autoDeploy` | boolean | no | — | |

## 2. `deploy.policy.json` — what agents may do

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `version` | literal `0` | yes | — | |
| `environments` | record EnvironmentName → policy | no | `{}` | |
| `environments.*.allow` | ActionClass[] | no | `[]` | |
| `environments.*.requireApproval` | ActionClass[] | no | `[]` | wins over `allow` (precedence in API.md `evaluateAction`) |
| `approvers[]` | array | no | — | |
| `approvers[].name` | string | yes | — | min length 1 |
| `approvers[].contact` | string | no | — | |

## 3. `deploy.evidence.json` — what actually happened

| Field | Type | Required | Default | Constraints / unit |
|---|---|---|---|---|
| `version` | literal `0` | yes | — | |
| `deployments[]` | array | no | `[]` | append-only by convention |
| `deployments[].id` | string | yes | — | min length 1 |
| `deployments[].environment` | EnvironmentName | yes | — | |
| `deployments[].provider` | ProviderId | yes | — | |
| `deployments[].status` | enum | yes | — | `live` \| `failed` \| `rolled-back` \| `superseded` |
| `deployments[].url` | string (URL) | no | — | |
| `deployments[].commit` | string | no | — | git SHA or tag |
| `deployments[].deployedAt` | string | yes | — | **ISO 8601 datetime** (zod `.datetime()`) |
| `deployments[].approvedBy` | string | no | — | |
| `deployments[].smoke[]` | array | no | — | |
| `deployments[].smoke[].name` | string | yes | — | min length 1 |
| `deployments[].smoke[].url` | string (URL) | no | — | |
| `deployments[].smoke[].passed` | boolean | yes | — | |
| `deployments[].smoke[].detail` | string | no | — | |
| `deployments[].rollbackAnchor` | string | no | — | provider-side id of last known-good deploy |
| `deployments[].notes` | string | no | — | |
| `deployments[].cliVersion` | string | no | — | openpouch CLI that produced the record (OpenClaw 2026-07-04: deploy context in one place) |
| `deployments[].kind` | `"static"` \| `"dynamic"` | no | — | instant-lane classification |
| `deployments[].framework` | string | no | — | detected framework (same detector as `init`) |
| `deployments[].buildCommand` | string | no | — | detected build command |
| `deployments[].startCommand` | string | no | — | detected start command |
| `deployments[].healthStatus` | `"pending"` \| `"healthy"` \| `"degraded"` | no | — | outcome of the post-deploy health gate |
| `deployments[].expiresAt` | string (ISO-8601 UTC) | no | — | instant-preview expiry |
| `deployments[].envVarNames` | string[] | no | — | NAMES of `--var`/`--env-file` vars — values are secrets (D7) and never recorded |
| `deployments[].healthPath` | string | no | — | the `--health-path` the deploy was held to |

## 4. `.openpouch/approvals.json` — local approval state (gitignored)

| Field | Type | Required | Constraints |
|---|---|---|---|
| `version` | literal `0` | yes | |
| `requests[]` | array | no (default `[]`) | |
| `requests[].id` | string | yes | 8-hex random |
| `requests[].action` | ActionClass | yes | |
| `requests[].environment` | EnvironmentName | yes | |
| `requests[].serviceId` | string | yes | min length 1 |
| `requests[].requestedAt` / `expiresAt` | ISO 8601 datetime | yes | TTL 24 h from creation |
| `requests[].status` | enum | yes | `pending` \| `approved` \| `consumed` \| `expired` |
| `requests[].approvedAt` | datetime | no | set on approval |
| `requests[].approvedBy` | string | no | OS username of the approver |
| `requests[].signature` | string | no | HMAC-SHA256 hex over `id\|action\|environment\|serviceId\|requestedAt\|expiresAt`, keyed by `~/.openpouch/approver.secret` |
| `requests[].note` | string | no | |

Unlike files 1–3 this is **runtime state**, not repo history: auto-gitignored; the durable audit trail is the
`approvedBy`/`notes` fields in `deploy.evidence.json`. Companion artifact: `DEPLOYMENT.md` — human-readable mirror of
the evidence file, regenerated on every evidence write; never edit by hand.

## Filename constants

`MANIFEST_FILENAME = "deploy.manifest.json"`, `POLICY_FILENAME = "deploy.policy.json"`, `EVIDENCE_FILENAME = "deploy.evidence.json"` (exported by `@openpouch/core`).

## Error format (agent-facing)

`parseManifest` returns `{ ok: false, errors: string[] }` where each error is `"<filename>:<dot.path>: <message>"`, e.g. `deploy.manifest.json:environments.production.provider: Invalid enum value…` — agents can map errors straight to the offending field. Root-level issues use the path `<root>`.
