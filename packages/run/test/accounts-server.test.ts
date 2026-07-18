import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKey } from "../src/auth.js";
import type { GithubApi } from "../src/github.js";
import type { BindConfirmMail, InactivityWarningMail, Mailer, VerificationMail } from "../src/mailer.js";
import { type TierTable } from "../src/quota.js";
import { configFromEnv, createRunServer, type RunConfig, type RunServerDeps } from "../src/server.js";

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
  const src = await mkdtemp(join(tmpdir(), "oprun-acct-site-"));
  await writeFile(join(src, "index.html"), "<h1>x</h1>");
  return tarballBuffer(src);
}

async function start(accountOverrides: Partial<RunConfig["accounts"]> = {}, deps: RunServerDeps = {}, overrides: Partial<RunConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-acctsrv-"));
  const base = configFromEnv({});
  const config: RunConfig = {
    ...base,
    dataDir: dir,
    baseDomain: "test.sh",
    publicBase: "http://localhost",
    accounts: { ...base.accounts, publicBase: "http://localhost", ...accountOverrides },
    ...overrides,
  };
  const run = await createRunServer(config, deps);
  await new Promise<void>((r) => run.server.listen(0, "127.0.0.1", r));
  servers.push(run.server);
  const port = (run.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, run, dir, config };
}

