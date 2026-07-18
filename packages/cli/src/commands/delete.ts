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
import { deleteDeploymentSummary } from "../summary.js";

/** Deployment names (slugs) are DNS-label-safe: lowercase letters, digits, hyphens. */
const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * `openpouch delete <name>` — delete one of your OWN instant-lane deployments,
 * freeing a quota slot. This is the self-service answer to a "limit reached"
 * error: the agent clears space itself instead of waiting for the 72h sweep.
 *
 * Owner-only: it needs your account key, and the server verifies the deployment
 * belongs to that account — a key can never delete another account's (or an
 * anonymous) app. Deleting an ephemeral preview is NOT a governed-production
 * action, so it needs no approval and is agent-usable (PRD R8, D13). No
 * interactive confirmation (an agent has no TTY; the app is re-creatable with
 * `openpouch deploy`).
 */
export async function deleteCommand(ctx: CliContext, slug: string | undefined): Promise<CommandResult> {
  if (!slug || !SLUG_RE.test(slug)) {
    return errorResult(
      EXIT.USAGE,
      "usage",
      slug ? `invalid deployment name: ${slug}` : "missing deployment name",
      "Name the app to delete, e.g. `openpouch delete my-app-ab12cd`. Run `openpouch list` to see your apps.",
      "openpouch list",
    );
  }

  const key = (await resolveProviderApiKey(ctx.env, "openpouch-run")) ?? ANONYMOUS_KEY;
  if (key === ANONYMOUS_KEY) {
    return errorResult(
      EXIT.AUTH,
      "auth",
      "deleting a deployment needs your account key",
      "Only the owner can delete an app, and that's tied to your account. Sign in first: run `openpouch signup --email <you@example.com>` (or `--github`), then retry.",
      "openpouch signup",
    );
  }

  const adapter = makeAdapter(ctx, "openpouch-run", key) as Partial<RunAdapter>;
  if (typeof adapter.deleteDeployment !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "delete unavailable", "This is an internal wiring error.");
  }
  try {
    const result = await adapter.deleteDeployment(slug);
    return summarized(
      EXIT.OK,
      { ok: true, slug: result.slug, ...(result.kind ? { kind: result.kind } : {}) },
      deleteDeploymentSummary(result.slug),
      [`openpouch delete ✓ ${result.slug} removed${result.kind ? ` (${result.kind})` : ""}`, "  That frees one of your app slots."],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      // 404 (unknown name) / 403 (not your app) carry the server's pointed fix
      // toward `openpouch list`; auth → exit 4, everything else → exit 5.
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix, "openpouch list");
    }
    throw e;
  }
}
