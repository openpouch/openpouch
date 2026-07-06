import { z } from "zod";

/**
 * deploy.manifest.json — the durable deployment truth in the user's repo.
 * Agents read this after context loss instead of re-deriving state from dashboards.
 * Secret VALUES never appear here; env vars are tracked by name + status only.
 */

export const PROVIDER_IDS = ["render", "vercel", "openpouch-run"] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const ENVIRONMENT_NAMES = ["preview", "staging", "production"] as const;
export const environmentNameSchema = z.enum(ENVIRONMENT_NAMES);
export type EnvironmentName = z.infer<typeof environmentNameSchema>;

export const envVarRequirementSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean().default(true),
    environments: z.array(environmentNameSchema).optional(),
    description: z.string().optional(),
  })
  .strict();
export type EnvVarRequirement = z.infer<typeof envVarRequirementSchema>;

export const healthcheckSchema = z
  .object({
    path: z.string().startsWith("/"),
    expectStatus: z.number().int().min(100).max(599).default(200),
    timeoutMs: z.number().int().positive().default(10_000),
  })
  .strict();
export type Healthcheck = z.infer<typeof healthcheckSchema>;

export const environmentConfigSchema = z
  .object({
    provider: providerIdSchema,
    /** Provider-side service identifier, e.g. a Render service id ("srv-..."). */
    serviceId: z.string().optional(),
    url: z.string().url().optional(),
    branch: z.string().optional(),
    autoDeploy: z.boolean().optional(),
  })
  .strict();
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(0),
    project: z
      .object({
        name: z.string().min(1),
        repo: z.string().optional(),
        framework: z.string().optional(),
      })
      .strict(),
    build: z
      .object({
        buildCommand: z.string().optional(),
        startCommand: z.string().optional(),
        rootDir: z.string().optional(),
      })
      .strict()
      .optional(),
    healthcheck: healthcheckSchema.optional(),
    env: z.array(envVarRequirementSchema).default([]),
    environments: z.record(environmentNameSchema, environmentConfigSchema),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

export const MANIFEST_FILENAME = "deploy.manifest.json";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/** Parse with agent-friendly, path-prefixed error strings instead of a thrown ZodError. */
export function parseManifest(input: unknown): ParseResult<Manifest> {
  const result = manifestSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${MANIFEST_FILENAME}:${issue.path.join(".") || "<root>"}: ${issue.message}`,
    ),
  };
}
