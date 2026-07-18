import type {
  DeploySummary,
  EnvVarStatus,
  LogLine,
  ProviderAdapter,
  ServiceSummary,
} from "@openpouch/core";

/**
 * Vercel adapter. Built against mocked API shapes (2026-06); live verification
 * happens once a VERCEL_TOKEN is provided — field mappings are deliberately
 * defensive. Same boundary rule as Render: env var VALUES never leave this
 * module ({name, present} only).
 */

export type ErrorCategory = "auth" | "provider" | "quota";

export class VercelApiError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly fix: string;

  constructor(status: number, path: string) {
    const category: ErrorCategory =
      status === 401 || status === 403 ? "auth" : status === 429 ? "quota" : "provider";
    const fix =
      category === "auth"
        ? "Check VERCEL_TOKEN: token missing, revoked, or lacks access to this team/project."
        : category === "quota"
          ? "Vercel API rate limit hit: wait and retry with backoff."
          : `Vercel API request failed (${path}): verify the project exists and the team scope is correct.`;
    super(`Vercel API ${status} on ${path} [${category}] — ${fix}`);
    this.name = "VercelApiError";
    this.category = category;
    this.status = status;
    this.fix = fix;
  }
}

export interface VercelAdapterConfig {
  apiKey: string;
  /** Team scope; appended as ?teamId= to every request when set. */
  teamId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.vercel.com";

/** Vercel deployment states → openpouch DeploySummary statuses. */
function mapState(state: string): DeploySummary["status"] {
  switch (state.toUpperCase()) {
    case "READY":
      return "live";
    case "ERROR":
      return "failed";
    case "CANCELED":
      return "canceled";
    case "QUEUED":
      return "queued";
    default:
      return "building"; // BUILDING, INITIALIZING, …
  }
}

const toIso = (epochMs: number | string | undefined): string =>
  typeof epochMs === "number" ? new Date(epochMs).toISOString() : (epochMs ?? "");

type VercelDeployment = {
  uid?: string;
  id?: string;
  state?: string;
  readyState?: string;
  url?: string;
  created?: number;
  createdAt?: number;
  ready?: number;
  meta?: { githubCommitSha?: string; githubCommitMessage?: string };
};

function mapDeployment(d: VercelDeployment): DeploySummary {
  return {
    id: d.uid ?? d.id ?? "",
    status: mapState(d.readyState ?? d.state ?? ""),
    commit: d.meta?.githubCommitSha,
    commitMessage: d.meta?.githubCommitMessage,
    createdAt: toIso(d.createdAt ?? d.created),
    ...(d.ready !== undefined ? { finishedAt: toIso(d.ready) } : {}),
  };
}

type VercelProject = {
  id?: string;
  name?: string;
  framework?: string | null;
  targets?: { production?: { alias?: string[] } };
  link?: { productionBranch?: string };
};

function mapProject(p: VercelProject): ServiceSummary {
  const alias = p.targets?.production?.alias?.[0];
  return {
    id: p.id ?? "",
    name: p.name ?? "",
    ...(alias !== undefined ? { url: `https://${alias}` } : {}),
    ...(p.link?.productionBranch !== undefined ? { branch: p.link.productionBranch } : {}),
    ...(typeof p.framework === "string" ? { runtime: p.framework } : {}),
    suspended: false,
  };
}

export function createVercelAdapter(config: VercelAdapterConfig): ProviderAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = config.fetchImpl ?? fetch;

  const withTeam = (path: string): string =>
    config.teamId === undefined ? path : `${path}${path.includes("?") ? "&" : "?"}teamId=${config.teamId}`;

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${withTeam(path)}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new VercelApiError(response.status, path);
    return response.json();
  }

  return {
    id: "vercel",

    async listServices(): Promise<ServiceSummary[]> {
      const payload = (await request("/v9/projects?limit=50")) as { projects?: VercelProject[] };
      return (payload.projects ?? []).map(mapProject);
    },

    async getService(serviceId: string): Promise<ServiceSummary> {
      return mapProject((await request(`/v9/projects/${serviceId}`)) as VercelProject);
    },

    async getRecentDeploys(serviceId: string, limit = 5): Promise<DeploySummary[]> {
      const payload = (await request(`/v6/deployments?projectId=${serviceId}&limit=${limit}`)) as {
        deployments?: VercelDeployment[];
      };
      return (payload.deployments ?? []).map(mapDeployment);
    },

    async getEnvVarNames(serviceId: string): Promise<EnvVarStatus[]> {
      const payload = (await request(`/v9/projects/${serviceId}/env`)) as {
        envs?: Array<{ key?: string; value?: unknown }>;
      };
      // Values (plain or encrypted) are dropped at this boundary — names only.
      return (payload.envs ?? [])
        .filter((v) => typeof v.key === "string" && v.key.length > 0)
        .map((v) => ({
          name: v.key as string,
          present: v.value === undefined ? true : String(v.value).length > 0,
        }));
    },

    async getLogs(serviceId: string, opts?: { limit?: number }): Promise<LogLine[]> {
      const deploys = await this.getRecentDeploys(serviceId, 1);
      const latest = deploys[0];
      if (latest === undefined) return [];
      const payload = (await request(
        `/v3/deployments/${latest.id}/events?limit=${opts?.limit ?? 50}&builds=1`,
      )) as Array<{ created?: number; text?: string; payload?: { text?: string } }> | { error?: unknown };
      if (!Array.isArray(payload)) return [];
      return payload.map((e) => ({
        ...(e.created !== undefined ? { timestamp: toIso(e.created) } : {}),
        message: e.text ?? e.payload?.text ?? "",
      }));
    },

    async triggerDeploy(serviceId: string, opts?: { clearCache?: boolean; commitId?: string }): Promise<DeploySummary> {
      // Redeploy pattern: source deployment = latest (or the one matching commitId — rollback).
      const recent = await this.getRecentDeploys(serviceId, 20);
      const source =
        opts?.commitId === undefined ? recent[0] : recent.find((d) => d.commit === opts.commitId);
      if (source === undefined) {
        throw new VercelApiError(404, `/v13/deployments (no deployment found${opts?.commitId !== undefined ? ` for commit ${opts.commitId}` : ""})`);
      }
      const project = await this.getService(serviceId);
      const payload = (await request("/v13/deployments?forceNew=1", {
        method: "POST",
        body: JSON.stringify({
          name: project.name,
          deploymentId: source.id,
          target: "production",
        }),
      })) as VercelDeployment;
      return mapDeployment(payload);
    },

    async getDeploy(_serviceId: string, deployId: string): Promise<DeploySummary> {
      return mapDeployment((await request(`/v13/deployments/${deployId}`)) as VercelDeployment);
    },
  };
}
