import { createHmac } from "node:crypto";
import { constantTimeEqual } from "./auth.js";

/**
 * Billing seam (B4 / SSOT D25, staged for 0.3.0). Payment is a HUMAN moment
 * (D13, same class as approve/claim): the agent only ever receives a checkout
 * URL to hand over; the human pays in the browser at the Merchant of Record;
 * a signed webhook flips the account tier. No card data ever touches run-d.
 *
 * Provider = Paddle (E6 decision 2026-07-10; Polar stays the prepared
 * fallback — this interface is the seam that keeps a switch cheap). Zero
 * third-party deps: raw fetch against the Billing API, HMAC via node:crypto.
 */

/** Tier-name → MoR price id. Configured via env (OPENPOUCH_RUN_BILLING_PRICES_JSON). */
export type PriceTable = Record<string, string>;

export interface BillingConfig {
  /** "" disables billing routes entirely (default until rollout). */
  provider: "" | "paddle";
  /** API origin — live: https://api.paddle.com · sandbox: https://sandbox-api.paddle.com */
  apiBase: string;
  /** Server-side API key (env; never a repo file). */
  apiKey: string;
  /** Notification-destination secret (pdl_ntfset_…) for webhook signatures. */
  webhookSecret: string;
  /** Regular price ids per paid tier. */
  prices: PriceTable;
  /** Launch-price ids for the founder cohort (accounts created before gaDate). */
  founderPrices: PriceTable;
  /** GA cutoff (ISO). Accounts created BEFORE this get founder prices. Empty → founder path off. */
  gaDate: string;
  /** Signature timestamp tolerance (Paddle recommends 5s). */
  signatureToleranceMs: number;
}

export function billingConfigFromEnv(env: Record<string, string | undefined>): BillingConfig {
  const parseTable = (raw: string | undefined): PriceTable => {
    if (!raw?.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: PriceTable = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  };
  const provider = env.OPENPOUCH_RUN_BILLING_PROVIDER === "paddle" ? "paddle" : "";
  return {
    provider,
    apiBase: env.OPENPOUCH_RUN_BILLING_API_BASE ?? "https://api.paddle.com",
    apiKey: env.OPENPOUCH_RUN_BILLING_API_KEY ?? "",
    webhookSecret: env.OPENPOUCH_RUN_BILLING_WEBHOOK_SECRET ?? "",
    prices: parseTable(env.OPENPOUCH_RUN_BILLING_PRICES_JSON),
    founderPrices: parseTable(env.OPENPOUCH_RUN_BILLING_FOUNDER_PRICES_JSON),
    gaDate: env.OPENPOUCH_RUN_BILLING_GA_DATE ?? "",
    signatureToleranceMs: Number(env.OPENPOUCH_RUN_BILLING_SIG_TOLERANCE_MS ?? "5000"),
  };
}

/** Normalised subscription event — the only shape the server ever handles. */
export interface BillingEvent {
  eventId: string;
  /** Raw provider event type (e.g. "subscription.activated"). */
  type: string;
  occurredAt: string;
  /** openpouch account this event belongs to (from custom_data, set at checkout). */
  accountId?: string;
  /** Paid tier the subscription maps to (custom_data first, price-id reverse lookup as fallback). */
  tier?: string;
  subscriptionId?: string;
  customerId?: string;
  /** Provider subscription status ("active", "past_due", "canceled", …). */
  status?: string;
  /** End of the current billing period, if present. */
  renewsAt?: string;
  founderPricing?: boolean;
}

export interface CheckoutInput {
  accountId: string;
  tier: string;
  priceId: string;
  founderPricing: boolean;
}

export interface BillingProvider {
  /** Create a hosted-checkout transaction; returns the URL to hand to the human. */
  createCheckout(input: CheckoutInput): Promise<{ checkoutUrl: string; transactionId: string }>;
  /**
   * Verify Paddle-Signature and parse the raw webhook body into a BillingEvent.
   * Returns null on ANY failure (bad signature, stale timestamp, malformed
   * body) — the caller answers 403/400 without detail (D7).
   */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined, now: number): BillingEvent | null;
}

/** Parse `ts=…;h1=…` (order-independent, unknown pairs ignored). */
export function parseSignatureHeader(header: string | undefined): { ts: number; h1: string } | null {
  if (!header) return null;
  let ts: number | undefined;
  let h1: string | undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts") ts = Number(value);
    if (key === "h1") h1 = value;
  }
  if (ts === undefined || !Number.isFinite(ts) || !h1) return null;
  return { ts, h1 };
}

/** HMAC-SHA256 over `${ts}:${rawBody}` — Paddle's signed-payload scheme. */
export function signWebhookPayload(secret: string, ts: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
}

export class PaddleBilling implements BillingProvider {
  constructor(
    private readonly cfg: BillingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<{ checkoutUrl: string; transactionId: string }> {
    const res = await this.fetchImpl(`${this.cfg.apiBase}/transactions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ price_id: input.priceId, quantity: 1 }],
        custom_data: { op_account_id: input.accountId, op_tier: input.tier, op_founder: input.founderPricing },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`billing: create transaction → ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as { data?: { id?: string; checkout?: { url?: string | null } } };
    const transactionId = body.data?.id ?? "";
    const checkoutUrl = body.data?.checkout?.url ?? "";
    if (!transactionId || !checkoutUrl) {
      // checkout.url is null until a default payment link is configured in the
      // Paddle dashboard (Checkout settings) — an operator setup gap, not a bug.
      throw new Error("billing: transaction created but no checkout URL — configure the default payment link in the Paddle dashboard");
    }
    return { checkoutUrl, transactionId };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined, now: number): BillingEvent | null {
    if (!this.cfg.webhookSecret) return null;
    const sig = parseSignatureHeader(signatureHeader);
    if (!sig) return null;
    if (Math.abs(now - sig.ts * 1000) > this.cfg.signatureToleranceMs) return null; // replay guard
    const expected = signWebhookPayload(this.cfg.webhookSecret, sig.ts, rawBody);
    if (!constantTimeEqual(sig.h1, expected)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const evt = parsed as {
      event_id?: string;
      event_type?: string;
      occurred_at?: string;
      data?: {
        id?: string;
        status?: string;
        customer_id?: string;
        custom_data?: { op_account_id?: unknown; op_tier?: unknown; op_founder?: unknown } | null;
        items?: { price?: { id?: string } }[];
        current_billing_period?: { ends_at?: string } | null;
      };
    };
    if (!evt.event_id || !evt.event_type) return null;

    const custom = evt.data?.custom_data ?? undefined;
    const accountId = typeof custom?.op_account_id === "string" ? custom.op_account_id : undefined;
    let tier = typeof custom?.op_tier === "string" ? custom.op_tier : undefined;
    if (!tier) {
      // Fallback: reverse-map the price id (covers events without inherited custom_data).
      const priceIds = (evt.data?.items ?? []).map((i) => i.price?.id).filter((p): p is string => typeof p === "string");
      for (const [name, id] of [...Object.entries(this.cfg.prices), ...Object.entries(this.cfg.founderPrices)]) {
        if (priceIds.includes(id)) {
          tier = name;
          break;
        }
      }
    }
    return {
      eventId: evt.event_id,
      type: evt.event_type,
      occurredAt: evt.occurred_at ?? new Date(now).toISOString(),
      accountId,
      tier,
      subscriptionId: evt.data?.id,
      customerId: evt.data?.customer_id,
      status: evt.data?.status,
      renewsAt: evt.data?.current_billing_period?.ends_at ?? undefined,
      founderPricing: custom?.op_founder === true,
    };
  }
}
