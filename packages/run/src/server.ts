import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AccountStore } from "./accounts.js";
import { constantTimeEqual, parseBearer } from "./auth.js";
import { classifyUpload } from "./detect.js";
import { DockerEngine, type ContainerEngine } from "./engine.js";
import { WrapperEngine } from "./engine-wrapper.js";
import { DeployFailedError, Orchestrator } from "./orchestrator.js";
import { PortPool } from "./ports.js";
import { probeHttp, proxyRequest, proxyUpgrade } from "./proxy.js";
import { type GithubApi, githubAuthorizeUrl, githubOAuthApi } from "./github.js";
import { type Mailer, type SmtpConfig, createMailer } from "./mailer.js";
import { checkQuota, resolveTier, tiersFromEnv, type TierTable } from "./quota.js";
import { CaddyAdminRouter, type CaddyRouter } from "./router.js";
import { Store } from "./store.js";
import { countFiles, extractTarball } from "./tar.js";

/** M2 dynamic-lane knobs (container runtime + routing). See ADR §8. */
export interface DynamicConfig {
  /** Base image, pre-pulled on the box. */
  image: string;
  /** "uid:gid" the container runs as (default = run-d's own uid so bind-mount writes work). */
  user: string;
  /** Egress-filtered docker network. */
  network: string;
  /** Host port range for published containers. */
  portMin: number;
  portMax: number;
  /** Scale-to-zero: stop a container after this idle time. */
  idleMs: number;
  healthTimeoutMs: number;
  buildTimeoutMs: number;
  /** Max concurrently running dynamic containers (RAM guard). */
  maxRunningDynamic: number;
  /** Caddy admin API origin. */
  caddyAdmin: string;
  /** @id of the managed Caddy route. */
  routeId: string;
  /** Port the app listens on inside the container (PORT env). */
  containerPort: number;
  memory: string;
  cpus: string;
  buildMemory: string;
  buildCpus: string;
  pidsLimit: number;
  /**
   * B1 privilege model. Empty (default) → drive `docker` directly (dev/tests;
   * root-equivalent, only acceptable behind the dormant flag). On the box, set
   * to the sudo-gated wrapper, e.g. "sudo /usr/local/sbin/op-docker", so run-d
   * never touches the Docker socket and cannot inject docker flags. The wrapper
   * owns the hardened profile; the values above apply only to the direct path.
   */
  dockerCmd: string;
}

export interface RunConfig {
  dataDir: string;
  port: number;
  /** Bare domain previews live under, e.g. "openpouch.sh" → <slug>.openpouch.sh. */
  baseDomain: string;
  /** Public origin for claim links, e.g. "https://openpouch.sh". */
  publicBase: string;
  maxBytes: number;
  /** Ceiling on the DECOMPRESSED tarball size (gzip-bomb guard). 0 disables. */
  maxUnpackedBytes: number;
  ratePerHour: number;
  ratePerDay: number;
  /** Global ceiling on concurrent live deployments (disk-exhaustion guard). */
  maxDeployments: number;
  /** Operator token for /api/admin/* (force takedown). Empty disables admin routes. */
  adminToken: string;
  /** Where abuse reports are reachable (shown in 410/abuse copy). */
  abuseContact: string;
  /** M2: run uploaded Node apps in containers. OFF → behaves exactly like M1 (static only). */
  dynamicEnabled: boolean;
  /** Separate, lower ceiling on dynamic deployments (each can pull a large node_modules). */
  maxDynamicDeployments: number;
  dynamic: DynamicConfig;
  /** B3 account subsystem (D16). */
  accounts: AccountConfig;
  /** B3 email delivery over SMTP. Dormant when host is empty (→ OutboxMailer spool). */
  smtp: SmtpConfig;
}

/** B3: account/API-key/quota subsystem (SSOT D16). */
export interface AccountConfig {
  /**
   * Key-gating switch (D16's "anonymous instant lane → key-gated"). Default OFF
   * so the agent-first flow (PRD R5) survives: no key needed to deploy. Flip ON
   * to require an API key for every deploy (abuse lever) — still agent-usable,
   * never a CAPTCHA (R8): keyless requests get a 401 with a create-a-key fix.
   */
  requireKey: boolean;
  /** Tier table (configurable via OPENPOUCH_TIERS_JSON; numbers provisional, D16). */
  tiers: TierTable;
  /** Email-verification token lifetime. */
  verifyTtlMs: number;
  /** Public origin for verification/claim links (defaults to publicBase). */
  publicBase: string;
  /** GitHub OAuth (dormant unless both client id + secret are set). */
  githubClientId: string;
  githubClientSecret: string;
  /** OAuth redirect URI registered with the GitHub app. */
  githubCallbackUrl: string;
  /**
   * DEV ONLY: include the raw email-verification token in the signup HTTP
   * response (so local/dogfood flows work without a real mailer). Never enable
   * in production — the token is a capability secret. Default OFF.
   */
  devExposeTokens: boolean;
}

/** Default container user = run-d's own uid:gid (so it can write the bind-mounted site dir). */
function selfUser(): string {
  const getuid = process.getuid;
  const getgid = process.getgid;
  if (typeof getuid === "function" && typeof getgid === "function") return `${getuid.call(process)}:${getgid.call(process)}`;
  return "";
}

