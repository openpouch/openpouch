/**
 * Tier + per-account quota engine (B3 / SSOT D16).
 *
 * Pure functions only — no I/O, no clock of its own (the caller passes `now`),
 * so the window math is exhaustively unit-testable. The AccountStore owns the
 * usage counters; the server calls `checkQuota` before accepting a deploy.
 *
 * Abuse is controlled with agent-compatible levers only (rate, concurrency,
 * size, dynamic count) — never a human check or CAPTCHA (PRD R8). Anonymous
 * traffic (no API key) runs on the tightest tier; an API key lifts the caller
 * into its account's tier (PRD R5: a key is optional, deploying needs no setup).
 *
 * NUMBERS ARE PROVISIONAL. D16: the *mechanism* is what B3 builds; the exact
 * quota numbers + prices stay open until dogfooding. Operators retune them
 * without a code change via OPENPOUCH_TIERS_JSON (see `tiersFromEnv`).
 */

export interface Tier {
  /** Tier id, e.g. "anonymous" | "free" | "pro". */
  name: string;
  /** Max deploys started in any rolling 1h window. */
  deploysPerHour: number;
  /** Max deploys started in any rolling 24h window. */
  deploysPerDay: number;
  /** Max concurrently live deployments the account may own. */
  maxLiveDeployments: number;
  /** Max upload size per deploy, in bytes. */
  maxBytes: number;
  /** Max concurrently live *dynamic* (container) deployments the account may own. */
  maxDynamic: number;
  /** L10 (staged 0.3.0): max bytes in the account's persistent /data volumes. 0 = volumes not available on this tier. */
  volumeMaxBytes: number;
  /** Staged 0.3.0: max concurrently live always-on (never idle-stopped) dynamic apps. 0 = not available. */
  maxAlwaysOn: number;
}

export type TierTable = Record<string, Tier>;

/** The tier assigned to traffic with no API key. Tightest limits by design. */
export const ANONYMOUS_TIER = "anonymous";
/** The tier a freshly created account lands on. */
export const DEFAULT_ACCOUNT_TIER = "free";

const MB = 1024 * 1024;

/**
 * Provisional default tiers (D16 — numbers open until dogfood). `anonymous`
 * mirrors today's per-IP instant-lane limits so flipping a key on/off changes
 * only the ceiling, never the agent flow. Tune via OPENPOUCH_TIERS_JSON.
 */