function postJson(base: string, path: string, body: unknown, key?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

function deployWithKey(base: string, tarball: Buffer, key?: string) {
  return fetch(`${base}/api/deployments`, {
    method: "POST",
    headers: { "content-type": "application/gzip", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: tarball as unknown as BodyInit,
  });
}

/** Run the email signup → verify flow, returning the issued API key. */
async function signupEmail(base: string, mailer: CapturingMailer, email = "joey@example.com"): Promise<string> {
  const created = await postJson(base, "/api/accounts", { email });
  expect(created.status).toBe(201);
  const link = mailer.sent.at(-1)!.verifyUrl;
  const u = new URL(link);
  const verify = await postJson(base, "/api/accounts/verify", {
    account: u.searchParams.get("account"),
    token: u.searchParams.get("token"),
  });
  expect(verify.status).toBe(200);
  return ((await verify.json()) as { key: string }).key;
}

describe("accounts: email signup → key → deploy", () => {
  it("signs up by email, issues a key, and a keyed deploy is owned by the account", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({}, { mailer });
    const key = await signupEmail(base, mailer);

    const res = await deployWithKey(base, await makeTarball(), key);
    expect(res.status).toBe(201);
    const body201 = (await res.json()) as {
      slug: string;
      ownership?: string;
      expiryPolicy?: string;
      claimUrl?: string;
      claimToken?: string;
      expiresAt: string;
    };
    const slug = body201.slug;
    expect(run.store.get(slug)?.accountId).toBeDefined();

    // F-01 (Codex 2026-07-12): the 201 must tell the ACCOUNT story — no claim
    // fields (the app is already saved), rolling expiry from second zero.
    expect(body201.ownership).toBe("account");
    expect(body201.expiryPolicy).toBe("rolling-while-used");
    expect(body201.claimUrl).toBeUndefined();
    expect(body201.claimToken).toBeUndefined();
    expect(Date.parse(body201.expiresAt) - Date.now()).toBeGreaterThan(30 * 24 * 3600 * 1000);

    // Anonymous control: same endpoint without a key keeps the claim story.
    const anonRes = await deployWithKey(base, await makeTarball());
    expect(anonRes.status).toBe(201);
    const anonBody = (await anonRes.json()) as { ownership?: string; expiryPolicy?: string; claimUrl?: string };
    expect(anonBody.ownership).toBe("anonymous");
    expect(anonBody.expiryPolicy).toBe("fixed");
    expect(anonBody.claimUrl).toContain("/claim/");

    // whoami reflects the owned deployment
    const who = await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${key}` } });
    expect(who.status).toBe(200);
    const body = (await who.json()) as { tier: { name: string }; usage: { liveDeployments: number } };
    expect(body.tier.name).toBe("free");
    expect(body.usage.liveDeployments).toBe(1);
  });

  it("verify-link GET returns an HTML key page that is copyable + wraps (mobile-safe)", async () => {
    // The key is shown exactly once. When a human clicks the emailed link (GET),
    // the page must render the key so it can be copied on a phone: a wrapping key
    // box (no horizontal truncation) + a Copy button. Regression guard for the
    // real bug where the key ran off-screen in a mail in-app browser.
    const mailer = new CapturingMailer();
    const { base } = await start({}, { mailer });
    const created = await postJson(base, "/api/accounts", { email: "wrap@example.com" });
    expect(created.status).toBe(201);
    const u = new URL(mailer.sent.at(-1)!.verifyUrl);
    const res = await fetch(
      `${base}/api/accounts/verify?account=${u.searchParams.get("account")}&token=${u.searchParams.get("token")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('op_live_'); // the key is actually rendered
    expect(html).toContain('class="key"'); // wrapping key box
    expect(html).toContain('id="opkey"'); // copy target
    expect(html).toContain('Copy key'); // copy button
  });

  it("rejects whoami without a valid key (401, with a fix, no CAPTCHA)", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/account`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { fix: string };
    expect(body.fix).toContain("Bearer");
  });

  it("exposes the verify token only when devExposeTokens is on", async () => {
    const { base } = await start({ devExposeTokens: true });
    const created = await postJson(base, "/api/accounts", { email: "dev@example.com" });
    const body = (await created.json()) as { devVerifyToken?: string };
    expect(body.devVerifyToken).toBeTruthy();

    const off = await start();
    const created2 = await postJson(off.base, "/api/accounts", { email: "dev@example.com" });
    const body2 = (await created2.json()) as { devVerifyToken?: string };
    expect(body2.devVerifyToken).toBeUndefined();
  });
});

describe("accounts: self-service list + delete (Befund #8 — agent frees its own quota)", () => {
  it("GET /api/deployments lists only the caller's own apps, secret-free", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({}, { mailer });
    const keyA = await signupEmail(base, mailer, "a@example.com");
    const keyB = await signupEmail(base, mailer, "b@example.com");
    const slugA = ((await (await deployWithKey(base, await makeTarball(), keyA)).json()) as { slug: string }).slug;
    await deployWithKey(base, await makeTarball(), keyB); // B's app
    await deployWithKey(base, await makeTarball()); // anonymous app

    const res = await fetch(`${base}/api/deployments`, { headers: { authorization: `Bearer ${keyA}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: Array<Record<string, unknown>> };
    expect(body.deployments).toHaveLength(1); // only A's own — never B's or the anonymous one
    expect(body.deployments[0]!.slug).toBe(slugA);
    expect(body.deployments[0]!.kind).toBe("static");
    // secret-free (D7): no capability token, accountId, or container internals
    const raw = JSON.stringify(body);
    for (const leak of ["claimToken", "mgmtToken", "accountId", "containerId", "hostPort", "startCmd"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("GET /api/deployments needs a key (401 for anonymous)", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/deployments`)).status).toBe(401);
  });

  it("DELETE with the owner's key removes the app + frees the slot; another account's key is 403", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({}, { mailer });
    const keyA = await signupEmail(base, mailer, "a@example.com");
    const keyB = await signupEmail(base, mailer, "b@example.com");
    const slug = ((await (await deployWithKey(base, await makeTarball(), keyA)).json()) as { slug: string }).slug;

    const cross = await fetch(`${base}/api/deployments/${slug}`, { method: "DELETE", headers: { authorization: `Bearer ${keyB}` } });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { error: string }).error).toBe("not-owner");
    expect(run.store.get(slug)).toBeDefined(); // untouched

    const own = await fetch(`${base}/api/deployments/${slug}`, { method: "DELETE", headers: { authorization: `Bearer ${keyA}` } });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { slug: string }).slug).toBe(slug);
    expect(run.store.get(slug)).toBeUndefined();
    const who = await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${keyA}` } });
    expect(((await who.json()) as { usage: { liveDeployments: number } }).usage.liveDeployments).toBe(0); // slot freed
  });

  it("logs of an account-owned deployment are readable only with the owning key (no cross-account read)", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({}, { mailer });
    const keyA = await signupEmail(base, mailer, "a@example.com");
    const keyB = await signupEmail(base, mailer, "b@example.com");
    const slug = ((await (await deployWithKey(base, await makeTarball(), keyA)).json()) as { slug: string }).slug;
    const logsPath = `${base}/api/deployments/${slug}/logs`;

    // No key and another account's key both get 404 — never leak the logs, nor
    // even that the slug is a keyed deployment.
    expect((await fetch(logsPath)).status).toBe(404);
    expect((await fetch(logsPath, { headers: { authorization: `Bearer ${keyB}` } })).status).toBe(404);
    // The owner sees them.
    const own = await fetch(logsPath, { headers: { authorization: `Bearer ${keyA}` } });
    expect(own.status).toBe(200);
    expect(Array.isArray(((await own.json()) as { logs: unknown[] }).logs)).toBe(true);
  });

  it("logs of an anonymous deployment stay readable by slug (M1 design, no owner to check)", async () => {
    const { base } = await start();
    const slug = ((await (await deployWithKey(base, await makeTarball())).json()) as { slug: string }).slug;
    const res = await fetch(`${base}/api/deployments/${slug}/logs`);
    expect(res.status).toBe(200);
  });

  it("DELETE still honours the legacy mgmt-token path (claim flow, back-compat)", async () => {
    const { base, run } = await start();
    const dep = (await (await deployWithKey(base, await makeTarball())).json()) as { slug: string; claimToken: string };
    const claim = await postJson(base, `/api/deployments/${dep.slug}/claim`, { token: dep.claimToken });
    const mgmt = ((await claim.json()) as { mgmtToken: string }).mgmtToken;
    const del = await fetch(`${base}/api/deployments/${dep.slug}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mgmtToken: mgmt }),
    });
    expect(del.status).toBe(200);
    expect(run.store.get(dep.slug)).toBeUndefined();
  });
});

describe("accounts: key-gating (requireKey)", () => {
  it("with requireKey on, anonymous deploys get 401 but keyed deploys succeed", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({ requireKey: true }, { mailer });

    const anon = await deployWithKey(base, await makeTarball());
    expect(anon.status).toBe(401);

    const key = await signupEmail(base, mailer);
    const keyed = await deployWithKey(base, await makeTarball(), key);
    expect(keyed.status).toBe(201);
  });

  it("default (requireKey off) keeps the anonymous lane open (PRD R5)", async () => {
    const { base } = await start();
    expect((await deployWithKey(base, await makeTarball())).status).toBe(201);
  });
});

describe("accounts: per-account quota", () => {
  it("enforces the tier's live-deployment cap with 429", async () => {
    const tiers: TierTable = {
      anonymous: { name: "anonymous", deploysPerHour: 100, deploysPerDay: 100, maxLiveDeployments: 1, maxBytes: 1e9, maxDynamic: 5, volumeMaxBytes: 0, maxAlwaysOn: 0 },
      free: { name: "free", deploysPerHour: 100, deploysPerDay: 100, maxLiveDeployments: 2, maxBytes: 1e9, maxDynamic: 5, volumeMaxBytes: 0, maxAlwaysOn: 0 },
    };
    const mailer = new CapturingMailer();
    const { base } = await start({ tiers }, { mailer });
    const key = await signupEmail(base, mailer);

    expect((await deployWithKey(base, await makeTarball(), key)).status).toBe(201);
    expect((await deployWithKey(base, await makeTarball(), key)).status).toBe(201);
    const third = await deployWithKey(base, await makeTarball(), key);
    expect(third.status).toBe(429);
    const body = (await third.json()) as { reason: string; fix: string };
    expect(body.reason).toBe("max-live");
    expect(body.fix).toBeTruthy();
  });
});

describe("accounts: deploy auth", () => {
  it("rejects a presented-but-invalid key with 401 (no silent anonymous downgrade)", async () => {
    const { base } = await start();
    const res = await deployWithKey(base, await makeTarball(), "op_live_deadbeefdeadbeef_bogus");
    expect(res.status).toBe(401);
  });

  it("rejects a suspended account's key with 401", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({}, { mailer }, { adminToken: "s3cret" });
    const key = await signupEmail(base, mailer);
    const acctId = run.accounts.resolveKey(key, Date.now())!.account.id;
    await run.accounts.setStatus(acctId, "suspended");
    const res = await deployWithKey(base, await makeTarball(), key);
    expect(res.status).toBe(401);
  });
});

describe("accounts: key lifecycle endpoints", () => {
  it("mints, lists (no secret), and revokes keys", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({}, { mailer });
    const key = await signupEmail(base, mailer);

    const minted = await postJson(base, "/api/keys", { label: "ci" }, key);
    expect(minted.status).toBe(201);
    const minted2 = (await minted.json()) as { key: string; keyId: string };

    const listed = await fetch(`${base}/api/keys`, { headers: { authorization: `Bearer ${key}` } });
    const keys = ((await listed.json()) as { keys: { keyId: string; prefix: string }[] }).keys;
    expect(keys.length).toBe(2);
    // The list view must never leak the secret half. Parse the secret canonically:
    // it is base64url and may contain "_", so the old `split("_").pop()` grabbed only
    // the fragment after the *last* "_" — sometimes a single char like "U" — and the
    // assertion then flaked whenever that fragment happened to appear elsewhere in the
    // JSON (this turned CI red on unrelated, code-unchanged commits). The full 43-char
    // secret is a collision-free needle.
    const parsed = parseKey(minted2.key);
    if (parsed === null) throw new Error("a freshly minted key must parse");
    expect(JSON.stringify(keys)).not.toContain(parsed.secret);

    // revoke the second key → it no longer authenticates
    const del = await fetch(`${base}/api/keys/${minted2.keyId}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
    expect(del.status).toBe(200);
    const who = await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${minted2.key}` } });
    expect(who.status).toBe(401);
    // the original key still works
    expect((await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  });
});

describe("accounts: admin tier + suspend", () => {
  it("sets tier and suspends an account (token-gated)", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({}, { mailer }, { adminToken: "s3cret" });
    const key = await signupEmail(base, mailer);
    const acctId = run.accounts.resolveKey(key, Date.now())!.account.id;

    // forbidden without the admin token
    expect((await postJson(base, `/api/admin/accounts/${acctId}/tier`, { tier: "pro" })).status).toBe(403);

    const setTier = await fetch(`${base}/api/admin/accounts/${acctId}/tier`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "s3cret" },
      body: JSON.stringify({ tier: "pro" }),
    });
    expect(setTier.status).toBe(200);
    expect(run.accounts.getAccount(acctId)?.tier).toBe("pro");

    // suspend → the key stops working
    const suspend = await fetch(`${base}/api/admin/accounts/${acctId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "s3cret" },
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(suspend.status).toBe(200);
    expect((await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });
});

describe("accounts: GitHub OAuth", () => {
  it("is dormant (503) unless configured", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/auth/github/start`, { redirect: "manual" })).status).toBe(503);
  });

  it("redirects to GitHub then issues a key on callback (with a fake github api)", async () => {
    const githubApi: GithubApi = { async exchangeCode() { return { id: 4242, login: "octocat" }; } };
    const { base, run } = await start({ githubClientId: "cid", githubClientSecret: "csec" }, { githubApi });

    const startRes = await fetch(`${base}/api/auth/github/start`, { redirect: "manual" });
    expect(startRes.status).toBe(302);
    const location = startRes.headers.get("location")!;
    expect(location).toContain("github.com/login/oauth/authorize");
    const state = new URL(location).searchParams.get("state")!;

    const cb = await fetch(`${base}/api/auth/github/callback?state=${state}&code=abc123`);
    expect(cb.status).toBe(200);
    const html = await cb.text();
    const key = /op_live_[0-9a-f]+_[A-Za-z0-9_-]+/.exec(html)?.[0];
    expect(key).toBeTruthy();

    // the issued key authenticates against the GitHub-anchored account
    const who = await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${key}` } });
    expect(who.status).toBe(200);
    expect(run.accounts.findByGithub(4242)).toBeDefined();
  });

  it("rejects a callback with an unknown state (CSRF guard)", async () => {
    const githubApi: GithubApi = { async exchangeCode() { return { id: 1, login: "x" }; } };
    const { base } = await start({ githubClientId: "cid", githubClientSecret: "csec" }, { githubApi });
    const cb = await fetch(`${base}/api/auth/github/callback?state=forged&code=abc`);
    expect(cb.status).toBe(403);
  });
});

