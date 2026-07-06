import { randomBytes } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DynamicPlan, StaticBuildPlan } from "./detect.js";
import type { ContainerEngine } from "./engine.js";
import type { PortPool } from "./ports.js";
import type { CaddyRouter } from "./router.js";
import type { DeploymentRecord, Store } from "./store.js";
import { makeWorldReadable } from "./tar.js";

/** Thrown when a dynamic deploy cannot be built/started; carries app logs. */
export class DeployFailedError extends Error {
  constructor(
    message: string,
    readonly logs: string,
  ) {
    super(message);
    this.name = "DeployFailedError";
  }
}

/** Per-phase cap on captured stdout/stderr lines persisted to the event log. */
const MAX_CAPTURED_LINES = 80;
/** Hard cap per captured line (a single npm/build line can be pathologically long). */
const MAX_LINE_CHARS = 2000;

export interface OrchestratorConfig {
  baseDomain: string;
  /** Stop a running container after this long without a request (scale-to-zero). */
  idleMs: number;
  /** How long to wait for an app to answer HTTP after start/wake. */
  healthTimeoutMs: number;
  /** Max concurrently running dynamic containers (RAM guard); LRU-evicted past this. */
  maxRunningDynamic: number;
}

export interface OrchestratorDeps {
  store: Store;
  engine: ContainerEngine;
  router: CaddyRouter;
  ports: PortPool;
  /** Returns true when 127.0.0.1:<port> answers HTTP. Injected for tests. */
  probe: (port: number) => Promise<boolean>;
  config: OrchestratorConfig;
  log?: (msg: string) => void;
  /**
   * Time source for deploy-phase event timestamps (default Date.now; injected
   * for tests). Deploy events used to reuse the request's arrival time for
   * EVERY phase, so `openpouch logs` showed install/build/app milliseconds
   * apart while the real phases took seconds (OpenClaw 2026-07-04) — each
   * event now stamps the moment it actually happened.
   */
  clock?: () => number;
}

/**
 * Owns the dynamic-app (M2) lifecycle: build → run → route, idle-stop with
 * on-demand wake (scale-to-zero), expiry teardown, and boot reconciliation.
 * The HTTP layer (server.ts) calls into this; the container engine and Caddy
 * router are injected so the whole machine is testable without Docker/Caddy.
 */
