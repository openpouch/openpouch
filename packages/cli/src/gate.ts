import {
  evaluateAction,
  findUsableApproval,
  type ActionClass,
  type EnvironmentName,
  type Policy,
} from "@openpouch/core";
import {
  getApproverSecret,
  loadApprovals,
  newApprovalRequest,
  saveApprovals,
  signatureValid,
} from "./approvals.js";
import { EXIT, errorResult, type CliContext, type CommandResult } from "./shared.js";
import { approvalRequiredSummary } from "./summary.js";

export type GateOutcome =
  | { ok: true; approvedBy?: string; approvalId?: string }
  | { ok: false; result: CommandResult };

/**
 * The policy gate every state-changing command passes through:
 * denied → blocked; requires-approval → consume a valid signed approval or
 * create/reuse a pending request and block; allowed → proceed.
 */
export async function passPolicyGate(
  ctx: CliContext,
  policy: Policy,
  environment: EnvironmentName,
  action: ActionClass,
  serviceId: string,
  rerunCommand: string,
): Promise<GateOutcome> {
  const decision = evaluateAction(policy, environment, action);

  if (decision === "denied") {
    return {
      ok: false,
      result: errorResult(
        EXIT.POLICY,
        "policy-denied",
        `policy denies "${action}" on ${environment}`,
        `Grant it in deploy.policy.json (allow or requireApproval for environment "${environment}").`,
      ),
    };
  }

  if (decision === "allowed") return { ok: true };

  const now = new Date();
  const approvals = await loadApprovals(ctx.cwd);
  const usable = findUsableApproval(approvals, { action, environment, serviceId }, now);
  const secret = await getApproverSecret(false, ctx.env["OPENPOUCH_HOME"]);

  if (usable !== undefined && secret !== undefined && signatureValid(usable, secret)) {
    usable.status = "consumed";
    await saveApprovals(ctx.cwd, approvals);
    return {
      ok: true,
      ...(usable.approvedBy !== undefined ? { approvedBy: usable.approvedBy } : {}),
      approvalId: usable.id,
    };
  }

  const pending = approvals.requests.find(
    (r) =>
      r.status === "pending" &&
      r.action === action &&
      r.environment === environment &&
      r.serviceId === serviceId &&
      new Date(r.expiresAt).getTime() > now.getTime(),
  );
  const request = pending ?? newApprovalRequest({ action, environment, serviceId }, now);
  if (pending === undefined) {
    approvals.requests.push(request);
    await saveApprovals(ctx.cwd, approvals);
  }
  const summary = approvalRequiredSummary(environment, request.id);
  return {
    ok: false,
    result: {
      exitCode: EXIT.POLICY,
      json: {
        ok: false,
        summary,
        error: {
          category: "approval-required",
          message: `"${action}" on ${environment} requires human approval`,
          fix: `A human must run \`openpouch approve ${request.id}\` in an interactive terminal, then re-run \`${rerunCommand}\`.`,
        },
        approvalRequest: { id: request.id, action, environment, serviceId, expiresAt: request.expiresAt },
      },
      human: [
        `approval required: "${action}" on ${environment}`,
        `request id: ${request.id} (expires ${request.expiresAt})`,
        `next: a human runs \`openpouch approve ${request.id}\`, then re-run \`${rerunCommand}\``,
        "",
        summary,
      ],
    },
  };
}
