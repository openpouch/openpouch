import { spawn } from "node:child_process";
import { appendFile, mkdtemp, rename, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts.js";
import { AccessLogActivity } from "../src/activity.js";
import type { BindConfirmMail, InactivityWarningMail, Mailer, VerificationMail } from "../src/mailer.js";
import { configFromEnv, createRunServer, type RunConfig, type RunServerDeps } from "../src/server.js";
import { DAY_MS, HOUR_MS, Store } from "../src/store.js";

/**
 * D25 usage-based persistence (staged for 0.3.0): activity tracking, the
 * classified sweep with its T-7 warning, the claim-page account paths, and the
 * fail-safe rules ("a measurement gap must never delete").
 */

const T0 = Date.parse("2026-07-11T00:00:00.000Z");

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

class CapturingMailer implements Mailer {
  sent: VerificationMail[] = [];
  warnings: InactivityWarningMail[] = [];
  binds: BindConfirmMail[] = [];
  async sendVerification(mail: VerificationMail): Promise<void> {
    this.sent.push(mail);
  }
  async sendInactivityWarning(mail: InactivityWarningMail): Promise<void> {
    this.warnings.push(mail);
  }
  async sendBindConfirm(mail: BindConfirmMail): Promise<void> {
    this.binds.push(mail);
  }
}

async function makeStore(overrides: Partial<ConstructorParameters<typeof Store>[0]> = {}): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "oprun-persist-"));
  const store = new Store({ dataDir: dir, ...overrides });
  await store.init();
  return store;
}

describe("store: activity tracking (touchActivity)", () => {
  it("stamps lastRequestAt and rolls expiresAt forward for an account-owned record", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    await store.touchActivity(rec.id, T0 + 5 * DAY_MS);
    const r = store.get(rec.id)!;
    expect(r.lastRequestAt).toBe(new Date(T0 + 5 * DAY_MS).toISOString());
    expect(r.expiresAt).toBe(new Date(T0 + 5 * DAY_MS + 90 * DAY_MS).toISOString());
  });

  it("heals a pending inactivity warning on new activity", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    await store.update(rec.id, { inactivityWarnedAt: new Date(T0).toISOString() });
    await store.touchActivity(rec.id, T0 + HOUR_MS);
    expect(store.get(rec.id)!.inactivityWarnedAt).toBeUndefined();
  });

  it("keeps lastRequestAt current in memory but damps registry writes to ~1/hour", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    await store.touchActivity(rec.id, T0 + 1000); // persisted (first)
    await store.touchActivity(rec.id, T0 + 2000); // damped — memory only
    // A fresh Store on the same dataDir sees only what was persisted.
    const reread = new Store({ dataDir: store.dataDir });
    await reread.init();
    expect(reread.get(rec.id)!.lastRequestAt).toBe(new Date(T0 + 1000).toISOString());
    // In-memory state is nevertheless current (the next save persists it).
    expect(store.get(rec.id)!.lastRequestAt).toBe(new Date(T0 + 2000).toISOString());
    // Past the damping interval a touch persists again.
    await store.touchActivity(rec.id, T0 + 1000 + HOUR_MS + 1);
    const reread2 = new Store({ dataDir: store.dataDir });
    await reread2.init();
    expect(reread2.get(rec.id)!.lastRequestAt).toBe(new Date(T0 + 1000 + HOUR_MS + 1).toISOString());
  });

  it("does not track anonymous records' expiry (72h stays fixed)", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0 });
    const before = store.get(rec.id)!.expiresAt;
    await store.touchActivity(rec.id, T0 + DAY_MS);
    expect(store.get(rec.id)!.expiresAt).toBe(before); // unchanged — no rolling expiry without an account
  });
});

