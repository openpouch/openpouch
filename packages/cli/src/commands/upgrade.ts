import type { RunAdapter } from "@openpouch/adapter-run";
import {
  ANONYMOUS_KEY,
  EXIT,
  errorResult,
  isProviderApiError,
  makeAdapter,
  resolveProviderApiKey,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";

/**
 * `openpouch upgrade --plan <name>` — mint a hosted-checkout URL for a paid
 * tier (B4, staged). Payment is deliberately a HUMAN moment (same class as
 * approve/claim, D13): this command only returns the URL for the agent to hand
 * over; the human pays in the browser at the Merchant of Record, the tier
 * flips via webhook, and `openpouch whoami` shows the result. The CLI never
 * touches payment data.
 */
export async function upgradeCommand(ctx: CliContext, plan: string | undefined): Promise<CommandResult> {
  const key = (await resolveProviderApiKey(ctx.env, "openpouch-run")) ?? ANONYMOUS_KEY;
  if (key === ANONYMOUS_KEY) {
    return errorResult(
      EXIT.AUTH,
      "auth",
      "upgrading needs an account",
      "Create one first: openpouch signup --email <you@example.com> (or --github), then retry with your API key set.",
    );
  }
  if (!plan) {
    return errorResult(
      EXIT.USAGE,
      "usage",
      "missing --plan",
      "Pass the tier to buy, e.g. `openpouch upgrade --plan starter`. Plans and prices: https://openpouch.dev/#pricing",
    );
  }

  const adapter = makeAdapter(ctx, "openpouch-run", key) as Partial<RunAdapter>;
  if (typeof adapter.createCheckout !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "billing unavailable", "This is an internal wiring error.");
  }
  try {
    const checkout = await adapter.createCheckout(plan);
    return summarized(
      EXIT.OK,
      {
        ok: true,
        plan: checkout.plan,
        founderPricing: checkout.founderPricing,
        checkoutUrl: checkout.checkoutUrl,
        humanAction: "Open the checkout URL in a browser and complete payment — agents never pay.",
      },
      checkout.summary,
      [
        `openpouch upgrade → ${checkout.plan}${checkout.founderPricing ? " (founder pricing)" : ""}`,
        `  checkout: ${checkout.checkoutUrl}`,
        "  Hand this link to the human who pays; the tier updates automatically after payment.",
        "  Verify afterwards: openpouch whoami",
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
