import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DynamicPlan } from "../src/detect.js";
import { DeployFailedError, Orchestrator } from "../src/orchestrator.js";
import { PortPool } from "../src/ports.js";
import { Store, type DeploymentRecord } from "../src/store.js";
import { FakeEngine, FakeRouter } from "./fakes.js";

const PLAN: DynamicPlan = { kind: "dynamic", startCmd: "npm start", hasLockfile: true, reason: "test" };

async function setup(opts?: { probe?: () => Promise<boolean>; healthTimeoutMs?: number; maxRunningDynamic?: number; clock?: () => number }) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-orch-"));
  const store = new Store({ dataDir: dir });
  await store.init();
  const engine = new FakeEngine();
  const router = new FakeRouter();
  const ports = new PortPool(20000, 20010);
  // Deterministic small-step clock: deploy-phase events stamp their own moment
  // (not the request's now), so tests on the synthetic 0/2000/3000 timeline
  // need event times that stay near zero.
  let t = 0;
  const orch = new Orchestrator({
    store,
    engine,
    router,
    ports,
    probe: opts?.probe ?? (async () => true),
    config: { baseDomain: "test.sh", idleMs: 1000, healthTimeoutMs: opts?.healthTimeoutMs ?? 1, maxRunningDynamic: opts?.maxRunningDynamic ?? 12 },
    clock: opts?.clock ?? (() => (t += 5)),
  });
  return { store, engine, router, ports, orch };
}

async function deploy(store: Store, orch: Orchestrator, hint: string, now: number): Promise<DeploymentRecord> {
  const rec = await store.create({ hint, bytes: 1, fileCount: 1, now, kind: "dynamic" });
  await orch.deployDynamic(rec, PLAN, store.siteDir(rec.slug));
  return store.get(rec.id)!;
}