export function configFromEnv(env: Record<string, string | undefined>): RunConfig {
  const baseDomain = env.OPENPOUCH_RUN_BASE_DOMAIN ?? "openpouch.sh";
  const publicBase = env.OPENPOUCH_RUN_PUBLIC_BASE ?? `https://${baseDomain}`;
  const { tiers } = tiersFromEnv(env);
  return {
    dataDir: env.OPENPOUCH_RUN_DATA_DIR ?? "/var/openpouch",
    port: Number(env.OPENPOUCH_RUN_PORT ?? "8787"),
    baseDomain,
    publicBase,
    maxBytes: Number(env.OPENPOUCH_RUN_MAX_BYTES ?? String(25 * 1024 * 1024)),
    maxUnpackedBytes: Number(env.OPENPOUCH_RUN_MAX_UNPACKED_BYTES ?? String(512 * 1024 * 1024)),
    ratePerHour: Number(env.OPENPOUCH_RUN_RATE_HOUR ?? "10"),
    ratePerDay: Number(env.OPENPOUCH_RUN_RATE_DAY ?? "30"),
    maxDeployments: Number(env.OPENPOUCH_RUN_MAX_DEPLOYMENTS ?? "500"),
    adminToken: env.OPENPOUCH_RUN_ADMIN_TOKEN ?? "",
    abuseContact: env.OPENPOUCH_RUN_ABUSE_CONTACT ?? "abuse@openpouch.sh",
    dynamicEnabled: env.OPENPOUCH_RUN_DYNAMIC_ENABLED === "1",
    maxDynamicDeployments: Number(env.OPENPOUCH_RUN_MAX_DYNAMIC ?? "50"),
    dynamic: {
      image: env.OPENPOUCH_RUN_IMAGE ?? "node:22-alpine",
      user: env.OPENPOUCH_RUN_CONTAINER_USER ?? selfUser(),
      network: env.OPENPOUCH_RUN_NETWORK ?? "op-egress",
      portMin: Number(env.OPENPOUCH_RUN_PORT_MIN ?? "20000"),
      portMax: Number(env.OPENPOUCH_RUN_PORT_MAX ?? "20999"),
      idleMs: Number(env.OPENPOUCH_RUN_IDLE_MS ?? String(15 * 60_000)),
      healthTimeoutMs: Number(env.OPENPOUCH_RUN_HEALTH_TIMEOUT_MS ?? "45000"),
      buildTimeoutMs: Number(env.OPENPOUCH_RUN_BUILD_TIMEOUT_MS ?? "120000"),
      maxRunningDynamic: Number(env.OPENPOUCH_RUN_MAX_RUNNING ?? "12"),
      caddyAdmin: env.OPENPOUCH_RUN_CADDY_ADMIN ?? "http://127.0.0.1:2019",
      routeId: env.OPENPOUCH_RUN_ROUTE_ID ?? "openpouch_dynamic",
      containerPort: Number(env.OPENPOUCH_RUN_CONTAINER_PORT ?? "8080"),
      memory: env.OPENPOUCH_RUN_MEM ?? "256m",
      cpus: env.OPENPOUCH_RUN_CPUS ?? "0.5",
      buildMemory: env.OPENPOUCH_RUN_BUILD_MEM ?? "512m",
      buildCpus: env.OPENPOUCH_RUN_BUILD_CPUS ?? "1",
      pidsLimit: Number(env.OPENPOUCH_RUN_PIDS ?? "128"),
      dockerCmd: env.OPENPOUCH_RUN_DOCKER_CMD ?? "",
    },
    accounts: {
      requireKey: env.OPENPOUCH_RUN_REQUIRE_KEY === "1",
      tiers,
      verifyTtlMs: Number(env.OPENPOUCH_RUN_VERIFY_TTL_MS ?? String(24 * 3_600_000)),
      publicBase: env.OPENPOUCH_RUN_ACCOUNT_PUBLIC_BASE ?? publicBase,
      githubClientId: env.OPENPOUCH_RUN_GITHUB_CLIENT_ID ?? "",
      githubClientSecret: env.OPENPOUCH_RUN_GITHUB_CLIENT_SECRET ?? "",
      githubCallbackUrl: env.OPENPOUCH_RUN_GITHUB_CALLBACK_URL ?? `${publicBase}/api/auth/github/callback`,
      devExposeTokens: env.OPENPOUCH_RUN_DEV_TOKENS === "1",
    },
    smtp: {
      host: env.OPENPOUCH_RUN_SMTP_HOST ?? "",
      port: Number(env.OPENPOUCH_RUN_SMTP_PORT ?? "587"),
      user: env.OPENPOUCH_RUN_SMTP_USER ?? "",
      pass: env.OPENPOUCH_RUN_SMTP_PASS ?? "",
      from: env.OPENPOUCH_RUN_SMTP_FROM ?? `openpouch <noreply@${baseDomain}>`,
      secure: env.OPENPOUCH_RUN_SMTP_SECURE === "1",
    },
  };
}

/** In-memory per-IP sliding-window limiter. Process-local — fine for one box. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perHour: number, private readonly perDay: number) {}
  allow(ip: string, now: number): boolean {
    const arr = (this.hits.get(ip) ?? []).filter((t) => now - t < 24 * 3_600_000);
    const lastHour = arr.filter((t) => now - t < 3_600_000).length;
    if (arr.length >= this.perDay || lastHour >= this.perHour) {
      this.hits.set(ip, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(ip, arr);
    return true;
  }
  /** Drop IPs with no hits in the last 24h, so the map can't grow unbounded over
   *  the box's lifetime. Called from the periodic sweep. */
  prune(now: number): void {
    for (const [ip, arr] of this.hits) {
      if (!arr.some((t) => now - t < 24 * 3_600_000)) this.hits.delete(ip);
    }
  }
  /** Number of tracked IPs (introspection / tests). */
  get size(): number {
    return this.hits.size;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Constant-time check of the operator admin token. Empty configured token → the
 * admin surface is disabled (always false). A missing/array header compares as
 * empty → false. Avoids the early-exit timing oracle of a bare `!==`.
 */
function adminTokenMatches(header: string | string[] | undefined, adminToken: string): boolean {
  if (adminToken === "") return false;
  return constantTimeEqual(typeof header === "string" ? header : "", adminToken);
}

export function clientIp(req: IncomingMessage): string {
  // X-Forwarded-For is client-controllable, so the LEFT-most value is spoofable
  // ("X-Forwarded-For: 9.9.9.9" would defeat the per-IP rate limiter by rotating
  // fake IPs, and poison abuse-report attribution). run-d always sits behind our
  // own Caddy, which APPENDS the real peer as the right-most hop — so trust the
  // right-most entry, which the attacker cannot control. Direct (no-proxy) calls
  // have no XFF and fall back to the socket peer.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const hops = xff.split(",");
    const last = hops[hops.length - 1]!.trim();
    if (last.length > 0) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Public view of a record — never leaks the capability tokens. */
function publicRecord(r: ReturnType<Store["get"]>, cfg: RunConfig) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    status: r.status,
    url: `https://${r.slug}.${cfg.baseDomain}`,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    claimed: r.claimed,
  };
}