export class Orchestrator {
  private readonly store: Store;
  private readonly engine: ContainerEngine;
  private readonly router: CaddyRouter;
  private readonly ports: PortPool;
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly cfg: OrchestratorConfig;
  private readonly log: (msg: string) => void;
  private readonly clock: () => number;
  /** In-memory last-request timestamps (idle tracking); reset on boot. */
  private readonly lastSeen = new Map<string, number>();

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.router = deps.router;
    this.ports = deps.ports;
    this.probe = deps.probe;
    this.cfg = deps.config;
    this.log = deps.log ?? (() => {});
    this.clock = deps.clock ?? Date.now;
  }

  hostname(slug: string): string {
    return `${slug}.${this.cfg.baseDomain}`;
  }

  /** Resolve an inbound Host header to a dynamic record, or undefined. */
  dynamicRecordForHost(host: string | undefined): DeploymentRecord | undefined {
    if (!host) return undefined;
    const label = host.split(":")[0]!.split(".")[0]!;
    const rec = this.store.get(label);
    return rec?.kind === "dynamic" ? rec : undefined;
  }

  /**
   * Full deploy of a freshly extracted dynamic upload. Throws DeployFailedError on failure (caller removes the record/dir).
   *
   * Event timestamps: every phase event/output stamps `this.clock()` AT THAT
   * MOMENT (not the request's arrival time), and each phase's milestone event
   * carries its real duration — so `openpouch logs` timing is diagnosable
   * (OpenClaw 2026-07-04). Captured phase OUTPUT lines share the phase-END
   * timestamp: that is when the block became observable (the engine returns
   * install/build output in one piece), which is the honest per-line time we have.
   */
  async deployDynamic(record: DeploymentRecord, plan: DynamicPlan, siteDir: string, env?: Record<string, string>): Promise<void> {
    const slug = record.slug;
    const port = this.ports.allocate();
    await this.store.update(slug, { hostPort: port, runtimeStatus: "building", startCmd: plan.startCmd });
    let containerId: string | undefined;
    try {
      const installCmd = plan.hasLockfile ? "npm ci --ignore-scripts" : "npm install --ignore-scripts --no-audit --no-fund";
      await this.store.appendEvent(slug, `building (${plan.reason}; ${installCmd})`, this.clock());
      const installStart = this.clock();
      const build = await this.engine.build({ slug, siteDir, installCmd });
      const installEnd = this.clock();
      // Capture install stdout+stderr even on success — a self-repairing agent
      // needs to see *why* a deploy is broken (e.g. an install warning, or that
      // no frontend build ran), not just "build ok". Previously discarded here.
      await this.recordOutput(slug, "install", build.logs, installEnd);
      if (!build.ok) throw new DeployFailedError("build failed", build.logs);
      await this.store.appendEvent(slug, `dependencies installed (took ${installEnd - installStart} ms)`, installEnd);

      // Build-on-deploy (PRD L9): run the app's build script after install so a
      // server-side framework app (e.g. Express serving a Vite/React build) has
      // its assets before it starts — the root cause of "deploy ok but / 404".
      if (plan.buildCmd !== undefined) {
        await this.store.appendEvent(slug, `building app (${plan.buildCmd})`, this.clock());
        const buildStart = this.clock();
        const built = await this.engine.buildApp({ slug, siteDir, buildCmd: plan.buildCmd });
        const buildEnd = this.clock();
        await this.recordOutput(slug, "build", built.logs, buildEnd);
        if (!built.ok) throw new DeployFailedError("app build failed", built.logs);
        await this.store.appendEvent(slug, `app build ok (took ${buildEnd - buildStart} ms)`, buildEnd);
      }

      await this.enforceRunningCap(this.clock());
      const startAt = this.clock();
      containerId = await this.engine.create({ slug, siteDir, startCmd: plan.startCmd, hostPort: port, ...(env ? { env } : {}) });
      await this.store.update(slug, { containerId });
      await this.engine.start(containerId);

      if (!(await this.waitHealthy(port))) {
        const appLogs = await this.engine.logs(containerId).catch(() => "");
        await this.recordOutput(slug, "app", appLogs, this.clock()); // surface the crash via `openpouch logs`
        throw new DeployFailedError("app did not answer HTTP in time", appLogs);
      }

      const readyAt = this.clock();
      this.lastSeen.set(slug, readyAt);
      await this.store.update(slug, { runtimeStatus: "running" });
      await this.store.appendEvent(slug, `live (container ${containerId.slice(0, 12)}, port ${port}, ready in ${readyAt - startAt} ms)`, readyAt);
      // Record the app's startup stdout+stderr so the agent can read what the
      // server logged on boot (e.g. "listening on 3000", or a runtime warning).
      await this.recordOutput(slug, "app", await this.engine.logs(containerId).catch(() => ""), this.clock());
      await this.syncRoutes();
      this.log(`deployed dynamic ${slug} on port ${port}`);
    } catch (err) {
      if (containerId) await this.engine.remove(containerId).catch(() => {});
      this.ports.release(port);
      await this.store.update(slug, { runtimeStatus: "failed" });
      const failed = err instanceof DeployFailedError ? err : new DeployFailedError((err as Error).message, "");
      await this.store.appendEvent(slug, `failed: ${failed.message}`, this.clock());
      throw failed;
    }
  }

  /**
   * Build an unbuilt static SPA, then serve its build output as files (static
   * build-on-deploy, PRD L9). No long-lived container, port, or route: install +
   * `npm run build` run in the hardened throwaway build container, then the build
   * output dir (dist/build/out) is promoted to the served root. Throws
   * DeployFailedError on failure (caller removes the record/dir).
   */
  async buildStatic(record: DeploymentRecord, plan: StaticBuildPlan, siteDir: string): Promise<void> {
    const slug = record.slug;
    try {
      const installCmd = plan.hasLockfile ? "npm ci --ignore-scripts" : "npm install --ignore-scripts --no-audit --no-fund";
      await this.store.appendEvent(slug, `building (${installCmd})`, this.clock());
      const installStart = this.clock();
      const install = await this.engine.build({ slug, siteDir, installCmd });
      const installEnd = this.clock();
      await this.recordOutput(slug, "install", install.logs, installEnd);
      if (!install.ok) throw new DeployFailedError("build failed", install.logs);
      await this.store.appendEvent(slug, `dependencies installed (took ${installEnd - installStart} ms)`, installEnd);

      await this.store.appendEvent(slug, `building app (${plan.buildCmd})`, this.clock());
      const buildStart = this.clock();
      const built = await this.engine.buildApp({ slug, siteDir, buildCmd: plan.buildCmd });
      const buildEnd = this.clock();
      await this.recordOutput(slug, "build", built.logs, buildEnd);
      if (!built.ok) throw new DeployFailedError("app build failed", built.logs);

      // Promote the build output to the served root, then make it world-readable
      // (the build container's output bypasses the tar extraction's chmod pass).
      const outDir = await this.findOutputDir(siteDir, plan.outputDirs);
      if (outDir === undefined) {
        throw new DeployFailedError(`build produced no servable output (no index.html in ${plan.outputDirs.join("/")})`, "");
      }
      await this.promoteOutput(siteDir, outDir);
      await makeWorldReadable(siteDir);
      await this.store.appendEvent(slug, `app build ok — serving ${outDir}/ (build took ${buildEnd - buildStart} ms)`, this.clock());
      this.log(`built static ${slug} (served ${outDir}/)`);
    } catch (err) {
      const failed = err instanceof DeployFailedError ? err : new DeployFailedError((err as Error).message, "");
      await this.store.appendEvent(slug, `failed: ${failed.message}`, this.clock());
      throw failed;
    }
  }

  /** First of `candidates` (under siteDir) that holds an index.html, else undefined. */
  private async findOutputDir(siteDir: string, candidates: string[]): Promise<string | undefined> {
    for (const d of candidates) {
      try {
        if ((await stat(join(siteDir, d, "index.html"))).isFile()) return d;
      } catch {
        // not present
      }
    }
    return undefined;
  }

  /** Replace the site dir's contents with the build output (move outDir → root, drop the source). */
  private async promoteOutput(siteDir: string, outDir: string): Promise<void> {
    const staged = join(dirname(siteDir), `.built-${basename(siteDir)}-${randomBytes(6).toString("hex")}`);
    await rename(join(siteDir, outDir), staged); // built output aside (same fs → atomic)
    await rm(siteDir, { recursive: true, force: true }); // drop source + node_modules
    await rename(staged, siteDir); // built output becomes the served root
  }

  /** Ensure a dynamic deployment's container is running; wakes it if idle-stopped. Returns its host port. */
  async ensureRunning(record: DeploymentRecord, now: number): Promise<number> {
    const slug = record.slug;
    if (record.hostPort === undefined) throw new Error("dynamic deployment has no port");
    this.lastSeen.set(slug, now);
    if (record.runtimeStatus === "running") return record.hostPort;
    if (record.runtimeStatus !== "stopped" || !record.containerId) {
      throw new Error(`deployment not runnable (status ${record.runtimeStatus ?? "none"})`);
    }
    // Scale-to-zero wake.
    await this.enforceRunningCap(now, slug);
    await this.engine.start(record.containerId);
    if (!(await this.waitHealthy(record.hostPort))) throw new Error("app failed to wake");
    await this.store.update(slug, { runtimeStatus: "running" });
    await this.store.appendEvent(slug, "woken from idle", now);
    this.log(`woke dynamic ${slug}`);
    return record.hostPort;
  }

  /** Stop containers with no request within idleMs. Returns the stopped slugs. */
  async idleSweep(now: number): Promise<string[]> {
    const stopped: string[] = [];
    for (const rec of this.store.list()) {
      if (rec.kind !== "dynamic" || rec.runtimeStatus !== "running" || !rec.containerId) continue;
      const last = this.lastSeen.get(rec.slug) ?? Date.parse(rec.createdAt);
      if (now - last > this.cfg.idleMs) {
        await this.engine.stop(rec.containerId);
        await this.store.update(rec.slug, { runtimeStatus: "stopped" });
        await this.store.appendEvent(rec.slug, "stopped (idle)", now);
        stopped.push(rec.slug);
      }
    }
    if (stopped.length > 0) this.log(`idle-stopped ${stopped.length} container(s)`);
    return stopped;
  }

  /** Tear down containers/ports/routes for removed (expired/deleted/taken-down) records. */
  async onRemoved(records: DeploymentRecord[], now: number): Promise<void> {
    let changed = false;
    for (const rec of records) {
      if (rec.kind !== "dynamic") continue;
      if (rec.containerId) await this.engine.remove(rec.containerId).catch(() => {});
      if (rec.hostPort !== undefined) this.ports.release(rec.hostPort);
      this.lastSeen.delete(rec.slug);
      changed = true;
    }
    if (changed) {
      await this.syncRoutes();
      this.log(`tore down ${records.filter((r) => r.kind === "dynamic").length} dynamic deployment(s)`);
    }
  }

  /** Boot reconciliation: rebuild port reservations, container existence, and routes. */
  async reconcile(now: number): Promise<void> {
    for (const rec of this.store.list()) {
      if (rec.kind !== "dynamic") continue;
      if (rec.hostPort !== undefined) this.ports.reserve(rec.hostPort);
      if (!rec.containerId) {
        await this.store.update(rec.slug, { runtimeStatus: "failed" });
        continue;
      }
      const state = await this.engine.state(rec.containerId);
      if (state === "running") {
        await this.store.update(rec.slug, { runtimeStatus: "running" });
        this.lastSeen.set(rec.slug, now);
      } else if (state === "stopped") {
        await this.store.update(rec.slug, { runtimeStatus: "stopped" });
      } else {
        // missing (box reboot): recreate the container; node_modules persists in the site dir.
        if (rec.startCmd && rec.hostPort !== undefined) {
          try {
            const id = await this.engine.create({ slug: rec.slug, siteDir: this.store.siteDir(rec.slug), startCmd: rec.startCmd, hostPort: rec.hostPort });
            await this.store.update(rec.slug, { containerId: id, runtimeStatus: "stopped" });
            await this.store.appendEvent(rec.slug, "container recreated after restart (idle)", now);
          } catch (e) {
            await this.store.update(rec.slug, { runtimeStatus: "failed" });
            await this.store.appendEvent(rec.slug, `recreate failed: ${(e as Error).message}`, now);
          }
        } else {
          await this.store.update(rec.slug, { runtimeStatus: "failed" });
        }
      }
    }
    await this.syncRoutes();
    this.log("reconciled dynamic deployments + routes");
  }

  /**
   * Persist captured stdout+stderr as event lines, tagged by phase, so an agent
   * reading `openpouch logs` sees real install/app output — not just lifecycle
   * one-liners. Keeps only the last MAX_CAPTURED_LINES (the tail is where the
   * error usually is) and caps each line's length; one batched disk write.
   */
  private async recordOutput(slug: string, phase: "install" | "build" | "app", raw: string, now: number): Promise<void> {
    const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.length > 0);
    if (lines.length === 0) return;
    const tail = lines.slice(-MAX_CAPTURED_LINES);
    const messages: string[] = [];
    if (lines.length > tail.length) {
      messages.push(`[${phase}] …(${lines.length - tail.length} earlier line(s) omitted)`);
    }
    for (const line of tail) {
      const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
      messages.push(`[${phase}] ${clipped}`);
    }
    await this.store.appendEvents(slug, messages, now);
  }

  private async waitHealthy(port: number): Promise<boolean> {
    const end = Date.now() + this.cfg.healthTimeoutMs;
    for (;;) {
      if (await this.probe(port)) return true;
      if (Date.now() >= end) return false;
      await sleep(500);
    }
  }

  /** Caddy route = every reachable dynamic host (running or idle-stopped, so wake works). */
  private async syncRoutes(): Promise<void> {
    const hosts = this.store
      .list()
      .filter((r) => r.kind === "dynamic" && (r.runtimeStatus === "running" || r.runtimeStatus === "stopped"))
      .map((r) => this.hostname(r.slug));
    await this.router.sync(hosts);
  }

  /** Stop least-recently-seen running containers until there is room for one more. */
  private async enforceRunningCap(now: number, exceptSlug?: string): Promise<void> {
    const running = this.store
      .list()
      .filter((r) => r.kind === "dynamic" && r.runtimeStatus === "running" && r.containerId && r.slug !== exceptSlug);
    if (running.length < this.cfg.maxRunningDynamic) return;
    running.sort((a, b) => (this.lastSeen.get(a.slug) ?? Date.parse(a.createdAt)) - (this.lastSeen.get(b.slug) ?? Date.parse(b.createdAt)));
    const toStop = running.length - this.cfg.maxRunningDynamic + 1;
    for (let i = 0; i < toStop; i++) {
      const victim = running[i];
      if (!victim?.containerId) continue;
      await this.engine.stop(victim.containerId);
      await this.store.update(victim.slug, { runtimeStatus: "stopped" });
      await this.store.appendEvent(victim.slug, "stopped (capacity — LRU eviction)", now);
    }
  }
}
