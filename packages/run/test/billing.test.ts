import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaddleBilling,
  billingConfigFromEnv,
  parseSignatureHeader,
  signWebhookPayload,
  type BillingConfig,
  type BillingProvider,
} from "../src/billing.js";
import type { BindConfirmMail, InactivityWarningMail, Mailer, VerificationMail } from "../src/mailer.js";
import { configFromEnv, createRunServer, type RunConfig, type RunServerDeps } from "../src/server.js";

/**
 * B4 billing (staged for 0.3.0): the Paddle seam (signature scheme, event
 * normalisation, checkout call) and the two server routes. Payment itself
 * never touches run-d — these tests prove exactly that boundary.
 */

const SECRET = "pdl_ntfset_test_secret";

function baseConfig(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    ...billingConfigFromEnv({}),
    provider: "paddle",
    apiKey: "test-api-key",
    webhookSecret: SECRET,
    prices: { starter: "pri_starter", pro: "pri_pro" },
    founderPrices: { starter: "pri_starter_founder", pro: "pri_pro_founder" },
    ...overrides,
  };
}

function signedHeaders(body: string, ts = Math.floor(Date.now() / 1000)): { "paddle-signature": string } {
  return { "paddle-signature": `ts=${ts};h1=${signWebhookPayload(SECRET, ts, body)}` };
}

function subscriptionEvent(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_1",
    event_type: "subscription.activated",
    occurred_at: "2026-07-11T10:00:00Z",
    data: {
      id: "sub_1",
      status: "active",
      customer_id: "ctm_1",
      custom_data: { op_account_id: "acct_x", op_tier: "pro", op_founder: false },
      items: [{ price: { id: "pri_pro" } }],
      current_billing_period: { ends_at: "2026-08-11T10:00:00Z" },
      ...dataOverrides,
    },
    ...overrides,
  });
}

describe("billing: signature scheme (pure)", () => {
  it("parses ts=…;h1=… order-independently and rejects garbage", () => {
    expect(parseSignatureHeader("ts=1671552777;h1=abc")).toEqual({ ts: 1671552777, h1: "abc" });
    expect(parseSignatureHeader("h1=abc;ts=5")).toEqual({ ts: 5, h1: "abc" });
    expect(parseSignatureHeader("h1=abc")).toBeNull();
    expect(parseSignatureHeader("ts=NaN;h1=abc")).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
  });

  it("verifies HMAC over `ts:rawBody`, rejects wrong secret/stale timestamp/malformed json", () => {
    const billing = new PaddleBilling(baseConfig());
    const body = subscriptionEvent();
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const good = `ts=${ts};h1=${signWebhookPayload(SECRET, ts, body)}`;
    expect(billing.verifyWebhook(body, good, now)?.eventId).toBe("evt_1");
    // tampered body
    expect(billing.verifyWebhook(body.replace("pro", "prX"), good, now)).toBeNull();
    // wrong secret
    const bad = `ts=${ts};h1=${signWebhookPayload("other", ts, body)}`;
    expect(billing.verifyWebhook(body, bad, now)).toBeNull();
    // stale timestamp (outside the 5s window)
    const staleTs = ts - 60;
    const stale = `ts=${staleTs};h1=${signWebhookPayload(SECRET, staleTs, body)}`;
    expect(billing.verifyWebhook(body, stale, now)).toBeNull();
    // valid signature over malformed json
    const junk = "not json";
    const junkSig = `ts=${ts};h1=${signWebhookPayload(SECRET, ts, junk)}`;
    expect(billing.verifyWebhook(junk, junkSig, now)).toBeNull();
  });

  it("normalises the event: custom_data first, price-id reverse lookup as tier fallback", () => {
    const billing = new PaddleBilling(baseConfig());
    const now = Date.now();
    const withCustom = subscriptionEvent();
    const evt = billing.verifyWebhook(withCustom, signedHeaders(withCustom)["paddle-signature"], now)!;
    expect(evt).toMatchObject({ accountId: "acct_x", tier: "pro", subscriptionId: "sub_1", status: "active", renewsAt: "2026-08-11T10:00:00Z" });
    // no custom_data → tier from the founder price id
    const noCustom = subscriptionEvent({}, { custom_data: null, items: [{ price: { id: "pri_starter_founder" } }] });
    const evt2 = billing.verifyWebhook(noCustom, signedHeaders(noCustom)["paddle-signature"], now)!;
    expect(evt2.tier).toBe("starter");
    expect(evt2.accountId).toBeUndefined();
  });
});

