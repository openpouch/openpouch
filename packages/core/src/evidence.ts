import { z } from "zod";
import { environmentNameSchema, providerIdSchema } from "./manifest.js";

/**
 * deploy.evidence.json — append-only record of what actually happened.
 * Written automatically after deploys/verifications so humans and agents
 * can answer "what is live, where, since when, and how do we roll back?"
 * without a dashboard. Never contains secret values.
 */

export const smokeCheckSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    passed: z.boolean(),
    detail: z.string().optional(),
  })
  .strict();
export type SmokeCheck = z.infer<typeof smokeCheckSchema>;

export const deploymentRecordSchema = z
  .object({
    id: z.string().min(1),
    environment: environmentNameSchema,
    provider: providerIdSchema,
    status: z.enum(["live", "failed", "rolled-back", "superseded"]),
    url: z.string().url().optional(),
    commit: z.string().optional(),
    deployedAt: z.string().datetime(),
    approvedBy: z.string().optional(),
    smoke: z.array(smokeCheckSchema).optional(),
    /** Provider-side identifier of the last known-good deploy to roll back to. */
    rollbackAnchor: z.string().optional(),
    notes: z.string().optional(),
    // Deploy context (OpenClaw 2026-07-04: "evidence should capture more of the
    // deploy context in one place") — all optional, filled by the lanes that know
    // them. Env vars as NAMES only; the values are secrets (D7) and never land
    // in evidence.
    cliVersion: z.string().optional(),
    kind: z.enum(["static", "dynamic"]).optional(),
    framework: z.string().optional(),
    buildCommand: z.string().optional(),
    startCommand: z.string().optional(),
    healthStatus: z.enum(["pending", "healthy", "degraded"]).optional(),
    expiresAt: z.string().datetime().optional(),
    envVarNames: z.array(z.string()).optional(),
    healthPath: z.string().optional(),
  })
  .strict();
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;

export const evidenceSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(0),
    deployments: z.array(deploymentRecordSchema).default([]),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export const EVIDENCE_FILENAME = "deploy.evidence.json";