describe("store: classified sweep (anonymous TTL vs usage-based)", () => {
  it("keeps removing anonymous and token-claimed records by fixed TTL", async () => {
    const store = await makeStore();
    const anon = await store.create({ bytes: 1, fileCount: 1, now: T0 });
    const claimed = await store.create({ bytes: 1, fileCount: 1, now: T0 });
    await store.claim(claimed.id, store.get(claimed.id)!.claimToken, T0);
    // 72h + ε: the anonymous record goes; the 7-day claim survives.
    let result = await store.sweep(T0 + 72 * HOUR_MS + 1);
    expect(result.removed.map((r) => r.id)).toEqual([anon.id]);
    // 7d + ε: the claimed one goes too.
    result = await store.sweep(T0 + 7 * DAY_MS + 1);
    expect(result.removed.map((r) => r.id)).toEqual([claimed.id]);
  });

  it("account-owned: survives its stale expiresAt while active, expires only after the inactivity window", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    // Fresh activity at day 80 — even though the record's expiresAt (creation+72h) is long past.
    await store.touchActivity(rec.id, T0 + 80 * DAY_MS);
    let result = await store.sweep(T0 + 85 * DAY_MS);
    expect(result.removed).toEqual([]);
    // The public expiry is kept honest: rolling from the last activity.
    expect(store.get(rec.id)!.expiresAt).toBe(new Date(T0 + 80 * DAY_MS + 90 * DAY_MS).toISOString());
    // 90 days after the last visit it expires.
    result = await store.sweep(T0 + 80 * DAY_MS + 90 * DAY_MS + 1);
    expect(result.removed.map((r) => r.id)).toEqual([rec.id]);
  });

  it("warns exactly once at T-7, and activity after the warning heals it", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    // Day 83 since creation (= last activity floor): inside the warn window.
    let result = await store.sweep(T0 + 83 * DAY_MS + 1);
    expect(result.warned.map((r) => r.id)).toEqual([rec.id]);
    expect(store.get(rec.id)!.inactivityWarnedAt).toBeDefined();
    // Next tick: no duplicate warning.
    result = await store.sweep(T0 + 84 * DAY_MS);
    expect(result.warned).toEqual([]);
    // A visit heals: warning flag cleared, clock restarts, nothing removed at day 90.
    await store.touchActivity(rec.id, T0 + 85 * DAY_MS);
    expect(store.get(rec.id)!.inactivityWarnedAt).toBeUndefined();
    result = await store.sweep(T0 + 91 * DAY_MS);
    expect(result.removed).toEqual([]);
  });

  it("fail-safe: unparseable timestamps never delete", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    await store.update(rec.id, { lastRequestAt: "not-a-date", createdAt: "also-garbage" } as never);
    const result = await store.sweep(T0 + 400 * DAY_MS);
    expect(result.removed).toEqual([]);
    expect(store.get(rec.id)).toBeDefined();
  });

  it("honours custom inactivity windows (operator knob)", async () => {
    const store = await makeStore({ inactivityMs: 10 * DAY_MS, inactivityWarnLeadMs: 2 * DAY_MS });
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    let result = await store.sweep(T0 + 8 * DAY_MS + 1);
    expect(result.warned.map((r) => r.id)).toEqual([rec.id]);
    result = await store.sweep(T0 + 10 * DAY_MS + 1);
    expect(result.removed.map((r) => r.id)).toEqual([rec.id]);
  });
});

describe("store: bindToAccount + rollout migration", () => {
  it("binds a live record: ownership, mgmt token, activity clock, spent claim token", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0 });
    const bound = await store.bindToAccount(rec.id, "acct_a", T0 + 1000);
    expect(bound.ok).toBe(true);
    const r = store.get(rec.id)!;
    expect(r.accountId).toBe("acct_a");
    expect(r.claimed).toBe(true);
    expect(r.mgmtToken).toBeDefined();
    expect(r.expiresAt).toBe(new Date(T0 + 1000 + 90 * DAY_MS).toISOString());
    // The anonymous token-claim can no longer run (single-use semantics kept).
    const reclaim = await store.claim(rec.id, r.claimToken, T0 + 2000);
    expect(reclaim.ok).toBe(false);
  });

  it("refuses to rebind a record owned by a different account", async () => {
    const store = await makeStore();
    const rec = await store.create({ bytes: 1, fileCount: 1, now: T0, accountId: "acct_a" });
    const bound = await store.bindToAccount(rec.id, "acct_b", T0 + 1000);
    expect(bound).toEqual({ ok: false, reason: "other-account" });
  });

  it("init(now) migrates pre-feature account-owned records once (rollout anchor)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oprun-persist-mig-"));
    // Simulate a pre-D25 registry: an account-owned record without lastRequestAt.
    const legacy = {
      version: 0,
      deployments: [
        { id: "old-app-abc123", slug: "old-app-abc123", status: "live", createdAt: new Date(T0 - 100 * DAY_MS).toISOString(), expiresAt: new Date(T0 - 93 * DAY_MS).toISOString(), claimed: true, claimToken: "t", bytes: 1, fileCount: 1, events: [], kind: "static", accountId: "acct_a" },
        { id: "anon-abc123", slug: "anon-abc123", status: "live", createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 72 * HOUR_MS).toISOString(), claimed: false, claimToken: "t", bytes: 1, fileCount: 1, events: [], kind: "static" },
      ],
    };
    await writeFile(join(dir, "registry.json"), JSON.stringify(legacy), "utf8");
    const store = new Store({ dataDir: dir });
    await store.init(T0);
    // The owned record's clock starts AT ROLLOUT — it is not swept despite 100 idle days.
    expect(store.get("old-app-abc123")!.lastRequestAt).toBe(new Date(T0).toISOString());
    expect((await store.sweep(T0 + DAY_MS)).removed).toEqual([]);
    // The anonymous record is untouched by the migration.
    expect(store.get("anon-abc123")!.lastRequestAt).toBeUndefined();
  });
});