describe("billing: createCheckout (fetch fake)", () => {
  it("POSTs items + custom_data with the bearer key and returns checkout.url", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFake: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ data: { id: "txn_1", checkout: { url: "https://pay.example/txn_1" } } }), { status: 200 });
    };
    const billing = new PaddleBilling(baseConfig({ apiBase: "https://sandbox-api.example" }), fetchFake);
    const out = await billing.createCheckout({ accountId: "acct_x", tier: "pro", priceId: "pri_pro", founderPricing: true });
    expect(out).toEqual({ checkoutUrl: "https://pay.example/txn_1", transactionId: "txn_1" });
    expect(captured!.url).toBe("https://sandbox-api.example/transactions");
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(String(captured!.init.body)) as { items: unknown; custom_data: Record<string, unknown> };
    expect(body.items).toEqual([{ price_id: "pri_pro", quantity: 1 }]);
    expect(body.custom_data).toEqual({ op_account_id: "acct_x", op_tier: "pro", op_founder: true });
  });

  it("fails loudly when no default payment link is configured (checkout.url null)", async () => {
    const fetchFake: typeof fetch = async () =>
      new Response(JSON.stringify({ data: { id: "txn_1", checkout: { url: null } } }), { status: 200 });
    const billing = new PaddleBilling(baseConfig(), fetchFake);
    await expect(billing.createCheckout({ accountId: "a", tier: "pro", priceId: "p", founderPricing: false })).rejects.toThrow(/default payment link/);
  });
});

// ── Server routes.

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

class CapturingMailer implements Mailer {
  sent: VerificationMail[] = [];
  async sendVerification(mail: VerificationMail): Promise<void> {
    this.sent.push(mail);
  }
  async sendInactivityWarning(_: InactivityWarningMail): Promise<void> {}
  async sendBindConfirm(_: BindConfirmMail): Promise<void> {}
}

async function start(billingCfg: Partial<BillingConfig>, deps: RunServerDeps = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-billing-"));
  const base = configFromEnv({});
  const config: RunConfig = {
    ...base,
    dataDir: dir,
    baseDomain: "test.sh",
    publicBase: "http://localhost",
    accounts: { ...base.accounts, publicBase: "http://localhost" },
    billing: { ...base.billing, ...billingCfg },
  };
  const run = await createRunServer(config, deps);
  await new Promise<void>((r) => run.server.listen(0, "127.0.0.1", r));
  servers.push(run.server);
  const port = (run.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, run };
}

function postJson(base: string, path: string, body: unknown, key?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function signupActive(base: string, mailer: CapturingMailer, email = "buyer@example.com"): Promise<{ key: string; accountId: string }> {
  const created = await postJson(base, "/api/accounts", { email });
  expect(created.status).toBe(201);
  const u = new URL(mailer.sent.at(-1)!.verifyUrl);
  const verify = await postJson(base, "/api/accounts/verify", { account: u.searchParams.get("account"), token: u.searchParams.get("token") });
  const body = (await verify.json()) as { key: string; account: { id: string } };
  return { key: body.key, accountId: body.account.id };
}

const checkoutFake: BillingProvider = {
  async createCheckout(input) {
    return { checkoutUrl: `https://pay.example/${input.tier}/${input.priceId}`, transactionId: "txn_test" };
  },
  verifyWebhook() {
    return null;
  },
};

describe("server: POST /api/billing/checkout", () => {
  it("is dormant without a provider (503) and key-gated with one", async () => {
    const mailer = new CapturingMailer();
    const off = await start({ provider: "" }, { mailer });
    expect((await postJson(off.base, "/api/billing/checkout", { plan: "pro" })).status).toBe(503);

    const on = await start(baseConfig(), { mailer, billing: checkoutFake });
    expect((await postJson(on.base, "/api/billing/checkout", { plan: "pro" })).status).toBe(401);
  });

  it("validates the plan (with availablePlans) and mints the checkout URL + relay summary", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start(baseConfig(), { mailer, billing: checkoutFake });
    const { key } = await signupActive(base, mailer);

    const bad = await postJson(base, "/api/billing/checkout", { plan: "gold" }, key);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { availablePlans: string[] }).availablePlans).toEqual(["pro", "starter"]);

    const res = await postJson(base, "/api/billing/checkout", { plan: "pro" }, key);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { checkoutUrl: string; founderPricing: boolean; summary: string };
    expect(body.checkoutUrl).toBe("https://pay.example/pro/pri_pro");
    expect(body.founderPricing).toBe(false);
    expect(body.summary).toContain("hand this URL to the human");
  });

  it("founder cohort: an account created before gaDate checks out at founder prices", async () => {
    const mailer = new CapturingMailer();
    const future = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
    const { base } = await start(baseConfig({ gaDate: future }), { mailer, billing: checkoutFake });
    const { key } = await signupActive(base, mailer);
    const res = await postJson(base, "/api/billing/checkout", { plan: "starter" }, key);
    const body = (await res.json()) as { founderPricing: boolean; checkoutUrl: string };
    expect(body.founderPricing).toBe(true);
    expect(body.checkoutUrl).toBe("https://pay.example/starter/pri_starter_founder");
  });
});

