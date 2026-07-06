# API reference — `@openpouch/core`

**Derived from:** `packages/core/src/index.ts` exports · **As of:** 2026-07-02 · Package is `private: true` (bundled into `openpouch`, not published standalone), ESM. Source entry `src/index.ts`; the package `exports["."]` resolves to the compiled `./dist/index.js` (types `./dist/index.d.ts`) — so a consumer imports the built output, not `src`.

## Manifest (`manifest.ts`)

| Export | Kind | Signature / shape | Behavior |
|---|---|---|---|
| `PROVIDER_IDS` | const | `readonly ["render", "vercel", "openpouch-run"]` | source of truth for providers (`openpouch-run` = instant lane) |
| `providerIdSchema` | zod | `z.enum(PROVIDER_IDS)` | |
| `ENVIRONMENT_NAMES` | const | `readonly ["preview", "staging", "production"]` | |
| `environmentNameSchema` | zod | `z.enum(ENVIRONMENT_NAMES)` | |
| `envVarRequirementSchema` | zod | strict object | see DATA-MODEL §1 |
| `healthcheckSchema` | zod | strict object | defaults: `expectStatus 200`, `timeoutMs 10000` |
| `environmentConfigSchema` | zod | strict object | |
| `manifestSchema` | zod | strict object | the full `deploy.manifest.json` schema |
| `parseManifest` | function | `(input: unknown) => ParseResult<Manifest>` | never throws; returns `{ok:true, value}` (with defaults applied) or `{ok:false, errors: string[]}` with `"deploy.manifest.json:<path>: <message>"` strings |
| `MANIFEST_FILENAME` | const | `"deploy.manifest.json"` | |
| Types | — | `Manifest`, `EnvironmentConfig`, `EnvVarRequirement`, `Healthcheck`, `EnvironmentName`, `ProviderId`, `ParseResult<T>` | inferred from schemas |

`ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }`

## Policy (`policy.ts`)

| Export | Kind | Signature / shape | Behavior |
|---|---|---|---|
| `ACTION_CLASSES` | const | `readonly ["read","deploy-preview","deploy-production","env-write","rollback"]` | no destructive class by design |
| `actionClassSchema` | zod | `z.enum(ACTION_CLASSES)` | |
| `environmentPolicySchema` | zod | strict; `allow` & `requireApproval` default `[]` | |
| `policySchema` | zod | strict; `environments` defaults `{}` | the full `deploy.policy.json` schema |
| `evaluateAction` | function | `(policy: Policy, environment: EnvironmentName, action: ActionClass) => PolicyDecision` | pure; precedence: `requireApproval` > `allow` > (read → allowed) > deny (default) |
| `defaultPolicy` | function | `() => Policy` | preview allows `read` + `deploy-preview` + `env-write`; production allows `read` and requires approval for `deploy-production` + `rollback` + `env-write` |
| `POLICY_FILENAME` | const | `"deploy.policy.json"` | |
| Types | — | `Policy`, `EnvironmentPolicy`, `ActionClass`, `PolicyDecision` | `PolicyDecision = "allowed" \| "requires-approval" \| "denied"` |

## Evidence (`evidence.ts`)

| Export | Kind | Shape |
|---|---|---|
| `smokeCheckSchema`, `deploymentRecordSchema`, `evidenceSchema` | zod | strict objects, see DATA-MODEL §3 |
| `EVIDENCE_FILENAME` | const | `"deploy.evidence.json"` |
| Types | — | `Evidence`, `DeploymentRecord`, `SmokeCheck` |

## Adapter contract (`adapter.ts`)

```ts
interface ProviderAdapter {
  readonly id: ProviderId;
  listServices(): Promise<ServiceSummary[]>;
  getService(serviceId: string): Promise<ServiceSummary>;
  getRecentDeploys(serviceId: string, limit?: number): Promise<DeploySummary[]>;
  getEnvVarNames(serviceId: string): Promise<EnvVarStatus[]>; // names/presence ONLY — never values
  getLogs(serviceId: string, opts?: { limit?: number }): Promise<LogLine[]>;
  // write path — callers MUST consult evaluateAction first; adapters execute, they do not decide:
  triggerDeploy(serviceId: string, opts?: { clearCache?: boolean; commitId?: string }): Promise<DeploySummary>; // commitId = provider-portable rollback primitive (redeploy that commit)
  getDeploy(serviceId: string, deployId: string): Promise<DeploySummary>;
}
type AdapterFactory = (config: { apiKey: string; environment?: EnvironmentName }) => ProviderAdapter;
```

## Approvals (`approvals.ts`)

| Export | Kind | Behavior |
|---|---|---|
| `approvalRequestSchema`, `approvalsFileSchema`, `approvalStatusSchema` | zod | see DATA-MODEL §4 |
| `canonicalApprovalPayload(req)` | function | stable signing string `id\|action\|environment\|serviceId\|requestedAt\|expiresAt` |
| `findUsableApproval(file, {action, environment, serviceId}, now)` | function | approved + exact match + unexpired, else `undefined` |
| `isExpired(req, now)` | function | inclusive at the boundary (`expiresAt <= now` → expired) |
| `APPROVALS_DIR`, `APPROVALS_FILENAME` | const | `".openpouch"`, `".openpouch/approvals.json"` |
| Types | — | `ApprovalRequest`, `ApprovalsFile`, `ApprovalStatus` |

## Evidence IO (`evidence-io.ts`)

| Export | Kind | Behavior |
|---|---|---|
| `readEvidence(dir)` | function | missing file → empty evidence; invalid file → **throws** (never silently overwrite history) |
| `writeEvidence(dir, evidence)` | function | validates, writes `deploy.evidence.json` + regenerates `DEPLOYMENT.md` |
| `appendDeployment(dir, record)` | function | prepends (newest first), then `writeEvidence` |
| `renderDeploymentMd(evidence)` | function | "Currently live" table (latest per environment) + full history list |
| `DEPLOYMENT_MD_FILENAME` | const | `"DEPLOYMENT.md"` |

Supporting types: `ServiceSummary {id, name, url?, branch?, runtime?, suspended?}` · `DeploySummary {id, status: "live"|"building"|"failed"|"canceled"|"queued", commit?, commitMessage?, createdAt, finishedAt?}` · `EnvVarStatus {name, present}` · `LogLine {timestamp?, message}`.

Contract rules: (1) implementations must never return secret values across this boundary; (2) every write operation added in week 2 must consult `evaluateAction` before executing.

## Dependencies

`zod ^3.25.0` (only runtime dependency). Dev: TypeScript ^5.5 (strict, NodeNext ESM), vitest ^3, Node ≥ 20.