describe("access-log activity (static lane)", () => {
  async function makeLog(lines: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "oprun-actlog-"));
    const path = join(dir, "access.log");
    await writeFile(path, lines.map((l) => `${l}\n`).join(""), "utf8");
    return path;
  }
  const line = (host: string) => JSON.stringify({ ts: 1, request: { host } });

  it("maps direct preview subdomains to slugs; ignores apex, api, nested and foreign hosts", async () => {
    const path = await makeLog([
      line("joey-abc123.test.sh"),
      line("joey-abc123.test.sh:443"),
      line("test.sh"),
      line("api.other.example"),
      line("deep.joey-abc123.test.sh"),
      "not json at all",
      line("OTHER-XYZ.TEST.SH"),
    ]);
    const activity = new AccessLogActivity(path, "test.sh");
    expect((await activity.collect()).sort()).toEqual(["joey-abc123", "other-xyz"]);
  });

  it("is incremental: a second collect only sees new lines; rotation restarts cleanly", async () => {
    const path = await makeLog([line("a-111111.test.sh")]);
    const activity = new AccessLogActivity(path, "test.sh");
    expect(await activity.collect()).toEqual(["a-111111"]);
    await appendFile(path, `${line("b-222222.test.sh")}\n`, "utf8");
    expect(await activity.collect()).toEqual(["b-222222"]);
    // Rotation: file replaced by a smaller one → start over, no lines lost.
    await rename(path, `${path}.1`);
    await writeFile(path, `${line("c-333333.test.sh")}\n`, "utf8");
    expect(await activity.collect()).toEqual(["c-333333"]);
  });

  it("leaves a half-written last line for the next tick and survives a missing file", async () => {
    const missing = new AccessLogActivity("/nonexistent/access.log", "test.sh");
    expect(await missing.collect()).toEqual([]); // degraded, never throws
    const path = await makeLog([line("done-111111.test.sh")]);
    await appendFile(path, '{"request":{"host":"partial-2222', "utf8"); // no newline yet
    const activity = new AccessLogActivity(path, "test.sh");
    expect(await activity.collect()).toEqual(["done-111111"]);
    await appendFile(path, '22.test.sh"}}\n', "utf8");
    expect(await activity.collect()).toEqual(["partial-222222"]);
  });
});

describe("accounts: pending claim + mail-confirmed bind", () => {
  it("verifyEmail hands the pending claim back exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oprun-acct-claim-"));
    const accounts = new AccountStore({ dataDir: dir });
    await accounts.init();
    const created = await accounts.createPendingEmail("a@example.com", T0, { deploymentId: "app-1", claimToken: "tok" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const verified = await accounts.verifyEmail(created.account.id, created.token, T0 + 1000);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claim).toEqual({ deploymentId: "app-1", claimToken: "tok" });
    expect(accounts.getAccount(created.account.id)!.pendingClaim).toBeUndefined();
  });

  it("bind request: one-time token, 24h expiry, only for active accounts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oprun-acct-bind-"));
    const accounts = new AccountStore({ dataDir: dir });
    await accounts.init();
    expect((await accounts.createBindRequest("ghost@example.com", { deploymentId: "x", claimToken: "t" }, T0)).ok).toBe(false);
    const created = await accounts.createPendingEmail("b@example.com", T0);
    if (!created.ok) throw new Error("setup");
    await accounts.verifyEmail(created.account.id, created.token, T0);
    const req = await accounts.createBindRequest("b@example.com", { deploymentId: "app-2", claimToken: "t2" }, T0);
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect((await accounts.confirmBind(req.account.id, "wrong", T0)).ok).toBe(false);
    expect((await accounts.confirmBind(req.account.id, req.token, T0 + 25 * HOUR_MS)).ok).toBe(false); // expired
    const again = await accounts.createBindRequest("b@example.com", { deploymentId: "app-2", claimToken: "t2" }, T0);
    if (!again.ok) throw new Error("setup");
    const confirmed = await accounts.confirmBind(again.account.id, again.token, T0 + HOUR_MS);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.claim.deploymentId).toBe("app-2");
    expect((await accounts.confirmBind(again.account.id, again.token, T0 + HOUR_MS)).ok).toBe(false); // consumed
  });
});

// ── Server integration: the claim page's two account paths, end to end.

function tarballBuffer(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (c: Buffer) => chunks.push(c));
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
  });
}

async function makeTarball(): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "oprun-persist-site-"));
  await writeFile(join(src, "index.html"), "<h1>x</h1>");
  return tarballBuffer(src);
}