describe("server: POST /api/billing/webhook", () => {
  async function startReal() {
    const mailer = new CapturingMailer();
    // Real PaddleBilling verifies our self-signed payloads; checkout is never called.
    const setup = await start(baseConfig({ apiBase: "https://unused.invalid" }), { mailer });
    return { ...setup, mailer };
  }
  const rawPost = (base: string, body: string, headers: Record<string, string>) =>
    fetch(`${base}/api/billing/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("applies subscription.activated: tier flips, billing state stored; duplicates and bad signatures don't", async () => {
    const { base, run, mailer } = await startReal();
    const { key, accountId } = await signupActive(base, mailer);

    const body = subscriptionEvent({}, { custom_data: { op_account_id: accountId, op_tier: "pro", op_founder: false } });
    expect((await rawPost(base, body, { "paddle-signature": "ts=1;h1=junk" })).status).toBe(403);

    const ok = await rawPost(base, body, signedHeaders(body));
    expect(ok.status).toBe(200);
    const acct = run.accounts.getAccount(accountId)!;
    expect(acct.tier).toBe("pro");
    expect(acct.billing).toMatchObject({ status: "active", plan: "pro", subscriptionId: "sub_1", customerId: "ctm_1" });

    // Same event id again → acknowledged as duplicate, nothing re-applied.
    const dup = await rawPost(base, body, signedHeaders(body));
    expect(((await dup.json()) as { duplicate?: boolean }).duplicate).toBe(true);

    // whoami reflects the paid tier (quota table has no "pro"? default table does).
    const who = await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${key}` } });
    expect(((await who.json()) as { tier: { name: string } }).tier.name).toBe("pro");
  });

  it("ignores stale (out-of-order) events and downgrades non-destructively on cancel", async () => {
    const { base, run, mailer } = await startReal();
    const { accountId } = await signupActive(base, mailer);

    const activated = subscriptionEvent({ event_id: "evt_a", occurred_at: "2026-07-11T10:00:00Z" }, { custom_data: { op_account_id: accountId, op_tier: "pro" } });
    await rawPost(base, activated, signedHeaders(activated));
    expect(run.accounts.getAccount(accountId)!.tier).toBe("pro");

    // An OLDER event arriving late must not clobber the newer state.
    const stale = subscriptionEvent({ event_id: "evt_old", occurred_at: "2026-07-11T09:00:00Z" }, { custom_data: { op_account_id: accountId, op_tier: "starter" } });
    const staleRes = await rawPost(base, stale, signedHeaders(stale));
    expect(((await staleRes.json()) as { ignored?: string }).ignored).toBe("stale event");
    expect(run.accounts.getAccount(accountId)!.tier).toBe("pro");

    // Cancel → back to free; billing keeps the reference trail; nothing is deleted.
    const cancel = subscriptionEvent(
      { event_id: "evt_c", event_type: "subscription.canceled", occurred_at: "2026-07-11T11:00:00Z" },
      { status: "canceled", custom_data: { op_account_id: accountId, op_tier: "pro" } },
    );
    await rawPost(base, cancel, signedHeaders(cancel));
    const acct = run.accounts.getAccount(accountId)!;
    expect(acct.tier).toBe("free");
    expect(acct.billing!.status).toBe("cancelled");
  });

  it("past_due keeps the paid tier (the MoR runs dunning)", async () => {
    const { base, run, mailer } = await startReal();
    const { accountId } = await signupActive(base, mailer);
    const activated = subscriptionEvent({ event_id: "e1", occurred_at: "2026-07-11T10:00:00Z" }, { custom_data: { op_account_id: accountId, op_tier: "pro" } });
    await rawPost(base, activated, signedHeaders(activated));
    const pastDue = subscriptionEvent(
      { event_id: "e2", event_type: "subscription.updated", occurred_at: "2026-07-11T12:00:00Z" },
      { status: "past_due", custom_data: { op_account_id: accountId, op_tier: "pro" } },
    );
    await rawPost(base, pastDue, signedHeaders(pastDue));
    const acct = run.accounts.getAccount(accountId)!;
    expect(acct.tier).toBe("pro");
    expect(acct.billing!.status).toBe("past_due");
  });
});

// Keep tar helpers referenced (parity with sibling test files' structure).
void spawn;
void writeFile;
