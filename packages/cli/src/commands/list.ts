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
import { friendlyUtc, listDeploymentsSummary } from "../summary.js";

/**
 * `openpouch list` — show the live instant-lane deployments owned by the current
 * account key (name, kind, status, live URL, expiry). Read-only; agent-usable
 * (no human check, PRD R8). The key is resolved from OPENPOUCH_API_KEY or
 * ~/.openpouch/openpouch-run.key and never echoed.
 *
 * Anonymous callers have no account-owned set — the server can only attribute a
 * deployment to an account — so they get an empty list plus a pointer to signup,
 * NOT an error. The returned records carry no capability token (the adapter view
 * omits them), so nothing secret is ever printed (D7).
 */
export async function listCommand(ctx: CliContext): Promise<CommandResult> {
  const key = (await resolveProviderApiKey(ctx.env, "openpouch-run")) ?? ANONYMOUS_KEY;
  if (key === ANONYMOUS_KEY) {
    return summarized(
      EXIT.OK,
      { ok: true, authenticated: false, count: 0, deployments: [] },
      listDeploymentsSummary({ authenticated: false }),
      [
        "openpouch list — not signed in (anonymous instant lane)",
        "  Anonymous previews aren't grouped under an account.",
        "  Create one: openpouch signup --email <you@example.com>  (or --github)",
      ],
    );
  }

  const adapter = makeAdapter(ctx, "openpouch-run", key) as Partial<RunAdapter>;
  if (typeof adapter.listDeployments !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "deployment list unavailable", "This is an internal wiring error.");
  }
  try {
    const deployments = await adapter.listDeployments();
    const human =
      deployments.length === 0
        ? ["openpouch list — no live apps on your account", "  Deploy one: openpouch deploy"]
        : [
            `openpouch list — ${deployments.length} live app${deployments.length === 1 ? "" : "s"}`,
            ...deployments.map(
              (d) =>
                `  ${d.slug}  [${d.kind ?? "static"}${d.runtimeStatus ? `/${d.runtimeStatus}` : ""}]  expires ${friendlyUtc(d.expiresAt)}  ${d.url}`,
            ),
            "  Remove one to free a slot: openpouch delete <name>",
          ];
    return summarized(
      EXIT.OK,
      { ok: true, authenticated: true, count: deployments.length, deployments },
      listDeploymentsSummary({
        authenticated: true,
        count: deployments.length,
        ...(deployments.length > 0
          ? { nextExpiry: deployments.map((d) => d.expiresAt).sort()[0] }
          : {}),
      }),
      human,
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