async function start(deps: RunServerDeps = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-persistsrv-"));
  const base = configFromEnv({});
  const config: RunConfig = {
    ...base,
    dataDir: dir,
    baseDomain: "test.sh",
    publicBase: "http://localhost",
    accounts: { ...base.accounts, publicBase: "http://localhost" },
  };
  const run = await createRunServer(config, deps);
  await new Promise<void>((r) => run.server.listen(0, "127.0.0.1", r));
  servers.push(run.server);
  const port = (run.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, run };
}

function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function anonDeploy(base: string): Promise<string> {
  const res = await fetch(`${base}/api/deployments`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: (await makeTarball()) as unknown as BodyInit,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { slug: string }).slug;
}

describe("server: claim-page account paths (D25)", () => {
  it("signup-with-claim ties the deployment to the new account on verify", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({ mailer });
    const slug = await anonDeploy(base);
    const claimToken = run.store.get(slug)!.claimToken;

    const created = await postJson(base, "/api/accounts", { email: "new@example.com", claim: { id: slug, token: claimToken } });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { message: string }).message).toContain("stay live");

    const u = new URL(mailer.sent.at(-1)!.verifyUrl);
    const verify = await postJson(base, "/api/accounts/verify", { account: u.searchParams.get("account"), token: u.searchParams.get("token") });
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { boundDeployment?: string };
    expect(body.boundDeployment).toBe(slug);
    const rec = run.store.get(slug)!;
    expect(rec.accountId).toBeDefined();
    expect(rec.claimed).toBe(true);
  });

  it("signup-with-claim for an EXISTING email sends a bind mail; the link ties the app (indistinguishable response)", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({ mailer });
    // Existing active account:
    const created = await postJson(base, "/api/accounts", { email: "have@example.com" });
    expect(created.status).toBe(201);
    const u0 = new URL(mailer.sent.at(-1)!.verifyUrl);
    await postJson(base, "/api/accounts/verify", { account: u0.searchParams.get("account"), token: u0.searchParams.get("token") });

    const slug = await anonDeploy(base);
    const claimToken = run.store.get(slug)!.claimToken;
    const res = await postJson(base, "/api/accounts", { email: "have@example.com", claim: { id: slug, token: claimToken } });
    expect(res.status).toBe(201); // NOT 409 — same shape as the fresh-signup branch (anti-enumeration)
    expect(((await res.json()) as { message: string }).message).toContain("stay live");
    expect(mailer.binds).toHaveLength(1);

    const confirm = await fetch(mailer.binds[0]!.confirmUrl.replace("http://localhost", base));
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("tied to your account");
    expect(run.store.get(slug)!.accountId).toBeDefined();
  });

  it("rejects an invalid claim reference outright (400, no mail)", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({ mailer });
    const slug = await anonDeploy(base);
    const res = await postJson(base, "/api/accounts", { email: "x@example.com", claim: { id: slug, token: "wrong-token" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid-claim");
    expect(mailer.sent).toHaveLength(0);
    expect(run.store.get(slug)!.accountId).toBeUndefined();
  });

  it("claim page shows both paths; the T-7 warning mail goes to the account email", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({ mailer });
    const slug = await anonDeploy(base);
    const page = await fetch(`${base}/claim/${slug}?token=x`);
    const html = await page.text();
    expect(html).toContain("Keep it live with a free account");
    expect(html).toContain("Claim for 7 days");

    // Wire the record to a mail-bearing account, then cross the warn threshold.
    const created = await postJson(base, "/api/accounts", { email: "warn@example.com" });
    expect(created.status).toBe(201);
    const u = new URL(mailer.sent.at(-1)!.verifyUrl);
    const verify = await postJson(base, "/api/accounts/verify", { account: u.searchParams.get("account"), token: u.searchParams.get("token") });
    const acctView = ((await verify.json()) as { account: { id: string } }).account;
    // Bind with the CURRENT clock: this record was created over live HTTP, so
    // createdAt is real wall time and lastActivityMs = max(createdAt, bind time).
    // A fixed past T0 here made the test a time bomb (green on the day it was
    // written, red once wall time passed T0 + warn lead).
    const B0 = Date.now();
    await run.store.bindToAccount(slug, acctView.id, B0);

    await run.sweep(B0 + 84 * DAY_MS);
    expect(mailer.warnings).toHaveLength(1);
    expect(mailer.warnings[0]!.to).toBe("warn@example.com");
    expect(mailer.warnings[0]!.appUrl).toBe(`https://${slug}.test.sh`);
    // And the record survives day 90-from-creation because binding restarted its clock at B0.
    const swept = await run.sweep(B0 + 89 * DAY_MS);
    expect(swept).toEqual([]);
  });
});
