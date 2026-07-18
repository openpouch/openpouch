import type { DeploySummary, EnvVarStatus, LogLine, ProviderAdapter, ServiceSummary } from "@openpouch/core";

/**
 * Adapter for the openpouch instant lane (openpouch-run). Unlike Render/Vercel
 * (git-backed, existing services), the instant lane uploads a tarball and gets
 * an ephemeral preview back — so this adapter adds `instantDeploy` on top of the
 * standard ProviderAdapter read surface, plus the account/API-key surface (B3).
 *
 * Auth is OPTIONAL (PRD R5/R8): with no key, deploys are anonymous (deploy-then-
 * claim). With an openpouch API key, the same calls carry `Authorization:
 * Bearer <key>` and run under the account's quota tier.
 */

export type ErrorCategory = "auth" | "provider" | "quota" | "network";

/**
 * Thrown when the openpouch API could not be REACHED at all (DNS/refused/
 * timeout/TLS) — as opposed to an HTTP error the server answered with. Carries
 * the target host + the transport cause, so an agent can tell "the network is
 * blocked/down" apart from "something is wrong with my app or account"
 * (Codex 2026-07-04: a bare `fetch failed` under category "provider" with a
 * generic re-run fix was undiagnosable in a sandboxed environment).
 */
export class RunNetworkError extends Error {
  readonly category = "network" as const;
  readonly fix: string;
  constructor(base: string, causeCode: string) {
    let host = base;
    try {
      host = new URL(base).host;
    } catch {
      // keep base as-is
    }
    super(`openpouch API unreachable (${host}): ${causeCode}`);
    this.name = "RunNetworkError";
    this.fix =
      `The request never reached ${host} — a network/DNS/firewall problem (or a sandbox without egress), ` +
      `NOT a problem with your app or account. Check connectivity first (e.g. \`curl -sS https://${host}/healthz\`); ` +
      `if that fails too, fix the environment's network/proxy or deploy from one that allows HTTPS egress to ${host}, then re-run.`;
  }
}

/** Map a fetch rejection to a short human cause ("DNS lookup failed", "connection refused", …). */
function networkCauseCode(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? err.name;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "DNS lookup failed";
    case "ECONNREFUSED":
      return "connection refused";
    case "ECONNRESET":
      return "connection reset";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "AbortError":
    case "TimeoutError":
      return "connection timed out";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "TLS certificate problem";
    default:
      return err.cause?.code ?? err.cause?.message ?? err.message ?? "network failure";
  }
}

export class RunApiError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly fix: string;
  /** Build/startup output the server captured for a failed deploy (422 body
   *  carries up to 4000 chars) — the agent's self-repair loop needs the CAUSE
   *  in hand, because the failed record is removed server-side and cannot be
   *  fetched via `logs` afterwards (OpenClaw suite run 2026-07-05, P1). */
  readonly serverLogs?: string;
  constructor(status: number, detail: string, fix?: string, serverLogs?: string, anonymous?: boolean) {
    const category: ErrorCategory = status === 401 ? "auth" : status === 429 || status === 413 ? "quota" : "provider";
    super(`openpouch-run ${status}: ${detail}`);
    this.name = "RunApiError";
    this.status = status;
    this.category = category;
    if (serverLogs !== undefined && serverLogs.trim() !== "") this.serverLogs = serverLogs;
    // Context-specific guidance beats the generic service-status line: a build/
    // start failure is the APP's problem (act on the captured output), and an
    // empty upload is the CALLER's input — neither is a platform outage
    // (OpenClaw suite run 2026-07-05: the generic expiry fix sent the agent
    // debugging in the wrong direction on both).
    // Quota guidance splits on auth context: `list`/`delete` self-service only
    // exists for accounts — an anonymous caller's only real options are waiting
    // out the ~72h expiry or signing up (Hermes suite run 2026-07-05: the
    // account-flavoured fix left an anonymous agent without an actionable path).
    this.fix =
      fix ??
      (category === "auth"
        ? "Your openpouch API key is missing, invalid, or revoked — run `openpouch signup` to get one, or check OPENPOUCH_API_KEY / ~/.openpouch/openpouch-run.key."
        : category === "quota"
          ? anonymous
            ? "A limit was reached. You're deploying anonymously, and anonymous previews can't be deleted manually — each one frees its slot on its own when it expires (~72h after deploy). Either wait for a slot to roll off, or create an account to manage slots yourself: `openpouch signup --email you@example.com` (or `--github`), then `openpouch list` + `openpouch delete <slug>` free one immediately (account tiers also raise the limit)."
            : "A limit was reached. If you have an openpouch account you can free a slot yourself: `openpouch list` shows your apps, then `openpouch delete <slug>` removes one. (Previews are also ephemeral (~72h) and roll off on their own; `openpouch whoami` shows your usage; a higher tier raises the limit.)"
          : /dynamic deploy failed|static build failed/.test(detail)
            ? "Your app failed while building or starting on the server — the captured output is included in this error. Fix the cause it shows, then rerun the same deploy command (each redeploy gets a fresh URL)."
            : /no files/i.test(detail)
              ? "The uploaded folder contained no deployable files. Point the deploy at a folder with content — an index.html (static site) or a package.json project — then rerun."
              : "Check the openpouch-run service status; the deployment may have expired (72h unclaimed).");
  }
}