describe("L10 volumes + always-on deploy gates (staged 0.3.0)", () => {
  it("denies volume/always-on for anonymous, free tiers, and static uploads — each with an honest fix", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({}, { mailer });
    const tarball = await makeTarball();
    const deployWith = (headers: Record<string, string>, key?: string) =>
      fetch(`${base}/api/deployments`, {
        method: "POST",
        headers: { "content-type": "application/gzip", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
        body: tarball as unknown as BodyInit,
      });

    // Anonymous caller asking for a volume → 403 with the signup+upgrade path.
    const anon = await deployWith({ "x-openpouch-volume": "1" });
    expect(anon.status).toBe(403);
    expect(((await anon.json()) as { fix: string }).fix).toContain("upgrade");

    // Free account asking for always-on on a STATIC upload → the dynamic-only
    // denial wins deliberately (an upgrade wouldn't make a static site a server;
    // the tier gate itself is covered by the quota/orchestrator tests).
    const key = await signupEmail(base, mailer, "vol@example.com");
    const free = await deployWith({ "x-openpouch-always-on": "1" }, key);
    expect(free.status).toBe(403);
    expect(((await free.json()) as { error: string }).error).toContain("dynamic");

    // Paid tier, but a STATIC upload asking for a volume → dynamic-only denial.
    const paidTiers: TierTable = {
      anonymous: { name: "anonymous", deploysPerHour: 100, deploysPerDay: 100, maxLiveDeployments: 10, maxBytes: 1e9, maxDynamic: 5, volumeMaxBytes: 0, maxAlwaysOn: 0 },
      free: { name: "free", deploysPerHour: 100, deploysPerDay: 100, maxLiveDeployments: 10, maxBytes: 1e9, maxDynamic: 5, volumeMaxBytes: 5e9, maxAlwaysOn: 2 },
    };
    const paid = await start({ tiers: paidTiers }, { mailer });
    const paidKey = await signupEmail(paid.base, mailer, "vol2@example.com");
    const staticVol = await fetch(`${paid.base}/api/deployments`, {
      method: "POST",
      headers: { "content-type": "application/gzip", authorization: `Bearer ${paidKey}`, "x-openpouch-volume": "1" },
      body: (await makeTarball()) as unknown as BodyInit,
    });
    expect(staticVol.status).toBe(403);
    expect(((await staticVol.json()) as { error: string }).error).toContain("dynamic");
  });
});
