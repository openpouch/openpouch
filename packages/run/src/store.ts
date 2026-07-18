import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constantTimeEqual } from "./auth.js";

/**
 * Instant-lane deployment registry + on-disk site management.
 *
 * Local-first by analogy: a single run-d process owns one data directory.
 * The registry is a JSON file written atomically (temp + rename); the process
 * is single-threaded so writes are serialized without a lock. SQLite is a
 * planned hardening step (see docs) — JSON keeps M1 free of native deps,
 * matching the repo's zero-native-dependency rule.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** Unclaimed previews vanish after 72h (D11 cost control). */
export const DEFAULT_TTL_MS = 72 * HOUR_MS;
/** A claimed preview gets a 7-day life in M1 (accounts/renewal: phase 1.5). */
export const CLAIMED_TTL_MS = 7 * DAY_MS;
/**
 * Usage-based persistence (D25, staged for 0.3.0): an ACCOUNT-OWNED deployment
 * never expires by calendar time — it expires only after this long without a
 * single inbound request. Anonymous (72h) and token-claimed (7d) records keep
 * their fixed TTLs.
 */
export const DEFAULT_INACTIVITY_MS = 90 * DAY_MS;
/** Warning mail lead time: warn when remaining inactivity budget drops below this. */
export const DEFAULT_INACTIVITY_WARN_LEAD_MS = 7 * DAY_MS;
/** Activity writes are damped: persist lastRequestAt at most once per hour per slug. */
export const ACTIVITY_PERSIST_INTERVAL_MS = HOUR_MS;

export interface DeployEvent {
  timestamp: string;
  message: string;
}

/** static = M1 files served by the edge; dynamic = M2 Node app in a container. */
export type DeploymentKind = "static" | "dynamic";
/** Container lifecycle state for a dynamic deployment. */
export type RuntimeStatus = "building" | "running" | "stopped" | "failed";

export interface DeploymentRecord {
  /** Public handle == subdomain slug. Maps to ProviderAdapter DeploySummary.id. */
  id: string;
  slug: string;
  status: "live" | "expired";
  createdAt: string;
  expiresAt: string;
  claimed: boolean;
  /** Capability token embedded in the claim URL (single-use to claim). */
  claimToken: string;
  /** Issued on claim; authorizes delete/extend. Absent until claimed. */
  mgmtToken?: string;
  bytes: number;
  fileCount: number;
  events: DeployEvent[];
  /** static (M1) or dynamic (M2 container). Absent in pre-M2 records → static. */
  kind: DeploymentKind;
  /**
   * Account that owns this deployment (B3). Absent → anonymous (keyless) deploy.
   * Used to derive per-account live/dynamic counts for quotas + `GET /api/account`.
   */
  accountId?: string;
  /** Dynamic only: container lifecycle state. */
  runtimeStatus?: RuntimeStatus;
  /** Dynamic only: docker container id (for start/stop/remove/inspect). */
  containerId?: string;
  /** Dynamic only: host port the container publishes on 127.0.0.1. */
  hostPort?: number;
  /** Dynamic only: shell command used to start the app (to recreate on reconcile). */
  startCmd?: string;
  /**
   * Last observed inbound request to the app (ISO). Only tracked/meaningful for
   * account-owned records (usage-based persistence, D25). Absent → treat
   * createdAt as the activity floor; a measurement gap must never delete.
   */
  lastRequestAt?: string;
  /** Set when the inactivity warning mail went out; cleared by new activity. */
  inactivityWarnedAt?: string;
  /** L10 (staged 0.3.0): the app mounts the account's persistent /data volume for this project key. */
  volumeProject?: string;
  /** Staged 0.3.0: never idle-stopped (paid tiers, capped by maxAlwaysOn). */
  alwaysOn?: boolean;
  /**
   * L12: named-app identity (account+app). A redeploy of the same identity
   * UPDATES this record behind its stable slug/URL instead of minting a fresh
   * one. Owned-only — anonymous deploys have no provable ownership to overwrite.
   */
  app?: string;
  /**
   * L12: this record is the short-lived internal vehicle of an app update —
   * the new content is built/health-checked on it while the live app keeps
   * serving, then swapped. Never listed, never quota-counted; removed after
   * the swap (or by the sweep if an update crashed mid-way).
   */
  shadowFor?: string;
}

