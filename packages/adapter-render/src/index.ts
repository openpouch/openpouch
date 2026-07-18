import type {
  DeploySummary,
  EnvVarStatus,
  LogLine,
  ProviderAdapter,
  ServiceSummary,
} from "@openpouch/core";

/**
 * Render adapter — read path (week 1).
 * Boundary rule: Render's env-vars endpoint returns VALUES; this adapter maps
 * them to {name, present} and the value never leaves this module.
 */

export type ErrorCategory = "auth" | "provider" | "quota";

export class RenderApiError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  /** Machine-readable remediation hint for agents. */
  readonly fix: string;

  constructor(status: number, path: string) {
    const category: ErrorCategory =
      status === 401 || status === 403 ? "auth" : status === 429 ? "quota" : "provider";
    const fix =
      category === "auth"
        ? "Check RENDER_API_KEY: key missing, revoked, or lacks access to this workspace."
        : category === "quota"
          ? "Render API rate limit hit: wait and retry with backoff."
          : `Render API request failed (${path}): verify the service id exists in this workspace.`;
    super(`Render API ${status} on ${path} [${category}] — ${fix}`);
    this.name = "RenderApiError";
    this.category = category;
    this.status = status;
    this.fix = fix;
  }
}

export interface RenderAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.render.com";

/** Render deploy statuses → openpouch DeploySummary statuses. */
function mapDeployStatus(status: string): DeploySummary["status"] {
  if (status === "live") return "live";
  if (status.includes("failed")) return "failed";
  if (status === "canceled" || status === "deactivated") return "canceled";
  if (status === "created" || status === "queued") return "queued";
  return "building";
}

type RenderService = {
  id?: string;
  name?: string;
  branch?: string;
  suspended?: string;
  serviceDetails?: { url?: string; env?: string; runtime?: string };
};

function mapService(s: RenderService): ServiceSummary {
  return {
    id: s.id ?? "",
    name: s.name ?? "",
    url: s.serviceDetails?.url,
    branch: s.branch,
    runtime: s.serviceDetails?.runtime ?? s.serviceDetails?.env,
    suspended: s.suspended === "suspended",
  };
}

export function createRenderAdapter(config: RenderAdapterConfig): ProviderAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = config.fetchImpl ?? fetch;
  const apiKey = config.apiKey;
  /** Render's /v1/logs requires the owner id; resolved once per adapter via the service object. */
  let cachedOwnerId: string | undefined;

  async function get(path: string): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) throw new RenderApiError(response.status, path);
    return response.json();
  }

  /** Render list endpoints wrap items as [{cursor, <key>: {...}}]. */
  function unwrapList<T>(payload: unknown, key: string): T[] {
    if (!Array.isArray(payload)) return [];
    return payload
      .map((item) => (item && typeof item === "object" ? (item as Record<string, T>)[key] : undefined))
      .filter((x): x is T => x !== undefined);
  }

  return {
    id: "render",

    async listServices(): Promise<ServiceSummary[]> {
      const payload = await get("/v1/services?limit=50");
      return unwrapList<RenderService>(payload, "service").map(mapService);
    },

    async getService(serviceId: string): Promise<ServiceSummary> {
      const payload = (await get(`/v1/services/${serviceId}`)) as RenderService;
      return mapService(payload);
    },

    async getRecentDeploys(serviceId: string, limit = 5): Promise<DeploySummary[]> {
      const payload = await get(`/v1/services/${serviceId}/deploys?limit=${limit}`);
      type RenderDeploy = {
        id?: string;
        status?: string;
        commit?: { id?: string; message?: string };
        createdAt?: string;
        finishedAt?: string;
      };
      return unwrapList<RenderDeploy>(payload, "deploy").map((d) => ({
        id: d.id ?? "",
        status: mapDeployStatus(d.status ?? ""),
        commit: d.commit?.id,
        commitMessage: d.commit?.message,
        createdAt: d.createdAt ?? "",
        finishedAt: d.finishedAt,
      }));
    },

    async getEnvVarNames(serviceId: string): Promise<EnvVarStatus[]> {
      const payload = await get(`/v1/services/${serviceId}/env-vars?limit=100`);
      type RenderEnvVar = { key?: string; value?: string };
      // Values arrive here from Render and are dropped immediately — only
      // {name, present} crosses the adapter boundary (core contract).
      return unwrapList<RenderEnvVar>(payload, "envVar")
        .filter((v) => typeof v.key === "string" && v.key.length > 0)
        .map((v) => ({ name: v.key as string, present: (v.value ?? "").length > 0 }));
    },

    async triggerDeploy(serviceId: string, opts?: { clearCache?: boolean; commitId?: string }): Promise<DeploySummary> {
      const response = await doFetch(`${baseUrl}/v1/services/${serviceId}/deploys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clearCache: opts?.clearCache === true ? "clear" : "do_not_clear",
          ...(opts?.commitId !== undefined ? { commitId: opts.commitId } : {}),
        }),
      });
      if (!response.ok) throw new RenderApiError(response.status, `/v1/services/${serviceId}/deploys`);
      const d = (await response.json()) as {
        id?: string;
        status?: string;
        commit?: { id?: string; message?: string };
        createdAt?: string;
        finishedAt?: string;
      };
      return {
        id: d.id ?? "",
        status: mapDeployStatus(d.status ?? "created"),
        commit: d.commit?.id,
        commitMessage: d.commit?.message,
        createdAt: d.createdAt ?? "",
        finishedAt: d.finishedAt,
      };
    },

    async getDeploy(serviceId: string, deployId: string): Promise<DeploySummary> {
      const d = (await get(`/v1/services/${serviceId}/deploys/${deployId}`)) as {
        id?: string;
        status?: string;
        commit?: { id?: string; message?: string };
        createdAt?: string;
        finishedAt?: string;
      };
      return {
        id: d.id ?? "",
        status: mapDeployStatus(d.status ?? ""),
        commit: d.commit?.id,
        commitMessage: d.commit?.message,
        createdAt: d.createdAt ?? "",
        finishedAt: d.finishedAt,
      };
    },

    async getLogs(serviceId: string, opts?: { limit?: number }): Promise<LogLine[]> {
      const limit = opts?.limit ?? 50;
      if (cachedOwnerId === undefined) {
        const svc = (await get(`/v1/services/${serviceId}`)) as { ownerId?: string };
        cachedOwnerId = svc.ownerId;
      }
      const payload = await get(
        `/v1/logs?ownerId=${encodeURIComponent(cachedOwnerId ?? "")}&resource=${serviceId}&limit=${limit}`,
      );
      type RenderLog = { timestamp?: string; message?: string };
      const entries: RenderLog[] = Array.isArray(payload)
        ? (payload as RenderLog[])
        : ((payload as { logs?: RenderLog[] })?.logs ?? []);
      return entries.map((l) => ({ timestamp: l.timestamp, message: l.message ?? "" }));
    },
  };
}