/** Account status as returned by GET /api/account (whoami). */
/** B4 (staged): hosted-checkout link for a paid tier — payment stays a human moment. */
export interface CheckoutResult {
  ok: boolean;
  plan: string;
  founderPricing: boolean;
  checkoutUrl: string;
  summary: string;
  availablePlans?: string[];
}

export interface AccountStatus {
  account: { id: string; status: string; tier: string; identities: Array<{ kind: string; value: string; label?: string }>; createdAt: string };
  tier: { name: string; deploysPerHour: number; deploysPerDay: number; maxLiveDeployments: number; maxBytes: number; maxDynamic: number };
  usage: { liveDeployments: number; dynamicDeployments: number; deploysLastHour: number; deploysLastDay: number };
}

export interface SignupResult {
  accountId: string;
  message: string;
  /** Present only when the server runs with devExposeTokens (local/dogfood). */
  devVerifyToken?: string;
  devVerifyUrl?: string;
}

export interface VerifyResult {
  key: string;
  account: AccountStatus["account"];
}

export interface InstantDeployResult {
  id: string;
  slug: string;
  url: string;
  /** Who the deployment belongs to. Absent on run-d ≤0.3.0 (version skew: the
   *  CLI then keeps the anonymous/claim story, which is what that server does). */
  ownership?: "anonymous" | "account";
  /** "fixed" = expiresAt is a hard deadline (anonymous/claimed); "rolling-while-used"
   *  = expiresAt moves forward on every request (account-owned, D25). */
  expiryPolicy?: "fixed" | "rolling-while-used";
  /** Present only on anonymous deploys — an account-owned deploy is already
   *  saved, so there is nothing to claim (Codex F-01, 2026-07-12). */
  claimUrl?: string;
  claimToken?: string;
  expiresAt: string;
  status: DeploySummary["status"];
  /** static = files served by the edge; dynamic = a Node app running in a container (M2). */
  kind?: "static" | "dynamic";
  /** L12: named-app identity — redeploys with the same app update it behind a stable URL. */
  app?: string;
  /** L12: true when this deploy UPDATED the named app in place (same slug/URL). */
  updated?: boolean;
}

/** An account's own deployment as returned by GET /api/deployments (`openpouch list`). Secret-free. */
export interface OwnedDeployment {
  id: string;
  slug: string;
  status: "live" | "expired";
  url: string;
  kind?: "static" | "dynamic";
  createdAt: string;
  expiresAt: string;
  claimed: boolean;
  /** Dynamic only: container lifecycle state. */
  runtimeStatus?: string;
}

