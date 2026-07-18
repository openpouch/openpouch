import { z } from "zod";
import { environmentNameSchema, type EnvironmentName } from "./manifest.js";

/**
 * deploy.policy.json — what agents may do, per environment.
 * Safety model (PRD, non-negotiable): read is always allowed, destructive
 * actions don't exist in the MVP, and production-grade actions must be
 * explicitly allowed or gated behind approval. Default is deny.
 */

export const ACTION_CLASSES = [
  "read",
  "deploy-preview",
  "deploy-production",
  "env-write",
  "rollback",
] as const;
export const actionClassSchema = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof actionClassSchema>;

export const environmentPolicySchema = z
  .object({
    allow: z.array(actionClassSchema).default([]),
    requireApproval: z.array(actionClassSchema).default([]),
  })
  .strict();
export type EnvironmentPolicy = z.infer<typeof environmentPolicySchema>;

export const policySchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(0),
    environments: z.record(environmentNameSchema, environmentPolicySchema).default({}),
    approvers: z
      .array(z.object({ name: z.string().min(1), contact: z.string().optional() }).strict())
      .optional(),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;

export const POLICY_FILENAME = "deploy.policy.json";

export type PolicyDecision = "allowed" | "requires-approval" | "denied";

/**
 * The core safety primitive. Precedence: requireApproval > allow > default.
 * "read" is allowed by default (read-only default mode); everything else
 * is denied unless the policy explicitly says otherwise.
 */
export function evaluateAction(
  policy: Policy,
  environment: EnvironmentName,
  action: ActionClass,
): PolicyDecision {
  const envPolicy = policy.environments[environment];
  if (envPolicy?.requireApproval.includes(action)) return "requires-approval";
  if (envPolicy?.allow.includes(action)) return "allowed";
  if (action === "read") return "allowed";
  return "denied";
}

/** Sensible starting policy written by `openpouch init`: previews autonomous, production gated. */
export function defaultPolicy(): Policy {
  return policySchema.parse({
    version: 0,
    environments: {
      preview: { allow: ["read", "deploy-preview", "env-write"], requireApproval: [] },
      production: { allow: ["read"], requireApproval: ["deploy-production", "rollback", "env-write"] },
    },
  });
}
