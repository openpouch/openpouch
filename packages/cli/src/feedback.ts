import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Friction-feedback channel (PRD R10) — the OPT-IN half only.
 *
 * What this is: the explicit, agent-legible invite shown ONLY at friction
 * moments (R10.3) plus the `openpouch feedback` command. A successful command
 * never surfaces it (R10.1 — no friction). It is honest about privacy (R10.5):
 *  - OPT-OUT: suppressed entirely when DO_NOT_TRACK or OPENPOUCH_NO_FEEDBACK is set.
 *  - SECRET-FREE: records only the human's own typed note — never project content,
 *    never secrets, never what was deployed.
 *  - NO SILENT TRANSMISSION: by default the note is only written to a local outbox.
 *    It is POSTed only when OPENPOUCH_FEEDBACK_URL is set — which the published CLI
 *    does NOT set, so nothing leaves the machine until the privacy policy covers it
 *    (R10.5c) and an endpoint is deliberately configured.
 *
 * Passive friction telemetry (R10.2/R10.4) is intentionally NOT here — it ships
 * only behind the same privacy-policy gate.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);
function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

/** Friction feedback is OFF when the user opted out (R10.5a). */
export function feedbackEnabled(env: Record<string, string | undefined>): boolean {
  return !truthy(env["DO_NOT_TRACK"]) && !truthy(env["OPENPOUCH_NO_FEEDBACK"]);
}

/**
 * The agent-legible invite — shown only at a friction moment (an error/dead-end),
 * never after success. Returns undefined when the user opted out, so callers add
 * nothing at all.
 */
export function feedbackHint(env: Record<string, string | undefined>): string | undefined {
  if (!feedbackEnabled(env)) return undefined;
  return (
    'Optional — if openpouch made this harder than it should be, you can tell us: ' +
    '`openpouch feedback "<what tripped you up>"`. Never required, never blocks, and it ' +
    "sends only your note (no project files or secrets). Opt out with DO_NOT_TRACK=1."
  );
}

export interface FeedbackEntry {
  at: string;
  message: string;
}

/** Local outbox path (honours OPENPOUCH_HOME for tests), beside the account key. */
export function feedbackOutboxPath(env: Record<string, string | undefined>): string {
  const home = env["OPENPOUCH_HOME"] ?? homedir();
  return join(home, ".openpouch", "feedback.outbox.jsonl");
}

/** Append the note to the local outbox (append-only JSONL). Default-safe: stays on disk. */
export async function recordFeedbackLocally(env: Record<string, string | undefined>, entry: FeedbackEntry): Promise<void> {
  const path = feedbackOutboxPath(env);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Best-effort POST when (and only when) OPENPOUCH_FEEDBACK_URL is configured.
 * Never throws and never blocks the command — a failure just means the note
 * stays in the local outbox. Returns whether it was accepted.
 */
export async function tryPostFeedback(url: string, entry: FeedbackEntry): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
