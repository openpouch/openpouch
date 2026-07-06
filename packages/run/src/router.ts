/**
 * Dynamic-lane routing via the Caddy admin API (localhost :2019).
 *
 * The static lane stays exactly as M1 left it: Caddy's `*.openpouch.sh`
 * `file_server` is never touched. For dynamic apps we maintain ONE route —
 * a host matcher listing every live dynamic slug → `reverse_proxy` to run-d
 * itself (run-d then proxies to the right container, enabling scale-to-zero).
 * The route is prepended (evaluated before the wildcard) and `terminal`.
 *
 * Routes added via the admin API do not survive a Caddy restart, so the
 * orchestrator re-`sync`s on boot (it reconciles containers there anyway).
 * No sudo, no file writes, no reload — see ADR §8(A).
 */

export interface CaddyRouter {
  /**
   * Make the dynamic route match exactly these hostnames. Empty list removes
   * the route entirely (an empty host matcher would match everything).
   */
  sync(hostnames: string[]): Promise<void>;
}

/** No-op router: static-only hosts (tests, or a box without the dynamic lane). */
export class NullRouter implements CaddyRouter {
  async sync(): Promise<void> {
    /* nothing to route */
  }
}

export interface CaddyAdminConfig {
  /** Admin API origin, e.g. "http://127.0.0.1:2019". */
  adminBase: string;
  /** Upstream to dial — run-d's own listen address, e.g. "127.0.0.1:8787". */
  upstream: string;
  /** @id handle for the managed route object. */
  routeId: string;
  fetchImpl?: typeof fetch;
}

export class CaddyAdminRouter implements CaddyRouter {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private serverNameCache: string | undefined;

  constructor(private readonly cfg: CaddyAdminConfig) {
    this.base = cfg.adminBase.replace(/\/$/, "");
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  async sync(hostnames: string[]): Promise<void> {
    const hosts = [...new Set(hostnames.filter((h) => h.length > 0))].sort();
    if (hosts.length === 0) {
      await this.deleteRoute();
      return;
    }
    const route = this.routeObject(hosts);
    if (await this.routeExists()) {
      await this.req("PATCH", `/id/${this.cfg.routeId}`, route);
    } else {
      const server = await this.serverName();
      await this.req("PUT", `/config/apps/http/servers/${server}/routes/0`, route);
    }
  }

  private routeObject(hosts: string[]): Record<string, unknown> {
    return {
      "@id": this.cfg.routeId,
      match: [{ host: hosts }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: this.cfg.upstream }] }],
      terminal: true,
    };
  }

  /**
   * Caddy's admin API enforces an Origin/Host check (anti-DNS-rebinding). Node's
   * fetch otherwise sends an empty Origin → Caddy 403 "origin ''". Sending the
   * admin endpoint itself as the Origin satisfies the check (it's in Caddy's
   * default allowed origins, same as the loopback Host curl relies on).
   */
  private adminHeaders(extra?: Record<string, string>): Record<string, string> {
    return { origin: this.base, ...extra };
  }

  private async routeExists(): Promise<boolean> {
    try {
      const res = await this.doFetch(`${this.base}/id/${this.cfg.routeId}`, { method: "GET", headers: this.adminHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async deleteRoute(): Promise<void> {
    try {
      await this.doFetch(`${this.base}/id/${this.cfg.routeId}`, { method: "DELETE", headers: this.adminHeaders() });
    } catch {
      /* already gone */
    }
  }

  /** Discover the HTTP server that terminates :443 (the TLS vhost). Cached. */
  private async serverName(): Promise<string> {
    if (this.serverNameCache) return this.serverNameCache;
    const res = await this.req("GET", "/config/apps/http/servers");
    const servers = (res ?? {}) as Record<string, { listen?: string[] }>;
    for (const [name, def] of Object.entries(servers)) {
      if ((def.listen ?? []).some((l) => l.endsWith(":443"))) {
        this.serverNameCache = name;
        return name;
      }
    }
    const first = Object.keys(servers)[0];
    if (!first) throw new Error("caddy admin: no http server found to attach the dynamic route");
    this.serverNameCache = first;
    return first;
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: this.adminHeaders(body === undefined ? undefined : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`caddy admin ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
    }
    const text = await res.text();
    return text.length > 0 ? (JSON.parse(text) as unknown) : null;
  }
}