export interface StoreOptions {
  dataDir: string;
  ttlMs?: number;
  claimedTtlMs?: number;
  /** Inactivity window for account-owned records (usage-based persistence). */
  inactivityMs?: number;
  /** Warn this long before the inactivity window closes. */
  inactivityWarnLeadMs?: number;
}

/** Result of one sweep tick: what was removed, and who needs a warning mail. */
export interface SweepResult {
  removed: DeploymentRecord[];
  /** Account-owned records that just crossed the warning threshold this tick. */
  warned: DeploymentRecord[];
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSlugSuffix(len = 6): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  return out;
}

/** Lowercase, keep [a-z0-9-], collapse repeats, trim to a DNS-label-safe hint. */
export function sanitizeHint(hint: string | undefined): string {
  if (!hint) return "joey";
  const cleaned = hint
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return cleaned.length > 0 ? cleaned : "joey";
}

export function tokenString(): string {
  return randomBytes(24).toString("base64url");
}

export class Store {
  readonly dataDir: string;
  readonly sitesDir: string;
  private readonly registryPath: string;
  private readonly ttlMs: number;
  private readonly claimedTtlMs: number;
  private readonly inactivityMs: number;
  private readonly inactivityWarnLeadMs: number;
  private records = new Map<string, DeploymentRecord>();
  /** Per-slug ms timestamp of the last PERSISTED activity write (damping). */
  private activityPersistedAt = new Map<string, number>();
  /** Serializes save(): concurrent persists share one temp path, so an
   *  unchained pair races on it and the losing rename throws ENOENT. */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.sitesDir = join(opts.dataDir, "sites");
    this.registryPath = join(opts.dataDir, "registry.json");
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.claimedTtlMs = opts.claimedTtlMs ?? CLAIMED_TTL_MS;
    this.inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    this.inactivityWarnLeadMs = opts.inactivityWarnLeadMs ?? DEFAULT_INACTIVITY_WARN_LEAD_MS;
  }

  /**
   * Load the registry. `now`, when given, runs the one-time usage-based
   * persistence migration: every live account-owned record that predates the
   * feature (no `lastRequestAt`) starts its activity clock AT THE ROLLOUT
   * MOMENT — nobody loses an app because measuring began late (fail-safe,
   * design §3.5). Idempotent: the field exists afterwards.
   */
  async init(now?: number): Promise<void> {
    await mkdir(this.sitesDir, { recursive: true });
    try {
      const raw = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as { deployments?: DeploymentRecord[] };
      for (const r of parsed.deployments ?? []) {
        // Back-compat: pre-M2 records have no `kind` → they are static.
        this.records.set(r.id, { ...r, kind: r.kind ?? "static" });
      }
    } catch {
      // no registry yet — start empty
    }
    if (now !== undefined) {
      let migrated = false;
      for (const r of this.records.values()) {
        if (r.accountId !== undefined && r.status === "live" && r.lastRequestAt === undefined) {
          r.lastRequestAt = new Date(now).toISOString();
          r.expiresAt = new Date(now + this.inactivityMs).toISOString();
          migrated = true;
        }
      }
      if (migrated) await this.save();
    }
  }

  private save(): Promise<void> {
    // Chained, not parallel: touchActivity persists fire-and-forget on the
    // request hot path while e.g. the scale-to-zero wake persists update() in
    // the same tick. Each turn serializes the records as of ITS moment, so the
    // file is always a full, current snapshot; a failed save must not wedge
    // the chain for later writers.
    const run = this.saveChain.then(async () => {
      const payload = { version: 0, deployments: [...this.records.values()] };
      const tmp = `${this.registryPath}.tmp`;
      await writeFile(tmp, JSON.stringify(payload), "utf8");
      await rename(tmp, this.registryPath);
    });
    this.saveChain = run.catch(() => {});
    return run;
  }

  siteDir(slug: string): string {
    return join(this.sitesDir, slug);
  }

  private freshSlug(hint: string | undefined): string {
    const base = sanitizeHint(hint);
    for (let i = 0; i < 50; i++) {
      const slug = `${base}-${randomSlugSuffix()}`;
      if (!this.records.has(slug)) return slug;
    }
    // astronomically unlikely; widen the suffix
    return `${base}-${randomSlugSuffix(12)}`;
  }

  /** Reserve a slug + record. The caller extracts files into siteDir(slug) first. */
  async create(input: { hint?: string; bytes: number; fileCount: number; now: number; kind?: DeploymentKind; accountId?: string; volumeProject?: string; alwaysOn?: boolean; app?: string; shadowFor?: string }): Promise<DeploymentRecord> {
    const slug = this.freshSlug(input.hint);
    const createdAt = new Date(input.now).toISOString();
    const kind: DeploymentKind = input.kind ?? "static";
    const record: DeploymentRecord = {
      id: slug,
      slug,
      status: "live",
      createdAt,
      // Account-owned deploys live on the rolling inactivity window from second
      // zero — the deploy response is the surface agents trust, so it must not
      // show the anonymous 72h TTL and heal only on the first request
      // (Codex field test F-01, 2026-07-12). touchActivity keeps rolling it.
      expiresAt: new Date(input.now + (input.accountId !== undefined ? this.inactivityMs : this.ttlMs)).toISOString(),
      claimed: false,
      claimToken: tokenString(),
      bytes: input.bytes,
      fileCount: input.fileCount,
      kind,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.volumeProject ? { volumeProject: input.volumeProject } : {}),
      ...(input.alwaysOn ? { alwaysOn: true } : {}),
      ...(input.app ? { app: input.app } : {}),
      ...(input.shadowFor ? { shadowFor: input.shadowFor } : {}),
      events: [
        { timestamp: createdAt, message: `deployment created (${input.fileCount} files, ${input.bytes} bytes, ${kind})` },
        // "status: live" is appended by the server only AFTER build/start
        // succeed — logging it at create time told agents a not-yet-built app
        // was reachable (Codex OP-002, 2026-07-13).
        { timestamp: createdAt, message: "status: accepted" },
      ],
    };
    this.records.set(slug, record);
    await this.save();
    return record;
  }

  /** Merge a patch into a record and persist. Used by the orchestrator to record container state. */
  async update(id: string, patch: Partial<Omit<DeploymentRecord, "id" | "slug">>): Promise<DeploymentRecord | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    Object.assign(record, patch);
    await this.save();
    return record;
  }

  /**
   * Next strictly-increasing event timestamp (ms) for a record: at least `now`,
   * but always at least 1ms past the record's most recent event. A deploy records
   * all its lifecycle events and captured install/build/app output with the same
   * deploy `now`, which made every `openpouch logs` line share one timestamp
   * (useless for ordering/debugging — Hermes 2026-07-02). Monotonic offsets (not
   * fabricated wall-clock) keep the lines sortable in the order they were captured.
   */
  private nextEventMs(record: DeploymentRecord, now: number): number {
    const events = record.events;
    const last = events.length > 0 ? Date.parse(events[events.length - 1]!.timestamp) : Number.NaN;
    return Number.isFinite(last) && last >= now ? last + 1 : now;
  }

  /** Append a lifecycle event to a record and persist. */
  async appendEvent(id: string, message: string, now: number): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.events.push({ timestamp: new Date(this.nextEventMs(record, now)).toISOString(), message });
    await this.save();
  }

  /** Append many events at once and persist once — used to record captured
   *  install/app stdout+stderr without a disk write per line. Each line gets a
   *  distinct, strictly-increasing timestamp so the log stays ordered. */
  async appendEvents(id: string, messages: string[], now: number): Promise<void> {
    if (messages.length === 0) return;
    const record = this.records.get(id);
    if (!record) return;
    let ms = this.nextEventMs(record, now);
    for (const message of messages) {
      record.events.push({ timestamp: new Date(ms).toISOString(), message });
      ms++;
    }
    await this.save();
  }

  get(id: string): DeploymentRecord | undefined {
    return this.records.get(id);
  }

  list(): DeploymentRecord[] {
    return [...this.records.values()];
  }

  /** Live + dynamic counts owned by an account (for per-account quotas, B3). */
  countOwned(accountId: string): { live: number; dynamic: number } {
    let live = 0;
    let dynamic = 0;
    for (const r of this.records.values()) {
      if (r.accountId !== accountId || r.status !== "live" || r.shadowFor !== undefined) continue;
      live++;
      if (r.kind === "dynamic") dynamic++;
    }
    return { live, dynamic };
  }

  /** L12: the live named-app record for account+app, if any (update-shadow records never match). */
  findApp(accountId: string, app: string): DeploymentRecord | undefined {
    for (const r of this.records.values()) {
      if (r.accountId === accountId && r.app === app && r.status === "live" && r.shadowFor === undefined) return r;
    }
    return undefined;
  }

  /**
   * Live deployments owned by an account — the data behind `openpouch list`
   * (B3 self-service). Live-only, mirroring countOwned: quota is about live
   * slots, and expired records are swept within minutes. An account only ever
   * sees its own records — a deployment with a different (or absent) accountId
   * is never returned, so there is no cross-account enumeration.
   */
  listOwned(accountId: string): DeploymentRecord[] {
    const out: DeploymentRecord[] = [];
    for (const r of this.records.values()) {
      // Update shadows are internal vehicles, not the account's apps (L12).
      if (r.accountId === accountId && r.status === "live" && r.shadowFor === undefined) out.push(r);
    }
    return out;
  }

  /** Claim with the single-use claim token → extend to the claimed TTL, issue a mgmt token. */
  async claim(id: string, token: string, now: number): Promise<{ ok: true; record: DeploymentRecord } | { ok: false; reason: "not-found" | "bad-token" | "already-claimed" }> {
    const record = this.records.get(id);
    if (!record) return { ok: false, reason: "not-found" };
    if (record.claimed) return { ok: false, reason: "already-claimed" };
    if (!constantTimeEqual(token, record.claimToken)) return { ok: false, reason: "bad-token" };
    record.claimed = true;
    record.mgmtToken = tokenString();
    record.expiresAt = new Date(now + this.claimedTtlMs).toISOString();
    record.events.push({ timestamp: new Date(now).toISOString(), message: "claimed — extended to 7 days" });
    await this.save();
    return { ok: true, record };
  }

  /**
   * Delete a deployment (its files + record). Authorisation, in order:
   *   - `force` → operator/admin takedown (abuse handling), no check.
   *   - `accountId` → account-key path (B3 self-service `openpouch delete`):
   *     ONLY the owning account may delete (`record.accountId === accountId`),
   *     else `not-owner`. This branch is exclusive — it never falls through to
   *     the token path, so a key can never delete a record it doesn't own
   *     (including an unclaimed or anonymous one, whose accountId can't match).
   *   - else the claim/mgmt-token path: a claimed record needs its mgmt token.
   */
  async remove(
    id: string,
    opts?: { mgmtToken?: string; force?: boolean; accountId?: string },
  ): Promise<{ ok: true; record: DeploymentRecord } | { ok: false; reason: "not-found" | "bad-token" | "not-owner" }> {
    const record = this.records.get(id);
    if (!record) return { ok: false, reason: "not-found" };
    if (!opts?.force) {
      if (opts?.accountId !== undefined) {
        // Account-key path: owner-only, exclusive (never the token path below).
        if (record.accountId !== opts.accountId) return { ok: false, reason: "not-owner" };
      } else {
        // Token/anonymous path: a record that is claimed OR owned by an account
        // needs a valid mgmt token. Only a truly unowned anonymous preview (no
        // account, not claimed) stays tokenlessly removable (M1 behaviour). This
        // closes the edge where a stranger could tokenlessly delete someone's
        // still-unclaimed keyed app — that app's owner deletes it with their key.
        const needsToken = record.claimed || record.accountId !== undefined;
        if (
          needsToken &&
          (record.mgmtToken === undefined || opts?.mgmtToken === undefined || !constantTimeEqual(opts.mgmtToken, record.mgmtToken))
        ) {
          return { ok: false, reason: "bad-token" };
        }
      }
    }
    await rm(this.siteDir(record.slug), { recursive: true, force: true });
    this.records.delete(id);
    await this.save();
    return { ok: true, record };
  }

  /**
   * Record an inbound request to a deployment (usage-based persistence, D25).
   * In-memory state is always updated (lastRequestAt, rolling expiresAt for
   * account-owned records, healing a pending inactivity warning); the registry
   * write is damped to at most one per slug per ACTIVITY_PERSIST_INTERVAL_MS —
   * hour granularity is plenty against a 90-day window, and it keeps the
   * request hot path from hammering the JSON registry.
   */
  async touchActivity(id: string, now: number): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.status !== "live") return;
    record.lastRequestAt = new Date(now).toISOString();
    if (record.accountId !== undefined) {
      record.expiresAt = new Date(now + this.inactivityMs).toISOString();
      if (record.inactivityWarnedAt !== undefined) delete record.inactivityWarnedAt;
    }
    const persisted = this.activityPersistedAt.get(id);
    if (persisted !== undefined && now - persisted < ACTIVITY_PERSIST_INTERVAL_MS) return;
    this.activityPersistedAt.set(id, now);
    await this.save();
  }

  /**
   * Tie a deployment to an account (claim-page account path / bind-confirm).
   * The record joins the usage-based persistence class: its activity clock
   * starts now, a mgmt token is issued if missing, and the single-use claim
   * token is spent (claimed=true) so the anonymous claim path can't re-run.
   * Owner-safety: a record already owned by a DIFFERENT account is refused.
   */
  async bindToAccount(id: string, accountId: string, now: number): Promise<{ ok: true; record: DeploymentRecord } | { ok: false; reason: "not-found" | "other-account" }> {
    const record = this.records.get(id);
    if (!record || record.status !== "live") return { ok: false, reason: "not-found" };
    if (record.accountId !== undefined && record.accountId !== accountId) return { ok: false, reason: "other-account" };
    record.accountId = accountId;
    record.claimed = true;
    if (!record.mgmtToken) record.mgmtToken = tokenString();
    record.lastRequestAt = new Date(now).toISOString();
    record.expiresAt = new Date(now + this.inactivityMs).toISOString();
    if (record.inactivityWarnedAt !== undefined) delete record.inactivityWarnedAt;
    record.events.push({ timestamp: new Date(this.nextEventMs(record, now)).toISOString(), message: "tied to account — stays live while it's used" });
    await this.save();
    return { ok: true, record };
  }

  /** The activity floor for the inactivity rule. A parse failure returns NaN → caller must fail safe (never delete). */
  private lastActivityMs(record: DeploymentRecord): number {
    const stamps = [record.lastRequestAt, record.createdAt].filter((s): s is string => s !== undefined);
    let max = Number.NaN;
    for (const s of stamps) {
      const t = Date.parse(s);
      if (Number.isFinite(t) && !(t <= max)) max = t;
    }
    return max;
  }

  /**
   * One reaper tick. Two record classes (design §3.3/§3.4):
   *   - anonymous / token-claimed (no accountId): fixed TTL — `expiresAt <= now` removes, as ever.
   *   - account-owned: usage-based — remove only after `inactivityMs` without a
   *     single request; cross the warn threshold once → returned in `warned`
   *     (the server sends the mail; the store stays mail-free). A record whose
   *     timestamps don't parse is NEVER removed (measurement bugs must not
   *     delete, §3.5); its rolling `expiresAt` is kept in step as a side effect.
   */
  async sweep(now: number): Promise<SweepResult> {
    const removed: DeploymentRecord[] = [];
    const warned: DeploymentRecord[] = [];
    let dirty = false;
    for (const record of [...this.records.values()]) {
      if (record.accountId === undefined) {
        if (Date.parse(record.expiresAt) <= now) {
          await rm(this.siteDir(record.slug), { recursive: true, force: true });
          this.records.delete(record.id);
          removed.push(record);
        }
        continue;
      }
      const last = this.lastActivityMs(record);
      if (!Number.isFinite(last)) continue; // fail safe: unmeasurable → never delete
      const idle = now - last;
      if (idle >= this.inactivityMs) {
        await rm(this.siteDir(record.slug), { recursive: true, force: true });
        this.records.delete(record.id);
        removed.push(record);
        continue;
      }
      // Keep the public expiry honest (rolling), even if activity flushes were damped.
      const rolling = new Date(last + this.inactivityMs).toISOString();
      if (record.expiresAt !== rolling) {
        record.expiresAt = rolling;
        dirty = true;
      }
      if (idle >= this.inactivityMs - this.inactivityWarnLeadMs && record.inactivityWarnedAt === undefined) {
        record.inactivityWarnedAt = new Date(now).toISOString();
        record.events.push({ timestamp: new Date(this.nextEventMs(record, now)).toISOString(), message: "inactivity warning sent — a single visit keeps it live" });
        warned.push(record);
        dirty = true;
      }
    }
    if (removed.length > 0 || dirty) await this.save();
    return { removed, warned };
  }

  /** Convenience wrapper kept for existing callers/tests: sweep and return only the removals. */
  async sweepExpired(now: number): Promise<DeploymentRecord[]> {
    return (await this.sweep(now)).removed;
  }
}
