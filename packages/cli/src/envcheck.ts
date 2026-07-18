import type { EnvironmentName, Manifest, ProviderAdapter } from "@openpouch/core";

export interface EnvVarReport {
  /**
   * Whether the provider API could be asked at all. `"unavailable"` (instant
   * lane): `present`/`extraOnProvider` are OMITTED — an empty list would read
   * as "no env vars exist" when the truth is "cannot look" (OpenClaw
   * 2026-07-05 #2). `missingRequired` is then [] here and recomputed from
   * local deploy evidence by `inspect`.
   */
  runtimeIntrospection: "available" | "unavailable";
  present?: string[];
  missingRequired: string[];
  extraOnProvider?: string[];
}

export function requiredVarNames(manifest: Manifest, environment: EnvironmentName): string[] {
  return manifest.env
    .filter((v) => v.required && (v.environments === undefined || v.environments.includes(environment)))
    .map((v) => v.name);
}

export async function computeEnvVarReport(
  adapter: ProviderAdapter,
  manifest: Manifest,
  environment: EnvironmentName,
  serviceId: string,
): Promise<EnvVarReport> {
  if (adapter.envIntrospection === "unavailable") {
    // Nothing provable via the provider: claim neither presence nor absence.
    return { runtimeIntrospection: "unavailable", missingRequired: [] };
  }
  const providerVars = await adapter.getEnvVarNames(serviceId);
  const presentNames = providerVars.filter((v) => v.present).map((v) => v.name);
  const manifestNames = new Set(manifest.env.map((v) => v.name));
  return {
    runtimeIntrospection: "available",
    present: presentNames,
    missingRequired: requiredVarNames(manifest, environment).filter((n) => !presentNames.includes(n)),
    extraOnProvider: providerVars.map((v) => v.name).filter((n) => !manifestNames.has(n)),
  };
}