describe("orchestrator — deploy", () => {
  it("builds, creates, starts, health-checks, and routes a dynamic app", async () => {
    const { store, engine, router, ports, orch } = await setup();
    const rec = await deploy(store, orch, "api", 0);
    expect(rec.runtimeStatus).toBe("running");
    expect(rec.containerId).toBeTruthy();
    expect(rec.hostPort).toBeGreaterThanOrEqual(20000);
    expect(ports.size).toBe(1);
    expect(engine.calls).toEqual([`build:${rec.slug}`, `create:${rec.slug}`, `start:${rec.containerId}`]);
    expect(router.last).toContain(`${rec.slug}.test.sh`);
  });

  it("captures install + app stdout/stderr into the event log (self-repair depth)", async () => {
    const { store, engine, orch } = await setup();
    engine.buildLogs = "npm warn deprecated foo@1\nadded 42 packages in 3s";
    const rec = await deploy(store, orch, "api", 0);
    const messages = store.get(rec.id)!.events.map((e) => e.message);
    // install output is captured even on a SUCCESSFUL build (was discarded before)
    expect(messages).toContain("[install] npm warn deprecated foo@1");
    expect(messages).toContain("[install] added 42 packages in 3s");
    // the running container's startup output is captured too
    expect(messages.some((m) => m.startsWith("[app] "))).toBe(true);
    // lifecycle markers are still present
    expect(messages.some((m) => m.startsWith("dependencies installed (took "))).toBe(true);
  });

  it("runs the app build script after install when the plan has one (build-on-deploy, L9)", async () => {
    const { store, engine, orch } = await setup();
    engine.buildAppLogs = "vite v5\n✓ built dist/ in 1.2s";
    const rec = await store.create({ hint: "shop", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await orch.deployDynamic(rec, { ...PLAN, buildCmd: "npm run build" }, store.siteDir(rec.slug));
    // buildApp runs AFTER install, BEFORE the run container is created
    expect(engine.calls).toEqual([`build:${rec.slug}`, `buildApp:${rec.slug}`, `create:${rec.slug}`, `start:c-${rec.slug}-1`]);
    const messages = store.get(rec.id)!.events.map((e) => e.message);
    expect(messages).toContain("building app (npm run build)");
    expect(messages.some((m) => m.startsWith("app build ok (took "))).toBe(true);
    expect(messages).toContain("[build] ✓ built dist/ in 1.2s"); // build output captured
  });

  it("skips the build step when the plan has no build command", async () => {
    const { store, engine, orch } = await setup();
    const rec = await deploy(store, orch, "api", 0); // module PLAN has no buildCmd
    expect(engine.calls).not.toContain(`buildApp:${rec.slug}`);
  });

  it("fails the deploy and releases the port when the app build script fails (L9)", async () => {
    const { store, engine, ports, router, orch } = await setup();
    engine.buildAppOk = false;
    engine.buildAppLogs = "vite build error: Could not resolve './missing'";
    const rec = await store.create({ hint: "shop", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await expect(
      orch.deployDynamic(rec, { ...PLAN, buildCmd: "npm run build" }, store.siteDir(rec.slug)),
    ).rejects.toThrow(/app build failed/);
    expect(store.get(rec.id)?.runtimeStatus).toBe("failed");
    expect(ports.size).toBe(0);
    expect(router.synced).toHaveLength(0); // never created/started/routed
    expect(engine.calls).not.toContain(`create:${rec.slug}`);
    // the build error is in the logs for self-repair
    expect(store.get(rec.id)!.events.map((e) => e.message)).toContain("[build] vite build error: Could not resolve './missing'");
  });

  it("captures install output even when the build fails", async () => {
    const { store, engine, orch } = await setup();
    engine.buildOk = false;
    engine.buildLogs = "npm error code E404\nnpm error 404 Not Found - GET https://registry…/nope";
    const rec = await store.create({ hint: "api", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await expect(orch.deployDynamic(rec, PLAN, store.siteDir(rec.slug))).rejects.toThrow(DeployFailedError);
    const messages = store.get(rec.id)!.events.map((e) => e.message);
    expect(messages).toContain("[install] npm error code E404");
  });

  it("fails the deploy and releases the port when the build fails", async () => {
    const { store, engine, ports, router, orch } = await setup();
    engine.buildOk = false;
    const rec = await store.create({ hint: "api", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await expect(orch.deployDynamic(rec, PLAN, store.siteDir(rec.slug))).rejects.toThrow(DeployFailedError);
    expect(store.get(rec.id)?.runtimeStatus).toBe("failed");
    expect(ports.size).toBe(0);
    expect(router.synced).toHaveLength(0); // never routed
  });

  it("stamps each phase event with its own moment and real durations (OpenClaw 2026-07-04)", async () => {
    let t = 0;
    const { store, orch } = await setup({ clock: () => (t += 1000) });
    const rec = await store.create({ hint: "timing", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await orch.deployDynamic(rec, { ...PLAN, buildCmd: "npm run build" }, store.siteDir(rec.slug));
    const events = store.get(rec.id)!.events;
    const at = (prefix: string) => {
      const e = events.find((ev) => ev.message.startsWith(prefix));
      expect(e, prefix).toBeDefined();
      return Date.parse(e!.timestamp);
    };
    // milestones carry real durations, not the request's arrival time
    expect(events.find((e) => e.message.startsWith("dependencies installed"))!.message).toBe("dependencies installed (took 1000 ms)");
    expect(events.find((e) => e.message.startsWith("app build ok"))!.message).toBe("app build ok (took 1000 ms)");
    expect(events.find((e) => e.message.startsWith("live ("))!.message).toMatch(/ready in \d+ ms\)$/);
    // and each phase stamps LATER than the one before it (no single-timestamp deploys)
    expect(at("building (")).toBeLessThan(at("dependencies installed"));
    expect(at("dependencies installed")).toBeLessThan(at("building app ("));
    expect(at("building app (")).toBeLessThan(at("app build ok"));
    expect(at("app build ok")).toBeLessThan(at("live ("));
  });

  it("fails and tears down the container when the app never becomes healthy", async () => {
    const { store, engine, ports, orch } = await setup({ probe: async () => false, healthTimeoutMs: 0 });
    const rec = await store.create({ hint: "api", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await expect(orch.deployDynamic(rec, PLAN, store.siteDir(rec.slug))).rejects.toThrow(/did not answer HTTP/);
    expect(ports.size).toBe(0);
    // the created container was removed
    expect([...engine.states.values()].every((s) => s === "missing")).toBe(true);
  });
});

describe("orchestrator — static build (L9)", () => {
  const STATIC_PLAN = { kind: "static-build" as const, buildCmd: "npm run build", hasLockfile: false, outputDirs: ["dist", "build", "out"] };

  it("builds an unbuilt SPA and promotes the build output to the served root", async () => {
    const { store, orch } = await setup();
    const rec = await store.create({ hint: "spa", bytes: 1, fileCount: 1, now: 0, kind: "static" });
    const siteDir = store.siteDir(rec.slug);
    // extracted source + the build container's output (FakeEngine.buildApp is a no-op, so we stage dist/ ourselves)
    await mkdir(join(siteDir, "src"), { recursive: true });
    await writeFile(join(siteDir, "index.html"), '<script src="/src/main.jsx"></script>'); // source dev entry
    await writeFile(join(siteDir, "src", "main.jsx"), "//");
    await mkdir(join(siteDir, "dist"), { recursive: true });
    await writeFile(join(siteDir, "dist", "index.html"), "<h1>built</h1>");
    await writeFile(join(siteDir, "dist", "app.js"), "console.log(1)");

    await orch.buildStatic(rec, STATIC_PLAN, siteDir);

    // the served root is now the build output: built files at root, source + dist/ gone
    expect(await readFile(join(siteDir, "index.html"), "utf8")).toContain("built");
    expect(existsSync(join(siteDir, "app.js"))).toBe(true);
    expect(existsSync(join(siteDir, "src"))).toBe(false);
    expect(existsSync(join(siteDir, "dist"))).toBe(false);
    expect(store.get(rec.id)!.events.map((e) => e.message).some((m) => m.startsWith("app build ok — serving dist/ (build took "))).toBe(true);
  });

  it("fails the static build when no servable output is produced (no dist/index.html)", async () => {
    const { store, orch } = await setup();
    const rec = await store.create({ hint: "spa", bytes: 1, fileCount: 1, now: 0, kind: "static" });
    const siteDir = store.siteDir(rec.slug);
    await mkdir(siteDir, { recursive: true });
    await writeFile(join(siteDir, "index.html"), "<script src=/src/x>"); // build produced nothing
    await expect(orch.buildStatic(rec, STATIC_PLAN, siteDir)).rejects.toThrow(/no servable output/);
    // the original source is left intact (not destroyed) for the caller to clean up
    expect(existsSync(join(siteDir, "index.html"))).toBe(true);
  });

  it("fails the static build when the build script fails (and doesn't touch the source)", async () => {
    const { store, engine, orch } = await setup();
    engine.buildAppOk = false;
    const rec = await store.create({ hint: "spa", bytes: 1, fileCount: 1, now: 0, kind: "static" });
    const siteDir = store.siteDir(rec.slug);
    await mkdir(siteDir, { recursive: true });
    await writeFile(join(siteDir, "index.html"), "src");
    await expect(orch.buildStatic(rec, STATIC_PLAN, siteDir)).rejects.toThrow(/app build failed/);
    expect(existsSync(join(siteDir, "index.html"))).toBe(true); // source untouched
  });
});

describe("orchestrator — scale-to-zero", () => {
  it("idle-stops a running container and wakes it on demand", async () => {
    const { store, engine, orch } = await setup();
    const rec = await deploy(store, orch, "api", 0);
    const cid = rec.containerId!;

    const stopped = await orch.idleSweep(2000); // idleMs=1000, last request at t=0
    expect(stopped).toEqual([rec.slug]);
    expect(store.get(rec.id)?.runtimeStatus).toBe("stopped");
    expect(engine.states.get(cid)).toBe("stopped");

    const port = await orch.ensureRunning(store.get(rec.id)!, 3000); // wake
    expect(port).toBe(rec.hostPort);
    expect(store.get(rec.id)?.runtimeStatus).toBe("running");
    expect(engine.states.get(cid)).toBe("running");
  });

  it("only idle-stops containers past the idle window", async () => {
    const { store, orch } = await setup();
    const a = await deploy(store, orch, "a", 0);
    const b = await deploy(store, orch, "b", 0);
    await orch.ensureRunning(store.get(b.id)!, 2000); // keep b warm
    const stopped = await orch.idleSweep(2000);
    expect(stopped).toEqual([a.slug]);
    expect(store.get(b.id)?.runtimeStatus).toBe("running");
  });
});

describe("orchestrator — teardown, reconcile, capacity", () => {
  it("onRemoved removes the container, frees the port, and drops the route", async () => {
    const { store, engine, router, ports, orch } = await setup();
    const rec = await deploy(store, orch, "api", 0);
    const cid = rec.containerId!;
    const removed = await store.remove(rec.id, { force: true });
    expect(removed.ok).toBe(true);
    await orch.onRemoved([removed.ok ? removed.record : rec], 5000);
    expect(engine.states.get(cid)).toBe("missing");
    expect(ports.size).toBe(0);
    expect(router.last).toEqual([]); // no dynamic hosts left
  });

  it("reconcile recreates a missing container after a restart and re-routes", async () => {
    const { store, engine, router, ports, orch } = await setup();
    // Simulate a record that survived a reboot: container id is stale/missing.
    const rec = await store.create({ hint: "api", bytes: 1, fileCount: 1, now: 0, kind: "dynamic" });
    await store.update(rec.id, { containerId: "stale-id", hostPort: 20005, startCmd: "npm start", runtimeStatus: "running" });

    await orch.reconcile(1000);

    const after = store.get(rec.id)!;
    expect(after.containerId).not.toBe("stale-id"); // recreated
    expect(after.runtimeStatus).toBe("stopped"); // wakes on first request
    expect(ports.has(20005)).toBe(true); // port reservation rebuilt
    expect(engine.calls).toContain(`create:${rec.slug}`);
    expect(router.last).toContain(`${rec.slug}.test.sh`);
  });

  it("enforces the running cap by LRU-stopping the oldest container", async () => {
    const { store, orch } = await setup({ maxRunningDynamic: 1 });
    const a = await deploy(store, orch, "a", 0);
    const b = await deploy(store, orch, "b", 1); // deploying b must evict a
    expect(store.get(a.id)?.runtimeStatus).toBe("stopped");
    expect(store.get(b.id)?.runtimeStatus).toBe("running");
  });
});
