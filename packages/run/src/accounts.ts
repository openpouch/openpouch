import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKey, keyPrefix, parseKey, randomToken, sha256, verifySecret, verifyToken } from "./auth.js";
import { DEFAULT_ACCOUNT_TIER, pruneDeploys } from "./quota.js";

/**
 * Account / API-key registry (B3 / SSOT D16).
 *
 * Box-server truth, owned by the single run-d process — persisted as one JSON
 * file written atomically (temp + rename), the same local-first pattern as the
 * deployment Store. Zero native deps (node:crypto only); SQLite is a planned
 * hardening step if volume ever needs it.
 *
 * Account anchor = email OR GitHub (D16: the human picks). The agent's
 * credential is an API key minted on the account; only `sha256(secret)` is
 * stored. Live/dynamic deployment counts are NOT duplicated here — they are
 * derived from the deployment Store at quota-check time (single source of
 * truth). This store tracks only the rate-window deploy timestamps + the
 * account/identity/key records.
 */

export type AccountStatus = "pending" | "active" | "suspended";
export type IdentityKind = "email" | "github";

export interface Identity {
  kind: IdentityKind;
  /** Canonical key: a lowercased email, or "github:<numericId>". */
  value: string;
  /** Human label (e.g. the GitHub login), never used for matching. */
  label?: string;
}

export interface ApiKeyRecord {
  keyId: string;
  accountId: string;
  /** SHA-256 hex of the secret half — never the raw secret. */
  hashedSecret: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  label?: string;
}

/** A deployment waiting to be tied to this account once the human confirms (claim-page account path, D25). */
export interface PendingClaim {
  deploymentId: string;
  /** The deployment's single-use claim token, revalidated at bind time. */
  claimToken: string;
}

export interface AccountRecord {
  id: string;
  status: AccountStatus;
  /** Tier name, resolved against the server's TierTable. */
  tier: string;
  identities: Identity[];
  createdAt: string;
  /** Email path: the address awaiting verification (pending accounts only). */
  pendingEmail?: string;
  hashedVerifyToken?: string;
  verifyExpiresAt?: string;
  /** Claim-page signup: bind this deployment when the email verifies. */
  pendingClaim?: PendingClaim;
  /** Claim-page path for an EXISTING account: one-time mail-confirmed bind. */
  pendingBind?: { claim: PendingClaim; hashedToken: string; expiresAt: string };
  /** B4 billing state (MoR-side references only — NEVER card data). */
  billing?: BillingState;
  /** Recent deploy starts (ms), pruned to the rolling 24h window. */
  deployTimestamps: number[];
}

/** MoR subscription references. The MoR owns payment data; we keep pointers + state. */
export interface BillingState {
  provider: string;
  customerId?: string;
  subscriptionId?: string;
  /** Purchased tier name (matches the TierTable). */
  plan?: string;
  status: "active" | "past_due" | "cancelled";
  renewsAt?: string;
  founderPricing?: boolean;
  /** occurred_at of the last APPLIED webhook event — guards out-of-order delivery. */
  lastEventAt?: string;
}

/** Public, secret-free view of a key (for `GET /api/keys`). */
export interface ApiKeyView {
  keyId: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  label?: string;
}

/** Public view of an account (for `GET /api/account`) — no tokens, no hashes. */
export interface AccountView {
  id: string;
  status: AccountStatus;
  tier: string;
  identities: Identity[];
  createdAt: string;
}

export const DEFAULT_VERIFY_TTL_MS = 24 * 3_600_000;