export interface RunAdapterConfig {
  /** Origin of the run-d API, e.g. "https://openpouch.sh". */
  apiBase: string;
  /** Optional openpouch API key — sent as Bearer on deploys + account calls (B3). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface RunAdapter extends ProviderAdapter {
  /** Instant-lane primitive: upload a gzipped tarball, get an ephemeral preview.
   *  `env` (optional) carries the deployed app's env vars/secrets — sent in a
   *  header, never the body/URL; values must never be logged (D7). */
  instantDeploy(tarball: Uint8Array, opts?: { projectHint?: string; env?: Record<string, string>; volume?: boolean; alwaysOn?: boolean; app?: string }): Promise<InstantDeployResult>;
  /** Account status for the configured key (B3). Throws RunApiError(401) without a valid key. */
  whoami(): Promise<AccountStatus>;
  /** Start an email signup → pending account + a verification link is emailed. */
  signupEmail(email: string): Promise<SignupResult>;
  /** Complete an email signup → activates the account, returns the first API key (once). */
  verifyEmail(accountId: string, token: string): Promise<VerifyResult>;
  /** The browser URL to start GitHub signup. */
  githubStartUrl(): string;
  /** List the account's own live deployments (B3 self-service). Throws RunApiError(401) without a valid key. */
  listDeployments(): Promise<OwnedDeployment[]>;
  /** Delete one of the account's own deployments by slug → frees a quota slot. Throws RunApiError(401 no key / 403 not owner / 404 unknown). */
  deleteDeployment(slug: string): Promise<{ slug: string; kind?: string }>;
  /** L13 data channel: replace a named app's /data volume with the tarball's contents (owner-only; container stop-write-restart). */
  dataPush(app: string, tarball: Uint8Array): Promise<{ app: string; files: number; restarted: boolean; warning?: string }>;
  /** L13: download a named app's /data volume as a gzipped tarball (the backup primitive). */
  dataPull(app: string): Promise<Uint8Array>;
  /** L13: list a named app's /data volume contents — names/sizes/mtimes only. */
  dataList(app: string): Promise<{ app: string; files: Array<{ path: string; bytes: number; mtime: string }>; totalBytes: number }>;
  /** B4 (staged): mint a hosted-checkout URL for a paid tier — the human pays in the browser at the MoR. Throws RunApiError(401 no key / 400 unknown plan / 503 billing disabled). */
  createCheckout(plan: string): Promise<CheckoutResult>;
}

interface RunDeploymentDTO {
  id: string;
  slug: string;
  status: DeploySummary["status"];
  url: string;
  createdAt: string;
  expiresAt: string;
  claimed: boolean;
}