export function defaultTiers(): TierTable {
  return {
    [ANONYMOUS_TIER]: {
      name: ANONYMOUS_TIER,
      deploysPerHour: 10,
      deploysPerDay: 30,
      maxLiveDeployments: 20,
      maxBytes: 25 * MB,
      maxDynamic: 3,
      volumeMaxBytes: 0,
      maxAlwaysOn: 0,
    },
    free: {
      name: "free",
      deploysPerHour: 30,
      deploysPerDay: 100,
      maxLiveDeployments: 50,
      maxBytes: 50 * MB,
      maxDynamic: 10,
      volumeMaxBytes: 0,
      maxAlwaysOn: 0,
    },
    pro: {
      name: "pro",
      deploysPerHour: 120,
      deploysPerDay: 1000,
      maxLiveDeployments: 500,
      maxBytes: 250 * MB,
      maxDynamic: 100,
      volumeMaxBytes: 5 * 1024 * MB,
      maxAlwaysOn: 3,
    },
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Validate one parsed tier object, returning a clean Tier or null. */
function coerceTier(name: string, raw: unknown): Tier | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const fields = ["deploysPerHour", "deploysPerDay", "maxLiveDeployments", "maxBytes", "maxDynamic"] as const;
  for (const f of fields) if (!isFiniteNumber(r[f])) return null;
  // Staged-0.3.0 fields are OPTIONAL (default 0 = feature off) so an operator's
  // existing OPENPOUCH_TIERS_JSON keeps parsing unchanged across the rollout.
  const optional = (v: unknown): number => (isFiniteNumber(v) ? v : 0);
  return {
    name,
    deploysPerHour: r.deploysPerHour as number,
    deploysPerDay: r.deploysPerDay as number,
    maxLiveDeployments: r.maxLiveDeployments as number,
    maxBytes: r.maxBytes as number,
    maxDynamic: r.maxDynamic as number,
    volumeMaxBytes: optional(r.volumeMaxBytes),
    maxAlwaysOn: optional(r.maxAlwaysOn),
  };
}

/**
 * Build the tier table from the environment. OPENPOUCH_TIERS_JSON, if set to a
 * valid JSON object of `{ [name]: Tier }`, fully replaces the defaults — this
 * is the configurable knob D16 asks for (retune numbers without redeploying
 * code). A missing/invalid value falls back to `defaultTiers()`; an invalid
 * value also reports the reason so the operator can fix it.
 */
export function tiersFromEnv(env: Record<string, string | undefined>): { tiers: TierTable; warning?: string } {
  const raw = env.OPENPOUCH_TIERS_JSON?.trim();
  if (!raw) return { tiers: defaultTiers() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { tiers: defaultTiers(), warning: `OPENPOUCH_TIERS_JSON ignored — invalid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { tiers: defaultTiers(), warning: "OPENPOUCH_TIERS_JSON ignored — not a JSON object" };
  }
  const table: TierTable = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const tier = coerceTier(name, value);
    if (!tier) return { tiers: defaultTiers(), warning: `OPENPOUCH_TIERS_JSON ignored — tier "${name}" is malformed` };
    table[name] = tier;
  }
  // The anonymous tier must always exist (it gates keyless traffic).
  if (!table[ANONYMOUS_TIER]) return { tiers: defaultTiers(), warning: `OPENPOUCH_TIERS_JSON ignored — missing "${ANONYMOUS_TIER}" tier` };
  return { tiers: table };
}

/** Resolve a tier by name, falling back to anonymous (then a hard default). */
export function resolveTier(tiers: TierTable, name: string | undefined): Tier {
  return (name && tiers[name]) || tiers[ANONYMOUS_TIER] || defaultTiers()[ANONYMOUS_TIER]!;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A snapshot of an account's (or anonymous IP's) current usage. */
export interface QuotaUsage {
  /** Timestamps (ms) of recent deploy starts. The caller may pass an unpruned list. */
  recentDeploys: number[];
  /** Count of currently live deployments owned by the subject. */
  liveCount: number;
  /** Count of currently live *dynamic* deployments owned by the subject. */
  dynamicCount: number;
}

export type QuotaReason = "rate-hour" | "rate-day" | "max-live" | "max-dynamic" | "too-large";

export type QuotaCheck =
  | { ok: true }
  | { ok: false; reason: QuotaReason; status: number; message: string; fix: string; retryAfterMs?: number };

export interface QuotaInput {
  now: number;
  /** Upload size of this deploy, in bytes. */
  bytes: number;
  /** Whether this deploy will run as a dynamic (container) app. */
  dynamic: boolean;
}

/**
 * Decide whether a deploy is within the tier's quota. Ordered so the most
 * static signals (size) report first, then concurrency, then rate (which can
 * carry a retry hint). Every denial is agent-readable (status + message + fix).
 */
export function checkQuota(tier: Tier, usage: QuotaUsage, input: QuotaInput): QuotaCheck {
  if (input.bytes > tier.maxBytes) {
    return {
      ok: false,
      reason: "too-large",
      status: 413,
      message: `upload is ${input.bytes} bytes; the ${tier.name} tier allows ${tier.maxBytes}`,
      fix: "Trim the upload (exclude build/node_modules) or use a higher tier / BYO provider.",
    };
  }

  if (input.dynamic && usage.dynamicCount >= tier.maxDynamic) {
    return {
      ok: false,
      reason: "max-dynamic",
      status: 429,
      message: `you already run ${usage.dynamicCount} dynamic app(s); the ${tier.name} tier allows ${tier.maxDynamic}`,
      fix: "Free a slot: run `openpouch list` to see your apps, then `openpouch delete <slug>` to remove an unused one — or use a higher tier.",
    };
  }

  if (usage.liveCount >= tier.maxLiveDeployments) {
    return {
      ok: false,
      reason: "max-live",
      status: 429,
      message: `you already have ${usage.liveCount} live deployment(s); the ${tier.name} tier allows ${tier.maxLiveDeployments}`,
      fix: "Free a slot: run `openpouch list` then `openpouch delete <slug>` to remove an old one — or use a higher tier.",
    };
  }

  const dayHits = usage.recentDeploys.filter((t) => input.now - t < DAY_MS);
  if (dayHits.length >= tier.deploysPerDay) {
    const oldest = Math.min(...dayHits);
    return {
      ok: false,
      reason: "rate-day",
      status: 429,
      message: `daily deploy limit reached (${tier.deploysPerDay}/day on the ${tier.name} tier)`,
      fix: "Wait for the window to roll over, or use a higher tier.",
      retryAfterMs: Math.max(0, oldest + DAY_MS - input.now),
    };
  }

  const hourHits = dayHits.filter((t) => input.now - t < HOUR_MS);
  if (hourHits.length >= tier.deploysPerHour) {
    const oldest = Math.min(...hourHits);
    return {
      ok: false,
      reason: "rate-hour",
      status: 429,
      message: `hourly deploy limit reached (${tier.deploysPerHour}/hour on the ${tier.name} tier)`,
      fix: "Wait a few minutes and retry, or use a higher tier.",
      retryAfterMs: Math.max(0, oldest + HOUR_MS - input.now),
    };
  }

  return { ok: true };
}

/** Drop deploy timestamps older than 24h (callers persist the pruned list). */
export function pruneDeploys(recentDeploys: number[], now: number): number[] {
  return recentDeploys.filter((t) => now - t < DAY_MS);
}
