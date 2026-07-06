import { createInterface } from "node:readline/promises";
import { isExpired } from "@openpouch/core";
import {
  approverName,
  getApproverSecret,
  loadApprovals,
  saveApprovals,
  signApproval,
} from "../approvals.js";
import { EXIT, errorResult, summarized, type CliContext, type CommandResult } from "../shared.js";
import { approveListSummary, approveResultSummary } from "../summary.js";

async function realConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function approveCommand(ctx: CliContext, requestId: string | undefined): Promise<CommandResult> {
  const approvals = await loadApprovals(ctx.cwd);
  const now = new Date();

  if (requestId === undefined) {
    const pending = approvals.requests.filter((r) => r.status === "pending" && !isExpired(r, now));
    return summarized(
      EXIT.OK,
      { ok: true, pending },
      approveListSummary(pending),
      pending.length === 0
        ? ["no pending approval requests"]
        : [
            "pending approval requests:",
            ...pending.map((r) => `  ${r.id}  ${r.action} on ${r.environment} (service ${r.serviceId}, expires ${r.expiresAt})`),
            "approve with: openpouch approve <id>",
          ],
    );
  }

  // The gate comes FIRST — before any request lookup. Every non-TTY approve
  // attempt with an id gets the same human-required answer, deterministically:
  // an agent can neither approve nor probe which request ids exist, and the
  // contract is testable without a live pending request (Codex suite smoke
  // 2026-07-05). See BUSINESS-RULES.md for local-soft-gate vs. hosted-hard-gate.
  const interactive = ctx.interactive ?? {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm: realConfirm,
  };
  if (!interactive.isTTY) {
    return errorResult(
      EXIT.POLICY,
      "human-required",
      "approve requires an interactive terminal — agents cannot approve their own production actions",
      `A human runs this in their own terminal: openpouch approve ${requestId}`,
    );
  }

  // Interactive (human) from here on — only now does the id get resolved.
  const request = approvals.requests.find((r) => r.id === requestId);
  if (request === undefined) {
    return errorResult(EXIT.USAGE, "usage", `no approval request with id ${requestId}`, "List requests with `openpouch approve`.");
  }
  if (request.status !== "pending") {
    return errorResult(EXIT.USAGE, "usage", `request ${requestId} is ${request.status}`, "Only pending requests can be approved.");
  }
  if (isExpired(request, now)) {
    request.status = "expired";
    await saveApprovals(ctx.cwd, approvals);
    return errorResult(EXIT.USAGE, "usage", `request ${requestId} expired at ${request.expiresAt}`, "Re-run the deploy command to create a fresh request.");
  }

  const confirmed = await interactive.confirm(
    `Approve "${request.action}" on ${request.environment} (service ${request.serviceId})? [y/N] `,
  );
  if (!confirmed) {
    return summarized(EXIT.OK, { ok: true, approved: false }, approveResultSummary(false), ["not approved"]);
  }

  const secret = await getApproverSecret(true, ctx.env["OPENPOUCH_HOME"]);
  if (secret === undefined) {
    return errorResult(EXIT.UNEXPECTED, "internal", "could not create approver secret", "Check permissions on ~/.openpouch/.");
  }
  request.status = "approved";
  request.approvedAt = now.toISOString();
  request.approvedBy = approverName();
  request.signature = signApproval(request, secret);
  await saveApprovals(ctx.cwd, approvals);

  return summarized(
    EXIT.OK,
    { ok: true, approved: true, request: { id: request.id, approvedBy: request.approvedBy, approvedAt: request.approvedAt } },
    approveResultSummary(true),
    [
      `approved ✓ ${request.id} (${request.action} on ${request.environment}) by ${request.approvedBy}`,
      "the agent can now re-run the deploy command",
    ],
  );
}