export function createRunAdapter(config: RunAdapterConfig): RunAdapter {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.apiBase.replace(/\/$/, "");
  const authHeader: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};

  async function rawApi(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        ...init,
        headers: { ...authHeader, ...(init?.headers as Record<string, string> | undefined) },
      });
    } catch (e) {
      // fetch REJECTED → the request never got an HTTP answer. Surface it as a
      // classified network error (target + cause), not a generic "fetch failed".
      throw new RunNetworkError(base, networkCauseCode(e));
    }
    if (!res.ok) {
      let detail = res.statusText;
      let fix: string | undefined;
      let serverLogs: string | undefined;
      try {
        const body = (await res.json()) as { error?: string; fix?: string; logs?: string };
        if (body.error) detail = body.error;
        if (body.fix) fix = body.fix;
        // A failed build/start 422 ships the captured output — keep it (self-repair).
        if (typeof body.logs === "string") serverLogs = body.logs;
      } catch {
        // non-JSON error body
      }
      throw new RunApiError(res.status, detail, fix, serverLogs, !config.apiKey);
    }
    return res;
  }

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    return (await rawApi(path, init)).json();
  }

  function dataPath(app: string): string {
    return `/api/apps/${encodeURIComponent(app)}/data`;
  }

  function toDeploy(d: RunDeploymentDTO): DeploySummary {
    return {
      id: d.id,
      status: d.status,
      createdAt: d.createdAt,
      ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
    };
  }

  return {
    id: "openpouch-run",
    // The box API can't be asked for runtime env vars (privacy by design) —
    // inspect must not render our empty getEnvVarNames() as "no env vars".
    envIntrospection: "unavailable",

    async instantDeploy(tarball, opts) {
      const headers: Record<string, string> = { "content-type": "application/gzip" };
      if (opts?.projectHint) headers["x-openpouch-project"] = opts.projectHint;
      if (opts?.volume) headers["x-openpouch-volume"] = "1";
      if (opts?.alwaysOn) headers["x-openpouch-always-on"] = "1";
      // L12: named-app identity — same (account, app) updates behind a stable URL.
      if (opts?.app) headers["x-openpouch-app"] = opts.app;
      // Env vars / secrets ride in a header as base64(JSON) — never the body or the
      // URL. HTTPS protects them in transit; run-d injects them into the container
      // and must never log this header (D7).
      if (opts?.env && Object.keys(opts.env).length > 0) {
        headers["x-openpouch-env"] = Buffer.from(JSON.stringify(opts.env), "utf8").toString("base64");
      }
      // Node's fetch accepts a Uint8Array body at runtime; the DOM lib types are narrower.
      const body = (await api("/api/deployments", { method: "POST", headers, body: tarball as unknown as BodyInit })) as InstantDeployResult;
      return body;
    },

    async createCheckout(plan: string): Promise<CheckoutResult> {
      return (await api("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      })) as CheckoutResult;
    },

    async whoami(): Promise<AccountStatus> {
      return (await api("/api/account")) as AccountStatus;
    },

    async listDeployments(): Promise<OwnedDeployment[]> {
      const { deployments } = (await api("/api/deployments")) as { deployments: OwnedDeployment[] };
      return deployments;
    },

    async deleteDeployment(slug: string): Promise<{ slug: string; kind?: string }> {
      const body = (await api(`/api/deployments/${slug}`, { method: "DELETE" })) as { slug: string; kind?: string };
      return { slug: body.slug, ...(body.kind ? { kind: body.kind } : {}) };
    },

    async dataPush(app: string, tarball: Uint8Array): Promise<{ app: string; files: number; restarted: boolean; warning?: string }> {
      // Contents are customer data (D7): they travel in the body over HTTPS and
      // are never logged on either side.
      return (await api(dataPath(app), {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: tarball as unknown as BodyInit,
      })) as { app: string; files: number; restarted: boolean; warning?: string };
    },

    async dataPull(app: string): Promise<Uint8Array> {
      const res = await rawApi(dataPath(app));
      return new Uint8Array(await res.arrayBuffer());
    },

    async dataList(app: string): Promise<{ app: string; files: Array<{ path: string; bytes: number; mtime: string }>; totalBytes: number }> {
      return (await api(`${dataPath(app)}?list=1`)) as {
        app: string;
        files: Array<{ path: string; bytes: number; mtime: string }>;
        totalBytes: number;
      };
    },

    async signupEmail(email: string): Promise<SignupResult> {
      return (await api("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      })) as SignupResult;
    },

    async verifyEmail(accountId: string, token: string): Promise<VerifyResult> {
      return (await api("/api/accounts/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: accountId, token }),
      })) as VerifyResult;
    },

    githubStartUrl(): string {
      return `${base}/api/auth/github/start`;
    },

    async listServices(): Promise<ServiceSummary[]> {
      // The instant lane has no "list all" surface; services are addressed by id (slug).
      return [];
    },

    async getService(serviceId: string): Promise<ServiceSummary> {
      const { deployment } = (await api(`/api/deployments/${serviceId}`)) as { deployment: RunDeploymentDTO };
      return { id: deployment.slug, name: deployment.slug, url: deployment.url };
    },

    async getRecentDeploys(serviceId: string): Promise<DeploySummary[]> {
      const { deployment } = (await api(`/api/deployments/${serviceId}`)) as { deployment: RunDeploymentDTO };
      return [toDeploy(deployment)];
    },

    async getEnvVarNames(): Promise<EnvVarStatus[]> {
      // Deliberately empty: the box never exposes env var names/values via the
      // API (the deployment GET is reachable without auth — even NAMES can leak
      // intent, e.g. STRIPE_SECRET_KEY). The names passed at deploy time are
      // recorded client-side in deploy.evidence.json (`envVarNames`) and shown
      // by `openpouch inspect` as `deployProvided`. `envIntrospection:
      // "unavailable"` (below) tells consumers this [] means "cannot look",
      // not "none exist" (OpenClaw 2026-07-05 #2).
      return [];
    },

    async getLogs(serviceId: string, opts?: { limit?: number }): Promise<LogLine[]> {
      const { logs } = (await api(`/api/deployments/${serviceId}/logs`)) as { logs: LogLine[] };
      return opts?.limit ? logs.slice(-opts.limit) : logs;
    },

    triggerDeploy(): Promise<DeploySummary> {
      // Each instant deploy is fresh content, not a redeploy of an existing service.
      throw new RunApiError(400, "the instant lane has no redeploy primitive — use `openpouch deploy` (instantDeploy)");
    },

    async getDeploy(_serviceId: string, deployId: string): Promise<DeploySummary> {
      const { deployment } = (await api(`/api/deployments/${deployId}`)) as { deployment: RunDeploymentDTO };
      return toDeploy(deployment);
    },
  };
}
