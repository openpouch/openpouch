import { z } from "zod";
import { environmentNameSchema } from "./manifest.js";
import { actionClassSchema } from "./policy.js";

/**
 * .openpouch/approvals.json — local approval requests and their state.
 * Lifecycle: pending → approved → consumed (or expired).
 *
 * Honesty note (documented in BUSINESS-RULES.md): in local-first mode this is
 * a SOFT gate — it reliably stops protocol-following agents (they cannot pass
 * the TTY confirmation) and makes approvals auditable/tamper-evident via an
 * HMAC signature, but a malicious local process could read the approver
 * secret. The HARD gate (server-held approvals) ships with the hosted cloud.
 */

export const approvalStatusSchema = z.enum(["pending", "approved", "consumed", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalRequestSchema = z
  .object({
    id: z.string().min(1),
    action: actionClassSchema,
    environment: environmentNameSchema,
    serviceId: z.string().min(1),
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    status: approvalStatusSchema,
    approvedAt: z.string().datetime().optional(),
    approvedBy: z.string().optional(),
    /** HMAC-SHA256 over canonicalApprovalPayload, keyed by the approver secret. */
    signature: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalsFileSchema = z
  .object({
    version: z.literal(0),
    requests: z.array(approvalRequestSchema).default([]),
  })
  .strict();
export type ApprovalsFile = z.infer<typeof approvalsFileSchema>;

export const APPROVALS_DIR = ".openpouch";
export const APPROVALS_FILENAME = ".openpouch/approvals.json";

/** Stable string that gets signed — any tampering with these fields breaks the signature. */
export function canonicalApprovalPayload(req: ApprovalRequest): string {
  return [req.id, req.action, req.environment, req.serviceId, req.requestedAt, req.expiresAt].join("|");
}

export function isExpired(req: ApprovalRequest, now: Date): boolean {
  return new Date(req.expiresAt).getTime() <= now.getTime();
}

/** The approval `prod`/`rollback` consume: approved, matching, not expired. */
export function findUsableApproval(
  file: ApprovalsFile,
  match: { action: ApprovalRequest["action"]; environment: ApprovalRequest["environment"]; serviceId: string },
  now: Date,
): ApprovalRequest | undefined {
  return file.requests.find(
    (r) =>
      r.status === "approved" &&
      r.action === match.action &&
      r.environment === match.environment &&
      r.serviceId === match.serviceId &&
      !isExpired(r, now),
  );
}