/**
 * Owner's view for `openpouch list` (B3 self-service). Richer than publicRecord
 * (adds kind + dynamic runtimeStatus so the agent can see what's running) but,
 * like it, NEVER leaks a capability token (claim/mgmt), the accountId, or any
 * container internal (containerId/hostPort/startCmd) — D7.
 */
function ownedRecord(r: NonNullable<ReturnType<Store["get"]>>, cfg: RunConfig) {
  return {
    id: r.id,
    slug: r.slug,
    status: r.status,
    url: `https://${r.slug}.${cfg.baseDomain}`,
    kind: r.kind,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    claimed: r.claimed,
    ...(r.runtimeStatus ? { runtimeStatus: r.runtimeStatus } : {}),
  };
}

/** Injectable collaborators (tests pass fakes; production builds the real ones). */
export interface RunServerDeps {
  engine?: ContainerEngine;
  router?: CaddyRouter;
  probe?: (port: number) => Promise<boolean>;
  log?: (msg: string) => void;
  /** B3: delivers email-verification links (default = OutboxMailer to disk). */
  mailer?: Mailer;
  /** B3: GitHub OAuth (default = real api when configured; tests pass a fake). */
  githubApi?: GithubApi;
}

export interface RunServer {
  server: Server;
  store: Store;
  /** B3: account/API-key/quota registry. */
  accounts: AccountStore;
  config: RunConfig;
  /** Present iff dynamicEnabled — owns the M2 container lifecycle. */
  orchestrator?: Orchestrator;
  /** Run one expiry sweep now (also tears down expired containers/routes). Used by the interval and tests. */
  sweep: (now?: number) => Promise<string[]>;
}