function plausibleEmail(email: string): boolean {
  // Deliberately permissive — we only reject obvious garbage; the real proof is
  // the verification round-trip. No human check beyond owning the inbox (R8).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

function githubIdentityValue(githubId: string | number): string {
  return `github:${githubId}`;
}

function accountId(): string {
  return `acct_${randomBytes(8).toString("hex")}`;
}

export interface AccountStoreOptions {
  dataDir: string;
  verifyTtlMs?: number;
}

type CreateEmailResult =
  | { ok: true; account: AccountRecord; token: string }
  | { ok: false; reason: "invalid-email" | "exists" };

type VerifyResult =
  | { ok: true; account: AccountRecord; key: string; claim?: PendingClaim }
  | { ok: false; reason: "not-found" | "bad-token" | "expired" | "already-active" };

type BindRequestResult =
  | { ok: true; account: AccountRecord; token: string }
  | { ok: false; reason: "not-found" };

type BindConfirmResult =
  | { ok: true; account: AccountRecord; claim: PendingClaim }
  | { ok: false; reason: "not-found" | "bad-token" | "expired" };

export const DEFAULT_BIND_TTL_MS = 24 * 3_600_000;

type MintResult =
  | { ok: true; key: string; keyId: string }
  | { ok: false; reason: "not-found" | "not-active" };

type ResolveResult = { account: AccountRecord; keyId: string } | null;

export class AccountStore {
  readonly dataDir: string;
  private readonly registryPath: string;
  private readonly verifyTtlMs: number;
  private accounts = new Map<string, AccountRecord>();
  private keys = new Map<string, ApiKeyRecord>();
  /** identity.value → accountId, rebuilt on load. */
  private identityIndex = new Map<string, string>();

  constructor(opts: AccountStoreOptions) {
    this.dataDir = opts.dataDir;
    this.registryPath = join(opts.dataDir, "accounts.json");
    this.verifyTtlMs = opts.verifyTtlMs ?? DEFAULT_VERIFY_TTL_MS;
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as { accounts?: AccountRecord[]; keys?: ApiKeyRecord[] };
      for (const a of parsed.accounts ?? []) {
        this.accounts.set(a.id, { ...a, deployTimestamps: a.deployTimestamps ?? [] });
        for (const idn of a.identities) this.identityIndex.set(idn.value, a.id);
      }
      for (const k of parsed.keys ?? []) this.keys.set(k.keyId, k);
    } catch {
      // no registry yet — start empty
    }
  }

  private async save(): Promise<void> {
    const payload = { version: 0, accounts: [...this.accounts.values()], keys: [...this.keys.values()] };
    const tmp = `${this.registryPath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, this.registryPath);
  }

  /** Persist any in-memory-only changes (e.g. lastUsedAt touched on the read path). */
  async flush(): Promise<void> {
    await this.save();
  }

  getAccount(id: string): AccountRecord | undefined {
    return this.accounts.get(id);
  }

  findByEmail(email: string): AccountRecord | undefined {
    const id = this.identityIndex.get(canonicalEmail(email));
    return id ? this.accounts.get(id) : undefined;
  }

  findByGithub(githubId: string | number): AccountRecord | undefined {
    const id = this.identityIndex.get(githubIdentityValue(githubId));
    return id ? this.accounts.get(id) : undefined;
  }

  /** The still-pending (unverified) account awaiting verification for `canonical`, if any.
   *  Pending emails aren't in identityIndex (only verified/linked ones are), so this scans. */
  private findPendingByEmail(canonical: string): AccountRecord | undefined {
    for (const a of this.accounts.values()) {
      if (a.status === "pending" && a.pendingEmail === canonical) return a;
    }
    return undefined;
  }

  /**
   * Start an email signup: create a pending account + a verification token
   * (returned raw exactly once; only its hash is stored). Refuses if an account
   * already owns that email. The actual email send is the caller's job (Mailer).
   */
  async createPendingEmail(email: string, now: number, claim?: PendingClaim): Promise<CreateEmailResult> {
    const canonical = canonicalEmail(email);
    if (!plausibleEmail(canonical)) return { ok: false, reason: "invalid-email" };
    if (this.identityIndex.has(canonical)) return { ok: false, reason: "exists" };

    const token = randomToken();
    // Re-signup for an email that is still PENDING (never verified) refreshes the
    // existing pending account in place — a fresh token + expiry — rather than
    // piling up duplicate pending accounts, and doubles as "resend the link".
    // (A verified/linked email is caught above → `exists`.)
    const pending = this.findPendingByEmail(canonical);
    if (pending) {
      pending.hashedVerifyToken = sha256(token);
      pending.verifyExpiresAt = new Date(now + this.verifyTtlMs).toISOString();
      if (claim) pending.pendingClaim = claim;
      await this.save();
      return { ok: true, account: pending, token };
    }

    const account: AccountRecord = {
      id: accountId(),
      status: "pending",
      tier: DEFAULT_ACCOUNT_TIER,
      identities: [],
      createdAt: new Date(now).toISOString(),
      pendingEmail: canonical,
      hashedVerifyToken: sha256(token),
      verifyExpiresAt: new Date(now + this.verifyTtlMs).toISOString(),
      ...(claim ? { pendingClaim: claim } : {}),
      deployTimestamps: [],
    };
    this.accounts.set(account.id, account);
    await this.save();
    return { ok: true, account, token };
  }

  /**
   * Complete an email signup: validate the token, activate the account, register
   * the email identity, and mint the first API key (returned raw once).
   */
  async verifyEmail(id: string, token: string, now: number): Promise<VerifyResult> {
    const account = this.accounts.get(id);
    if (!account) return { ok: false, reason: "not-found" };
    if (account.status === "active") return { ok: false, reason: "already-active" };
    if (!account.hashedVerifyToken || !account.pendingEmail) return { ok: false, reason: "not-found" };
    if (account.verifyExpiresAt && Date.parse(account.verifyExpiresAt) <= now) return { ok: false, reason: "expired" };
    if (!verifyToken(token, account.hashedVerifyToken)) return { ok: false, reason: "bad-token" };

    const email = account.pendingEmail;
    account.status = "active";
    account.identities.push({ kind: "email", value: email });
    this.identityIndex.set(email, account.id);
    delete account.pendingEmail;
    delete account.hashedVerifyToken;
    delete account.verifyExpiresAt;
    // Claim-page signup: hand the deferred claim to the caller exactly once —
    // the server ties the deployment to the account (revalidating its token).
    const claim = account.pendingClaim;
    if (claim) delete account.pendingClaim;

    const key = this.addKey(account.id, "default", now);
    await this.save();
    return { ok: true, account, key: key.full, ...(claim ? { claim } : {}) };
  }

  /**
   * Claim-page path for an email that already owns an ACTIVE account: stage a
   * one-time, 24h bind request (returns the raw token exactly once; only its
   * hash is stored). The caller mails the confirm link to the account's email —
   * possession of the inbox authorizes the bind, mirroring signup verification.
   */
  async createBindRequest(email: string, claim: PendingClaim, now: number): Promise<BindRequestResult> {
    const account = this.findByEmail(email);
    if (!account || account.status !== "active") return { ok: false, reason: "not-found" };
    const token = randomToken();
    account.pendingBind = {
      claim,
      hashedToken: sha256(token),
      expiresAt: new Date(now + DEFAULT_BIND_TTL_MS).toISOString(),
    };
    await this.save();
    return { ok: true, account, token };
  }

  /** Complete a mail-confirmed bind: validate + consume the one-time token. */
  async confirmBind(id: string, token: string, now: number): Promise<BindConfirmResult> {
    const account = this.accounts.get(id);
    if (!account || account.status !== "active" || !account.pendingBind) return { ok: false, reason: "not-found" };
    const pending = account.pendingBind;
    if (Date.parse(pending.expiresAt) <= now) return { ok: false, reason: "expired" };
    if (!verifyToken(token, pending.hashedToken)) return { ok: false, reason: "bad-token" };
    delete account.pendingBind;
    await this.save();
    return { ok: true, account, claim: pending.claim };
  }

  /**
   * GitHub path: find the account for this GitHub identity (creating an active
   * one on first sign-in), then mint a fresh API key (returned raw once).
   */
  async linkOrCreateGithub(githubId: string | number, login: string, now: number): Promise<{ account: AccountRecord; key: string }> {
    const value = githubIdentityValue(githubId);
    let account = this.identityIndex.get(value) ? this.accounts.get(this.identityIndex.get(value)!) : undefined;
    if (!account) {
      account = {
        id: accountId(),
        status: "active",
        tier: DEFAULT_ACCOUNT_TIER,
        identities: [{ kind: "github", value, label: login }],
        createdAt: new Date(now).toISOString(),
        deployTimestamps: [],
      };
      this.accounts.set(account.id, account);
      this.identityIndex.set(value, account.id);
    }
    const key = this.addKey(account.id, "github", now);
    await this.save();
    return { account, key: key.full };
  }

  /** Create a key record in memory (no save). Returns the full key (show once). */
  private addKey(acctId: string, label: string | undefined, now: number): { full: string; keyId: string } {
    const g = generateKey();
    const record: ApiKeyRecord = {
      keyId: g.keyId,
      accountId: acctId,
      hashedSecret: g.hashedSecret,
      createdAt: new Date(now).toISOString(),
      revoked: false,
      ...(label ? { label } : {}),
    };
    this.keys.set(record.keyId, record);
    return { full: g.full, keyId: g.keyId };
  }

  /** Mint an additional key for an active account (returned raw once). */
  async mintKey(acctId: string, label: string | undefined, now: number): Promise<MintResult> {
    const account = this.accounts.get(acctId);
    if (!account) return { ok: false, reason: "not-found" };
    if (account.status !== "active") return { ok: false, reason: "not-active" };
    const key = this.addKey(acctId, label, now);
    await this.save();
    return { ok: true, key: key.full, keyId: key.keyId };
  }

  listKeys(acctId: string): ApiKeyView[] {
    return [...this.keys.values()]
      .filter((k) => k.accountId === acctId)
      .map((k) => ({
        keyId: k.keyId,
        prefix: keyPrefix(k.keyId),
        createdAt: k.createdAt,
        revoked: k.revoked,
        ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
        ...(k.label ? { label: k.label } : {}),
      }));
  }

  async revokeKey(acctId: string, keyId: string): Promise<{ ok: boolean }> {
    const k = this.keys.get(keyId);
    if (!k || k.accountId !== acctId) return { ok: false };
    if (!k.revoked) {
      k.revoked = true;
      await this.save();
    }
    return { ok: true };
  }

  /**
   * Authenticate a presented key. Parses it, looks up the record by its public
   * id, verifies the secret in constant time, and rejects revoked keys,
   * unknown/suspended accounts. On success, `lastUsedAt` is updated in memory
   * (persisted lazily by the next save — best-effort telemetry, no read-path
   * write amplification). Returns null for any failure (caller → 401).
   */
  resolveKey(presentedFull: string | undefined | null, now: number): ResolveResult {
    const parsed = parseKey(presentedFull ?? undefined);
    if (!parsed) return null;
    const record = this.keys.get(parsed.keyId);
    if (!record || record.revoked) return null;
    if (!verifySecret(parsed.secret, record.hashedSecret)) return null;
    const account = this.accounts.get(record.accountId);
    if (!account || account.status !== "active") return null;
    record.lastUsedAt = new Date(now).toISOString();
    return { account, keyId: record.keyId };
  }

  /** Record a deploy start for rate-window accounting + persist. */
  async recordDeploy(acctId: string, now: number): Promise<void> {
    const account = this.accounts.get(acctId);
    if (!account) return;
    account.deployTimestamps = pruneDeploys([...account.deployTimestamps, now], now);
    await this.save();
  }

  /** The account's pruned deploy timestamps (for checkQuota). */
  usageWindows(acctId: string, now: number): number[] {
    const account = this.accounts.get(acctId);
    if (!account) return [];
    return pruneDeploys(account.deployTimestamps, now);
  }

  async setTier(acctId: string, tier: string): Promise<{ ok: boolean }> {
    const account = this.accounts.get(acctId);
    if (!account) return { ok: false };
    account.tier = tier;
    await this.save();
    return { ok: true };
  }

  /** Update tier + billing references atomically (webhook path). */
  async applyBilling(acctId: string, tier: string | undefined, billing: BillingState): Promise<{ ok: boolean }> {
    const account = this.accounts.get(acctId);
    if (!account) return { ok: false };
    if (tier !== undefined) account.tier = tier;
    account.billing = billing;
    await this.save();
    return { ok: true };
  }

  async setStatus(acctId: string, status: AccountStatus): Promise<{ ok: boolean }> {
    const account = this.accounts.get(acctId);
    if (!account) return { ok: false };
    account.status = status;
    await this.save();
    return { ok: true };
  }

  view(account: AccountRecord): AccountView {
    return {
      id: account.id,
      status: account.status,
      tier: account.tier,
      identities: account.identities,
      createdAt: account.createdAt,
    };
  }
}
