import { EXIT, errorResult, summarized, type CliContext, type CommandResult } from "../shared.js";
import { feedbackEnabled, recordFeedbackLocally, tryPostFeedback, type FeedbackEntry } from "../feedback.js";

/**
 * `openpouch feedback "<text>"` — the explicit, opt-in friction channel (PRD
 * R10.3). Records ONLY the human's own note (secret-free). Default-safe: the
 * note is written to a local outbox and is POSTed only when OPENPOUCH_FEEDBACK_URL
 * is set (the published CLI does not set it → nothing leaves the machine until
 * the privacy policy covers it, R10.5c). Opting out (DO_NOT_TRACK) makes it a
 * no-op. It never blocks and never fails a flow (R10.1).
 */
export async function feedbackCommand(ctx: CliContext, text?: string): Promise<CommandResult> {
  if (!feedbackEnabled(ctx.env)) {
    return summarized(
      EXIT.OK,
      { ok: true, recorded: false, reason: "opt-out" },
      "Feedback is turned off here (DO_NOT_TRACK / OPENPOUCH_NO_FEEDBACK), so nothing was recorded or sent.",
      ["feedback: disabled (opt-out) — nothing recorded"],
    );
  }

  const message = (text ?? "").trim();
  if (message.length === 0) {
    return errorResult(
      EXIT.USAGE,
      "usage",
      "no feedback text",
      'Pass what tripped you up, e.g. openpouch feedback "deploy reported live but / returned 404".',
    );
  }

  // Secret-free by construction: only the human's typed note + a timestamp.
  const entry: FeedbackEntry = { at: new Date().toISOString(), message: message.slice(0, 2000) };
  await recordFeedbackLocally(ctx.env, entry);

  const url = ctx.env["OPENPOUCH_FEEDBACK_URL"]?.trim();
  const sent = url ? await tryPostFeedback(url, entry) : false;

  return summarized(
    EXIT.OK,
    { ok: true, recorded: true, sent },
    sent
      ? "Thanks — your note was sent to the openpouch team. Nothing else is needed from you."
      : "Thanks — your note was saved. It helps us smooth out the rough edges. Nothing else is needed from you.",
    [sent ? "feedback: recorded + sent" : "feedback: recorded locally", `  note: ${message.slice(0, 120)}${message.length > 120 ? "…" : ""}`],
  );
}