export async function createRunServer(config: RunConfig, deps: RunServerDeps = {}): Promise<RunServer> {
  const store = new Store({ dataDir: config.dataDir });
  await store.init();
  const accounts = new AccountStore({ dataDir: config.dataDir, verifyTtlMs: config.accounts.verifyTtlMs });
  await accounts.init();
  const limiter = new RateLimiter(config.ratePerHour, config.ratePerDay);

  // B3: email delivery — real SMTP mailer when a host is configured, else the disk spool.
  const mailer: Mailer = deps.mailer ?? createMailer({ smtp: config.smtp, dataDir: config.dataDir });

  // B3: GitHub OAuth is dormant unless both client id + secret are configured.
  const githubConfigured = config.accounts.githubClientId !== "" && config.accounts.githubClientSecret !== "";
  const githubApi: GithubApi | undefined =
    deps.githubApi ??
    (githubConfigured
      ? githubOAuthApi({ clientId: config.accounts.githubClientId, clientSecret: config.accounts.githubClientSecret })
      : undefined);
  /** Short-lived OAuth state tokens (CSRF guard), process-local. */
  const oauthStates = new Map<string, number>();
  const OAUTH_STATE_TTL_MS = 10 * 60_000;

  let orchestrator: Orchestrator | undefined;
  if (config.dynamicEnabled) {
    const d = config.dynamic;
    const engine =
      deps.engine ??
      (d.dockerCmd !== ""
        ? // B1: privileged wrapper owns the hardened profile (no Docker socket for run-d).
          new WrapperEngine(d.dockerCmd)
        : new DockerEngine({
            image: d.image,
            user: d.user,
            network: d.network,
            memory: d.memory,
            cpus: d.cpus,
            pidsLimit: d.pidsLimit,
            buildMemory: d.buildMemory,
            buildCpus: d.buildCpus,
            buildTimeoutMs: d.buildTimeoutMs,
            containerPort: d.containerPort,
          }));
    const router = deps.router ?? new CaddyAdminRouter({ adminBase: d.caddyAdmin, upstream: `127.0.0.1:${config.port}`, routeId: d.routeId });
    orchestrator = new Orchestrator({
      store,
      engine,
      router,
      ports: new PortPool(d.portMin, d.portMax),
      probe: deps.probe ?? probeHttp,
      config: { baseDomain: config.baseDomain, idleMs: d.idleMs, healthTimeoutMs: d.healthTimeoutMs, maxRunningDynamic: d.maxRunningDynamic },
      log: deps.log,
    });
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String((err as Error).message) });
    });
  });

  // WebSocket (and other `Upgrade`) handshakes arrive on the server's `upgrade`
  // event, not the request handler — proxy them to the dynamic app's container
  // (waking it from idle if needed). Only dynamic hosts support upgrades; the
  // apex/api and static hosts get the socket closed.
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const dynamic = orchestrator?.dynamicRecordForHost(req.headers.host);
      if (!orchestrator || !dynamic) {
        socket.destroy();
        return;
      }
      try {
        const port = await orchestrator.ensureRunning(dynamic, Date.now());
        proxyUpgrade(req, socket, head, port);
      } catch {
        socket.destroy();
      }
    })();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Dynamic lane (M2): a request whose Host is a dynamic slug is reverse-proxied
    // to that app's container — waking it from idle-stop if needed. Apex/api and
    // static-slug hosts (the latter never reach run-d) fall through to the API below.
    if (orchestrator) {
      const dynamic = orchestrator.dynamicRecordForHost(req.headers.host);
      if (dynamic) {
        try {
          const port = await orchestrator.ensureRunning(dynamic, Date.now());
          proxyRequest(req, res, port, {
            // Container went away mid-flight: same white-label 502 as a wake error.
            onUnavailable: (r, err) => {
              deps.log?.(`502 ${req.headers.host ?? "?"}: ${err?.message ?? "upstream not responding"}`);
              send502Unavailable(r);
            },
          });
        } catch (err) {
          // END CUSTOMER-visible (the app's own URL, failed to wake from idle): a
          // neutral white-label page (D24 / PRD R11) — never openpouch branding nor
          // the internal error detail (D7). The agent debugs via logs/inspect, not
          // this surface, so keep the cause server-side only.
          deps.log?.(`502 ${req.headers.host ?? "?"}: ${(err as Error).message}`);
          send502Unavailable(res);
        }
        return;
      }
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true, service: "openpouch-run" });

    if (method === "GET" && path === "/") {
      // The apex landing (openpouch.sh) is a USER surface — full "built for
      // agents" branding is correct there. But a <slug> subdomain reaching here
      // means an expired/unknown preview fell through the dynamic lane above: to
      // the END CUSTOMER the site is simply gone, so serve a neutral white-label
      // page, never openpouch branding (D24 / PRD R11).
      return isApexHost(req.headers.host, config.baseDomain)
        ? sendHtml(res, 200, landingBody(config), "openpouch 🦘")
        : sendUnavailable(res, 404, "Site unavailable", "This site is no longer available.");
    }

    if (method === "POST" && path === "/api/deployments") return createDeployment(req, res);

    // List the caller's OWN deployments (B3 self-service — `openpouch list`).
    // Key-required: the box can only attribute a deployment to an account, so an
    // anonymous caller has no "owned" set. Returns the secret-free owned view —
    // a key only ever sees its own account's records (no cross-account list).
    if (method === "GET" && path === "/api/deployments") {
      const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
      if (!auth) return sendJson(res, 401, unauthorized());
      return sendJson(res, 200, { ok: true, deployments: store.listOwned(auth.account.id).map((r) => ownedRecord(r, config)) });
    }

    const depMatch = /^\/api\/deployments\/([a-z0-9-]+)(\/logs)?$/.exec(path);
    if (depMatch) {
      const id = depMatch[1]!;
      const isLogs = depMatch[2] === "/logs";
      if (method === "GET" && isLogs) {
        const r = store.get(id);
        if (!r) return sendJson(res, 404, { ok: false, error: "not found" });
        // Multi-tenancy: a deployment owned by an ACCOUNT exposes its captured
        // install/build/app output only to that account's key. A non-owning key —
        // or no key — gets 404 (never leak another account's logs, nor reveal that
        // the slug is keyed). Anonymous deployments have no owner to check and
        // their slug is already public, so their logs stay readable (M1 design).
        if (r.accountId) {
          const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
          if (!auth || auth.account.id !== r.accountId) return sendJson(res, 404, { ok: false, error: "not found" });
        }
        return sendJson(res, 200, { ok: true, logs: r.events });
      }
      if (method === "GET") {
        const r = store.get(id);
        if (!r) return sendJson(res, 404, { ok: false, error: "not found" });
        return sendJson(res, 200, { ok: true, deployment: publicRecord(r, config) });
      }
      if (method === "DELETE") {
        // Two ownership proofs (B3): a valid account key deletes its OWN
        // deployment (owner-checked in store.remove); otherwise the claim/mgmt
        // token (the deploy-then-claim flow). When a key resolves, ONLY the
        // owner-checked path runs — never a fallthrough that could delete another
        // account's (or an anonymous) record.
        const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
        const result = auth
          ? await store.remove(id, { accountId: auth.account.id })
          : await store.remove(id, { mgmtToken: asString((await readJsonBody(req))?.mgmtToken) });
        if (!result.ok) {
          const fix =
            result.reason === "not-owner"
              ? "That deployment isn't on your account — run `openpouch list` to see your own apps."
              : result.reason === "bad-token"
                ? "This deployment is claimed; deleting it needs its management token (or delete it from your own account with `openpouch delete`)."
                : "No deployment by that name — run `openpouch list` to see the exact names.";
          return sendJson(res, result.reason === "not-found" ? 404 : 403, { ok: false, error: result.reason, fix });
        }
        if (orchestrator) await orchestrator.onRemoved([result.record], Date.now());
        return sendJson(res, 200, { ok: true, slug: result.record.slug, kind: result.record.kind });
      }
    }

    const claimMatch = /^\/api\/deployments\/([a-z0-9-]+)\/claim$/.exec(path);
    if (claimMatch && method === "POST") {
      const id = claimMatch[1]!;
      const body = await readJsonBody(req);
      const result = await store.claim(id, asString(body?.token) ?? "", Date.now());
      if (!result.ok) {
        const status = result.reason === "not-found" ? 404 : result.reason === "already-claimed" ? 409 : 403;
        return sendJson(res, status, { ok: false, error: result.reason });
      }
      return sendJson(res, 200, {
        ok: true,
        expiresAt: result.record.expiresAt,
        mgmtToken: result.record.mgmtToken,
      });
    }

    // Abuse report — anyone can flag a preview; appended to reports.jsonl.
    if (method === "POST" && path === "/api/report") {
      if (!limiter.allow(clientIp(req), Date.now())) return sendJson(res, 429, { ok: false, error: "rate limit exceeded" });
      const body = await readJsonBody(req);
      const slug = asString(body?.slug);
      if (!slug) return sendJson(res, 400, { ok: false, error: "missing slug" });
      const entry = {
        at: new Date().toISOString(),
        slug,
        reason: asString(body?.reason)?.slice(0, 500) ?? "",
        reporter: asString(body?.email)?.slice(0, 200) ?? "",
        ip: clientIp(req),
      };
      await appendFile(join(config.dataDir, "reports.jsonl"), `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
      return sendJson(res, 200, { ok: true, message: `report received — abuse contact: ${config.abuseContact}` });
    }

    // Operator force-takedown. Token-gated; also blocked from the public edge in Caddy.
    if (method === "POST" && path === "/api/admin/takedown") {
      if (!adminTokenMatches(req.headers["x-admin-token"], config.adminToken)) {
        return sendJson(res, 403, { ok: false, error: "forbidden" });
      }
      const body = await readJsonBody(req);
      const slug = asString(body?.slug);
      if (!slug) return sendJson(res, 400, { ok: false, error: "missing slug" });
      const result = await store.remove(slug, { force: true });
      if (result.ok && orchestrator) await orchestrator.onRemoved([result.record], Date.now());
      return sendJson(res, result.ok ? 200 : 404, result.ok ? { ok: true, slug } : { ok: false, error: "not-found" });
    }

    // ── B3: account + API-key surface. Every route is agent-usable — no human
    // check, no CAPTCHA (PRD R8). The account anchor is email OR GitHub (D16);
    // the API key is the agent's headless credential.

    // Email signup → pending account + a verification link (delivered by the mailer).
    if (method === "POST" && path === "/api/accounts") {
      if (!limiter.allow(clientIp(req), Date.now())) return sendJson(res, 429, { ok: false, error: "rate limit exceeded" });
      const body = await readJsonBody(req);
      const email = asString(body?.email);
      if (!email) return sendJson(res, 400, { ok: false, error: "missing email" });
      const created = await accounts.createPendingEmail(email, Date.now());
      if (!created.ok) {
        return sendJson(res, created.reason === "invalid-email" ? 400 : 409, { ok: false, error: created.reason });
      }
      const verifyUrl = `${config.accounts.publicBase}/api/accounts/verify?account=${created.account.id}&token=${created.token}`;
      await mailer.sendVerification({ to: email, verifyUrl, accountId: created.account.id });
      return sendJson(res, 201, {
        ok: true,
        accountId: created.account.id,
        message: "check your email for a verification link to activate the account and receive your API key",
        ...(config.accounts.devExposeTokens ? { devVerifyToken: created.token, devVerifyUrl: verifyUrl } : {}),
      });
    }

    // Verify email → activate + issue the first API key (shown once). Token comes
    // from the JSON body (POST, agent flow) or the query (GET, human clicks link).
    if (path === "/api/accounts/verify" && (method === "POST" || method === "GET")) {
      const body = method === "POST" ? await readJsonBody(req) : null;
      const acctId = asString(body?.account) ?? url.searchParams.get("account") ?? "";
      const token = asString(body?.token) ?? url.searchParams.get("token") ?? "";
      const result = await accounts.verifyEmail(acctId, token, Date.now());
      if (!result.ok) {
        const status = result.reason === "not-found" ? 404 : result.reason === "already-active" ? 409 : 403;
        if (method === "GET") return sendHtml(res, status, `<h1>openpouch 🦘</h1><p class="err">Verification failed: ${result.reason}.</p>`);
        return sendJson(res, status, { ok: false, error: result.reason });
      }
      if (method === "GET") return sendHtml(res, 200, keyIssuedBody(result.key, `Account activated`), "openpouch — account activated");
      return sendJson(res, 200, { ok: true, key: result.key, account: accounts.view(result.account) });
    }

    // GitHub OAuth start → redirect to GitHub (503 dormant unless configured).
    if (method === "GET" && path === "/api/auth/github/start") {
      if (!githubApi || !githubConfigured) return sendJson(res, 503, { ok: false, error: "github login not configured" });
      const nowStart = Date.now();
      // Unauthenticated endpoint → rate-limit it (per IP) so it can't be hammered
      // to inflate the in-memory state map; also drop already-expired states now.
      if (!limiter.allow(clientIp(req), nowStart)) return sendJson(res, 429, { ok: false, error: "rate limit exceeded — try later" });
      for (const [s, exp] of oauthStates) if (exp <= nowStart) oauthStates.delete(s);
      const state = randomBytes(16).toString("hex");
      oauthStates.set(state, nowStart + OAUTH_STATE_TTL_MS);
      res.writeHead(302, { location: githubAuthorizeUrl(config.accounts.githubClientId, config.accounts.githubCallbackUrl, state) });
      res.end();
      return;
    }

    // GitHub OAuth callback → exchange code, link/create the account, show the key.
    if (method === "GET" && path === "/api/auth/github/callback") {
      if (!githubApi) return sendJson(res, 503, { ok: false, error: "github login not configured" });
      const state = url.searchParams.get("state") ?? "";
      const exp = oauthStates.get(state);
      if (exp === undefined || exp < Date.now()) return sendHtml(res, 403, `<h1>openpouch 🦘</h1><p class="err">Invalid or expired login state — start again.</p>`);
      oauthStates.delete(state);
      const code = url.searchParams.get("code") ?? "";
      if (!code) return sendHtml(res, 400, `<h1>openpouch 🦘</h1><p class="err">Missing code.</p>`);
      let identity;
      try {
        identity = await githubApi.exchangeCode(code);
      } catch (e) {
        return sendHtml(res, 502, `<h1>openpouch 🦘</h1><p class="err">GitHub sign-in failed: ${escapeHtml((e as Error).message)}</p>`);
      }
      const { key } = await accounts.linkOrCreateGithub(identity.id, identity.login, Date.now());
      return sendHtml(res, 200, keyIssuedBody(key, `Signed in as ${escapeHtml(identity.login)}`), "openpouch — signed in");
    }

    // Account status (whoami): tier, limits, current usage.
    if (method === "GET" && path === "/api/account") {
      const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
      if (!auth) return sendJson(res, 401, unauthorized());
      const tier = resolveTier(config.accounts.tiers, auth.account.tier);
      const owned = store.countOwned(auth.account.id);
      const deploys = accounts.usageWindows(auth.account.id, Date.now());
      const nowMs = Date.now();
      return sendJson(res, 200, {
        ok: true,
        account: accounts.view(auth.account),
        tier,
        usage: {
          liveDeployments: owned.live,
          dynamicDeployments: owned.dynamic,
          deploysLastHour: deploys.filter((t) => nowMs - t < 3_600_000).length,
          deploysLastDay: deploys.length,
        },
      });
    }

    // Mint an additional API key (shown once).
    if (method === "POST" && path === "/api/keys") {
      const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
      if (!auth) return sendJson(res, 401, unauthorized());
      const body = await readJsonBody(req);
      const minted = await accounts.mintKey(auth.account.id, asString(body?.label), Date.now());
      if (!minted.ok) return sendJson(res, 400, { ok: false, error: minted.reason });
      return sendJson(res, 201, { ok: true, key: minted.key, keyId: minted.keyId });
    }

    // List keys (never the secret).
    if (method === "GET" && path === "/api/keys") {
      const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
      if (!auth) return sendJson(res, 401, unauthorized());
      return sendJson(res, 200, { ok: true, keys: accounts.listKeys(auth.account.id) });
    }

    // Revoke a key by its public id.
    const keyMatch = /^\/api\/keys\/([0-9a-f]+)$/.exec(path);
    if (keyMatch && method === "DELETE") {
      const auth = accounts.resolveKey(parseBearer(req.headers.authorization), Date.now());
      if (!auth) return sendJson(res, 401, unauthorized());
      const result = await accounts.revokeKey(auth.account.id, keyMatch[1]!);
      return sendJson(res, result.ok ? 200 : 404, result.ok ? { ok: true } : { ok: false, error: "not-found" });
    }

    // Operator: set an account's tier or status (tier management + abuse suspend).
    const adminAcct = /^\/api\/admin\/accounts\/([a-z0-9_]+)\/(tier|status)$/.exec(path);
    if (adminAcct && method === "POST") {
      if (!adminTokenMatches(req.headers["x-admin-token"], config.adminToken)) {
        return sendJson(res, 403, { ok: false, error: "forbidden" });
      }
      const acctId = adminAcct[1]!;
      const body = await readJsonBody(req);
      if (adminAcct[2] === "tier") {
        const tier = asString(body?.tier);
        if (!tier || !config.accounts.tiers[tier]) return sendJson(res, 400, { ok: false, error: "unknown tier" });
        const r = await accounts.setTier(acctId, tier);
        return sendJson(res, r.ok ? 200 : 404, r.ok ? { ok: true, accountId: acctId, tier } : { ok: false, error: "not-found" });
      }
      const status = asString(body?.status);
      if (status !== "active" && status !== "suspended") return sendJson(res, 400, { ok: false, error: "status must be active|suspended" });
      const r = await accounts.setStatus(acctId, status);
      return sendJson(res, r.ok ? 200 : 404, r.ok ? { ok: true, accountId: acctId, status } : { ok: false, error: "not-found" });
    }

    // Claim landing page (apex is proxied here by Caddy).
    const claimPage = /^\/claim\/([a-z0-9-]+)$/.exec(path);
    if (claimPage && method === "GET") {
      const r = store.get(claimPage[1]!);
      if (!r) return sendHtml(res, 404, `<h1>openpouch 🦘</h1><p>This preview is gone or never existed (unclaimed previews vanish after 72h).</p>`);
      return sendHtml(res, 200, claimBody(r, config), "Claim your openpouch preview");
    }

    return sendJson(res, 404, { ok: false, error: "no such route" });
  }

  function parseEnvHeader(req: IncomingMessage): Record<string, string> | undefined {
    // The app's env vars/secrets, base64(JSON) in x-openpouch-env. Validated
    // defense-in-depth (the CLI validates too); the VALUES are NEVER logged (D7).
    const h = req.headers["x-openpouch-env"];
    if (typeof h !== "string" || h === "") return undefined;
    let obj: unknown;
    try {
      obj = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const out: Record<string, string> = {};
    let bytes = 0;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      bytes += k.length + v.length + 2;
      if (Object.keys(out).length >= 50 || bytes > 4096) break;
      out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function createDeployment(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = Date.now();
    const ip = clientIp(req);

    // B3: an API key (if present) lifts the caller into its account tier. No
    // Authorization header = the anonymous tier, bounded by the per-IP limiter +
    // global caps below — deploying still needs no setup (PRD R5).
    const bearer = parseBearer(req.headers.authorization);
    const auth = bearer ? accounts.resolveKey(bearer, now) : null;
    // A credential was presented but doesn't resolve (invalid / revoked /
    // suspended account) → 401, never a silent downgrade to anonymous.
    if (bearer && !auth) {
      return sendJson(res, 401, {
        ok: false,
        error: "invalid, revoked, or suspended API key",
        fix: "Check OPENPOUCH_API_KEY / ~/.openpouch/openpouch-run.key, or run `openpouch signup` for a new key.",
      });
    }
    // `requireKey` (default off) can gate the whole lane behind a key (abuse
    // lever); even then it is a 401 with a create-a-key fix, never a CAPTCHA (R8).
    if (config.accounts.requireKey && !auth) {
      return sendJson(res, 401, {
        ok: false,
        error: "an API key is required on this instance",
        fix: "Create one: POST /api/accounts (email) or GET /api/auth/github/start, then send Authorization: Bearer <key>.",
      });
    }
    if (!auth && !limiter.allow(ip, now)) {
      return sendJson(res, 429, { ok: false, error: "rate limit exceeded — try later" });
    }
    let body: Buffer;
    try {
      body = await readBody(req, config.maxBytes);
    } catch (err) {
      return sendJson(res, (err as { statusCode?: number }).statusCode ?? 400, {
        ok: false,
        error: (err as Error).message,
      });
    }
    if (body.length === 0) return sendJson(res, 400, { ok: false, error: "empty body — send a gzipped tarball" });

    // Global ceiling: protect the box from disk exhaustion even within rate limits.
    if (store.list().length >= config.maxDeployments) {
      return sendJson(res, 503, { ok: false, error: "instant lane at capacity — try again later" });
    }

    const hintHeader = req.headers["x-openpouch-project"];
    const hint = typeof hintHeader === "string" ? hintHeader : undefined;
    const appEnv = parseEnvHeader(req); // env vars for a dynamic app (D7: values never logged)

    // Extract into a temp dir first, then atomically move to the slug dir.
    const tmpDir = join(store.sitesDir, `.tmp-${randomBytes(8).toString("hex")}`);
    await mkdir(tmpDir, { recursive: true });
    let fileCount: number;
    try {
      await extractTarball(body, tmpDir, { maxUnpackedBytes: config.maxUnpackedBytes });
      fileCount = await countFiles(tmpDir);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      return sendJson(res, 400, { ok: false, error: `extract failed: ${(err as Error).message}` });
    }
    if (fileCount === 0) {
      await rm(tmpDir, { recursive: true, force: true });
      return sendJson(res, 400, { ok: false, error: "tarball contained no files" });
    }

    // M2: decide static vs dynamic. With the dynamic lane off, every upload is static (M1 behaviour).
    const classification = config.dynamicEnabled ? await classifyUpload(tmpDir) : { kind: "static" as const };
    const isDynamic = classification.kind === "dynamic";

    // B3: per-account quota for keyed deploys (rate, concurrency, size). Anonymous
    // traffic is bounded by the per-IP limiter (above) + the global caps (below).
    if (auth) {
      const owned = store.countOwned(auth.account.id);
      const verdict = checkQuota(
        resolveTier(config.accounts.tiers, auth.account.tier),
        { recentDeploys: accounts.usageWindows(auth.account.id, now), liveCount: owned.live, dynamicCount: owned.dynamic },
        { now, bytes: body.length, dynamic: isDynamic },
      );
      if (!verdict.ok) {
        await rm(tmpDir, { recursive: true, force: true });
        return sendJson(res, verdict.status, { ok: false, error: verdict.message, fix: verdict.fix, reason: verdict.reason });
      }
    }

    // Dynamic deployments get their own, lower ceiling (each can pull a large node_modules).
    if (isDynamic && store.list().filter((r) => r.kind === "dynamic").length >= config.maxDynamicDeployments) {
      await rm(tmpDir, { recursive: true, force: true });
      return sendJson(res, 503, { ok: false, error: "dynamic lane at capacity — try again later" });
    }

    // A static-build upload is served as files once built → its record kind is "static".
    const recordKind = classification.kind === "dynamic" ? "dynamic" : "static";
    const record = await store.create({ hint, bytes: body.length, fileCount, now, kind: recordKind, ...(auth ? { accountId: auth.account.id } : {}) });
    if (auth) await accounts.recordDeploy(auth.account.id, now);
    await rename(tmpDir, store.siteDir(record.slug));

    if (classification.kind === "dynamic" && orchestrator) {
      try {
        await orchestrator.deployDynamic(record, classification, store.siteDir(record.slug), appEnv);
      } catch (err) {
        await store.remove(record.id, { force: true });
        const logs = err instanceof DeployFailedError ? err.logs : "";
        return sendJson(res, 422, { ok: false, error: `dynamic deploy failed: ${(err as Error).message}`, logs: logs.slice(0, 4000) });
      }
    } else if (classification.kind === "static-build" && orchestrator) {
      // Unbuilt static SPA: build it, then serve the build output as files (L9).
      try {
        await orchestrator.buildStatic(record, classification, store.siteDir(record.slug));
      } catch (err) {
        await store.remove(record.id, { force: true });
        const logs = err instanceof DeployFailedError ? err.logs : "";
        return sendJson(res, 422, { ok: false, error: `static build failed: ${(err as Error).message}`, logs: logs.slice(0, 4000) });
      }
    }

    return sendJson(res, 201, {
      ok: true,
      id: record.id,
      slug: record.slug,
      url: `https://${record.slug}.${config.baseDomain}`,
      claimUrl: `${config.publicBase}/claim/${record.id}?token=${record.claimToken}`,
      claimToken: record.claimToken,
      expiresAt: record.expiresAt,
      status: record.status,
      kind: record.kind,
    });
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readBody(req, 64 * 1024);
      if (raw.length === 0) return null;
      const parsed = JSON.parse(raw.toString("utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return {
    server,
    store,
    accounts,
    config,
    orchestrator,
    sweep: async (now = Date.now()): Promise<string[]> => {
      const removed = await store.sweepExpired(now);
      if (orchestrator) await orchestrator.onRemoved(removed, now);
      // Bound the in-memory maps over the box's lifetime (cheap, runs every 5 min).
      limiter.prune(now);
      for (const [state, exp] of oauthStates) if (exp <= now) oauthStates.delete(state);
      return removed.map((r) => r.slug);
    },
  };
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  color:#1a1a2e;background:#faf8f5;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:2rem}
@media(prefers-color-scheme:dark){body{color:#ece8f0;background:#15131c}code,pre{background:#241f30!important}}
.card{max-width:42rem;width:100%}
h1{font-size:2rem;margin:0 0 .25rem}
.tag{color:#8a7fa8;font-size:.95rem;margin:0 0 1.5rem}
pre{background:#efe9e2;padding:1rem 1.25rem;border-radius:.6rem;overflow:auto;font-size:.95rem}
pre.key{white-space:pre-wrap;word-break:break-all;user-select:all;-webkit-user-select:all}
code{background:#efe9e2;padding:.1rem .35rem;border-radius:.3rem;font-size:.9em}
pre code{background:none;padding:0}
a{color:#6c4ad6;font-weight:600}
.muted{color:#8a7fa8;font-size:.9rem}
button{font:inherit;font-weight:600;background:#6c4ad6;color:#fff;border:0;border-radius:.5rem;padding:.6rem 1.2rem;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.ok{color:#2f9e44;font-weight:600}.err{color:#e03131;font-weight:600}
`;

function pageShell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title><style>${STYLE}</style></head><body><div class="card">${inner}</div></body></html>`;
}

function landingBody(cfg: RunConfig): string {
  return `<h1>openpouch 🦘</h1>
<p class="tag">We never ask if you're human.</p>
<p>Agent-native hosting: deploy any folder to a live URL in one command. No account, no dashboard, no CAPTCHA. The agent deploys; your human claims the link.</p>
<pre><code>npx openpouch deploy</code></pre>
<p class="muted">You get a <code>*.${cfg.baseDomain}</code> preview + a claim link. Unclaimed previews vanish after 72&nbsp;hours.</p>
<p>Open source · built for agents, not walled against them → <a href="https://github.com/openpouch/openpouch">github.com/openpouch/openpouch</a></p>`;
}

function claimBody(record: NonNullable<ReturnType<Store["get"]>>, cfg: RunConfig): string {
  const url = `https://${record.slug}.${cfg.baseDomain}`;
  if (record.claimed) {
    return `<h1>openpouch 🦘</h1><p>Preview <a href="${url}">${record.slug}.${cfg.baseDomain}</a></p>
<p class="ok">✓ Already claimed.</p><p class="muted">Expires ${record.expiresAt}.</p>`;
  }
  // Token comes from the ?token= query param; the button POSTs it to the claim API.
  return `<h1>Claim this preview 🦘</h1>
<p>Preview <a href="${url}">${record.slug}.${cfg.baseDomain}</a></p>
<p class="muted">Claiming extends it to 7 days and returns a management token (to delete it later).</p>
<p><button id="b" onclick="claim()">Claim preview</button></p>
<p id="out" class="muted"></p>
<script>
async function claim(){
  var b=document.getElementById('b'),out=document.getElementById('out');
  var token=new URLSearchParams(location.search).get('token');
  if(!token){out.innerHTML='<span class="err">Missing claim token in the link.</span>';return}
  b.disabled=true;out.textContent='Claiming…';
  try{
    var r=await fetch('${cfg.publicBase}/api/deployments/${record.id}/claim',
      {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token})});
    var d=await r.json();
    if(d.ok){out.innerHTML='<span class="ok">✓ Claimed until '+d.expiresAt+'.</span><br><span class="muted">Management token (save it): <code>'+d.mgmtToken+'</code></span>'}
    else{out.innerHTML='<span class="err">Could not claim: '+(d.error||r.status)+'</span>';b.disabled=false}
  }catch(e){out.innerHTML='<span class="err">Network error.</span>';b.disabled=false}
}
</script>`;
}

/** Standard 401 body for the account routes — agent-readable, with a fix (R8). */
function unauthorized() {
  return {
    ok: false,
    error: "invalid or missing API key",
    fix: "Send Authorization: Bearer <key>. Create one via POST /api/accounts (email) or GET /api/auth/github/start.",
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The "here is your key, shown once" page body (email verify + GitHub callback).
 * The key is shown exactly once, so the surface must make it trivially copyable —
 * especially on mobile / in-app mail browsers, where a horizontally-scrolling
 * `<pre>` truncates the key and can't be selected. So: the key box WRAPS
 * (`pre.key`, `user-select:all` = one tap selects the whole key) and a Copy
 * button uses the async clipboard API with a select-the-node fallback. The button
 * reads the key from the DOM (`textContent`) rather than an inlined JS literal, so
 * no secret is interpolated into script.
 */
function keyIssuedBody(key: string, heading: string): string {
  return `<h1>openpouch 🦘</h1>
<p class="ok">✓ ${heading}.</p>
<p>Your API key — <strong>save it now, it is shown only once</strong>:</p>
<pre class="key"><code id="opkey">${escapeHtml(key)}</code></pre>
<p><button type="button" id="copy">Copy key</button> <span id="copied" class="ok" hidden>✓ Copied to clipboard</span></p>
<p class="muted">Give it to your agent as <code>OPENPOUCH_API_KEY</code> or write it to <code>~/.openpouch/openpouch-run.key</code> (chmod 600). The agent then deploys against your account's quota.</p>
<script>
(function(){
  var btn=document.getElementById('copy'),code=document.getElementById('opkey'),ok=document.getElementById('copied');
  if(!btn||!code)return;
  function flash(){if(ok)ok.hidden=false;btn.textContent='Copied';}
  function selectKey(){try{var r=document.createRange();r.selectNodeContents(code);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}catch(e){}}
  btn.addEventListener('click',function(){
    var t=code.textContent||'';
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(flash,function(){selectKey();try{document.execCommand('copy');flash();}catch(e){}});
    }else{selectKey();try{document.execCommand('copy');flash();}catch(e){}}
  });
})();
</script>`;
}

function sendHtml(res: ServerResponse, status: number, bodyInner: string, title = "openpouch"): void {
  const doc = pageShell(title, bodyInner);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(doc);
}

/** True when the inbound Host is the bare apex (e.g. openpouch.sh / www.openpouch.sh)
 *  — a USER-facing surface — rather than a <slug>.openpouch.sh preview host that
 *  an END CUSTOMER opens. Used to decide branded landing vs. white-label page. */
function isApexHost(host: string | undefined, baseDomain: string): boolean {
  if (!host) return false;
  const h = host.split(":")[0]!.toLowerCase();
  const base = baseDomain.toLowerCase();
  return h === base || h === `www.${base}`;
}

/** A neutral, white-label page for END CUSTOMER-visible failures (an expired
 *  preview, or the app's container being down). It must read like any generic web
 *  server's error page: NO openpouch/agent branding, NO brand colours, NO internal
 *  error detail (D7), and NO `noindex` that would reveal the site is temporary
 *  (D24 / PRD R11). The running app is reverse-proxied and never passes through
 *  here, so it keeps its own headers untouched. */
function unavailablePage(heading: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title>
<style>html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fff;color:#1a1a1a}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}
main{padding:2rem;max-width:30rem}h1{font-size:1.5rem;font-weight:600;margin:0 0 .5rem}
p{margin:0;color:#555;line-height:1.5}</style></head>
<body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`;
}

function sendUnavailable(res: ServerResponse, status: number, heading: string, detail: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(unavailablePage(heading, detail));
}

/** END CUSTOMER-visible 502 (D24 / PRD R11): neutral, white-label, no internal
 *  detail. Both failure paths — a failed idle-wake and an unreachable container
 *  (proxy `onUnavailable`) — funnel here so the surface stays identical. */
function send502Unavailable(res: ServerResponse): void {
  sendUnavailable(res, 502, "Site temporarily unavailable", "This site is temporarily unavailable. Please try again in a few moments.");
}
