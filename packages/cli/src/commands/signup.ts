import type { RunAdapter } from "@openpouch/adapter-run";
import {
  EXIT,
  errorResult,
  isProviderApiError,
  makeAdapter,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { signupEmailSummary, signupGithubSummary } from "../summary.js";

/**
 * `openpouch signup` — create an openpouch account. Anchor = email OR GitHub
 * (SSOT D16, the human picks). Agent-completable end to end for email (no
 * dashboard, PRD R4); GitHub needs the human to approve in a browser. No human
 * check / CAPTCHA on our side (R8).
 *
 *   openpouch signup --email you@example.com   → emails a verification link
 *   openpouch signup --github                  → prints the GitHub authorize URL
 *
 * Finish email signup with `openpouch activate --account <id> --token <token>`.
 */
export async function signupCommand(
  ctx: CliContext,
  opts: { email?: string | undefined; github?: boolean },
): Promise<CommandResult> {
  const adapter = makeAdapter(ctx, "openpouch-run", "anonymous") as Partial<RunAdapter>;

  if (opts.github === true) {
    const url = typeof adapter.githubStartUrl === "function" ? adapter.githubStartUrl() : "";
    return summarized(
      EXIT.OK,
      { ok: true, method: "github", startUrl: url },
      signupGithubSummary(url),
      ["openpouch signup (GitHub)", `  Open this URL in your browser and approve: ${url}`, "  You'll get your API key on the page that follows."],
    );
  }

  const email = opts.email?.trim();
  if (!email) {
    return errorResult(
      EXIT.USAGE,
      "usage",
      "no signup method given",
      "Use `openpouch signup --email <you@example.com>` or `openpouch signup --github`.",
    );
  }
  if (typeof adapter.signupEmail !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "signup unavailable", "This is an internal wiring error.");
  }
  try {
    const res = await adapter.signupEmail(email);
    return summarized(
      EXIT.OK,
      {
        ok: true,
        method: "email",
        accountId: res.accountId,
        message: res.message,
        ...(res.devVerifyToken ? { devVerifyToken: res.devVerifyToken } : {}),
      },
      signupEmailSummary(email),
      [
        `openpouch signup ✓ ${email}`,
        `  account: ${res.accountId}`,
        `  ${res.message}`,
        ...(res.devVerifyToken
          ? [`  finish: openpouch activate --account ${res.accountId} --token ${res.devVerifyToken}`]
          : [`  then:   openpouch activate --account ${res.accountId} --token <token-from-email>`]),
      ],
    );
  } catch (e) {
    // A 409 means the email is already registered — a usage conflict, not a
    // provider outage. The generic RunApiError fix talks about a deployment
    // expiring ("…may have expired (72h unclaimed)"), which is nonsense for a
    // signup and misleads an agent (cross-harness 2026-07-01). Point at the
    // existing account instead, with an exit code that says "change your input".
    if (isProviderApiError(e) && e.status === 409) {
      return errorResult(
        EXIT.USAGE,
        "usage",
        `an openpouch account for ${email} already exists`,
        `This email is already registered. If it's yours, you already have an account — run \`openpouch whoami\` to check it (and reuse the key from your original verification email). To create a separate account, use a different email.`,
      );
    }
    if (isProviderApiError(e)) {
      return errorResult(EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
