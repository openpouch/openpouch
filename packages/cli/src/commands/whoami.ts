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
import { whoamiSummary } from "../summary.js";

/**
 * `openpouch whoami` — report the account behind the current openpouch-run key
 * (tier + usage), or that the caller is anonymous. Read-only; agent-usable (no
 * human check, PRD R8). The key is resolved from OPENPOUCH_API_KEY or
 * ~/.openpouch/openpouch-run.key and never echoed.
 */
export async function whoamiCommand(ctx: CliContext): Promise<CommandResult> {
  const key = (await resolveProviderApiKey(ctx.env, "openpouch-run")) ?? ANONYMOUS_KEY;
  if (key === ANONYMOUS_KEY) {
    return summarized(
      EXIT.OK,
      { ok: true, authenticated: false },
      whoamiSummary({ authenticated: false }),
      [
        "openpouch whoami — not signed in (anonymous instant lane)",
        "  Deploys use the free anonymous tier.",
        "  Create an account: openpouch signup --email <you@example.com>  (or --github)",
      ],
    );
  }

  const adapter = makeAdapter(ctx, "openpouch-run", key) as Partial<RunAdapter>;
  if (typeof adapter.whoami !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "account lookup unavailable", "This is an internal wiring error.");
  }
  try {
    const status = await adapter.whoami();
    const identities = status.account.identities.map((i) => i.label ?? i.value).join(", ") || "—";
    return summarized(
      EXIT.OK,
      { ok: true, authenticated: true, account: status.account, tier: status.tier, usage: status.usage },
      whoamiSummary({
        authenticated: true,
        tier: status.tier.name,
        liveDeployments: status.usage.liveDeployments,
        maxLive: status.tier.maxLiveDeployments,
      }),
      [
        `openpouch whoami ✓ ${status.account.id} [${status.tier.name}]`,
        `  identities: ${identities}`,
        `  live apps:  ${status.usage.liveDeployments}/${status.tier.maxLiveDeployments} (${status.usage.dynamicDeployments} running)`,
        `  deploys:    ${status.usage.deploysLastHour}/hour, ${status.usage.deploysLastDay}/day`,
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
