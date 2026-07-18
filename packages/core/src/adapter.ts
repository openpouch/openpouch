import type { EnvironmentName, ProviderId } from "./manifest.js";

/**
 * Provider adapter contract. Week 1 implements the read path for Render;
 * write operations (deploys, env writes, rollback) land in week 2 and must
 * each pass through the policy engine before execution.
 */

export interface ServiceSummary {
  id: string;
  name: string;
  url?: string;
  branch?: string;
  runtime?: string;
  suspended?: boolean;
}

export interface DeploySummary {
  id: string;
  status: "live" | "building" | "failed" | "canceled" | "queued";
  commit?: string;
  commitMessage?: string;
  createdAt: string;
  finishedAt?: string;
  /** Instant lane only: when the deployment expires. Live server truth at read
   *  time — on a rolling (account-owned) record this is the CURRENT deadline,
   *  which local deploy-time evidence can't provide. */
  expiresAt?: string;
}

/** Env var presence only — values never cross this boundary. */
export interface EnvVarStatus {
  name: string;
  present: boolean;
}

export interface LogLine {
  timestamp?: string;
  message: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /**
   * Can this provider's API prove which env vars exist at runtime?
   * `"unavailable"` (instant lane): getEnvVarNames() returning [] means
   * "cannot look", NOT "none exist" — consumers must not render it as absence.
   * Omitted/`"available"`: the provider API is the source of truth.
   */
  readonly envIntrospection?: "available" | "unavailable";
  listServices(): Promise<ServiceSummary[]>;
  getService(serviceId: string): Promise<ServiceSummary>;
  getRecentDeploys(serviceId: string, limit?: number): Promise<DeploySummary[]>;
  /** Names/presence only; the adapter must never return secret values. */
  getEnvVarNames(serviceId: string): Promise<EnvVarStatus[]>;
  getLogs(serviceId: string, opts?: { limit?: number }): Promise<LogLine[]>;
  /**
   * Write path. Callers MUST consult the policy engine (evaluateAction) before
   * invoking; adapters execute, they do not decide.
   */
  /** opts.commitId deploys a specific commit — the provider-portable rollback primitive. */
  triggerDeploy(serviceId: string, opts?: { clearCache?: boolean; commitId?: string }): Promise<DeploySummary>;
  getDeploy(serviceId: string, deployId: string): Promise<DeploySummary>;
}

export type AdapterFactory = (config: {
  apiKey: string;
  environment?: EnvironmentName;
}) => ProviderAdapter;
