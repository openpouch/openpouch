import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildScriptSpec, ContainerEngine, CreateSpec } from "../src/engine.js";
import { NullRouter } from "../src/router.js";
import { configFromEnv, createRunServer, type RunConfig } from "../src/server.js";

function tarballBuffer(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (c: Buffer) => chunks.push(c));
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
  });
}

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(overrides: Partial<RunConfig>) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-srv-"));
  const config: RunConfig = { ...configFromEnv({}), dataDir: dir, baseDomain: "test.sh", publicBase: "http://localhost", ...overrides };
  const { server, store } = await createRunServer(config);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, store, dir };
}

async function deploy(base: string, tarball: Buffer): Promise<number> {
  const res = await fetch(`${base}/api/deployments`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: tarball as unknown as BodyInit,
  });
  return res.status;
}

async function makeTarball(): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "oprun-site-"));
  await writeFile(join(src, "index.html"), "<h1>x</h1>");
  return tarballBuffer(src);
}

async function makeDynamicTarball(): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "oprun-app-"));
  await writeFile(join(src, "package.json"), JSON.stringify({ name: "joey-app", scripts: { start: "node server.js" } }));
  await writeFile(join(src, "server.js"), "require('http').createServer((_q,s)=>s.end('hi')).listen(process.env.PORT)");
  return tarballBuffer(src);
}

/** An unbuilt static SPA: build script + a dev index.html referencing source, no server. */
async function makeUnbuiltSpaTarball(): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "oprun-spa-"));
  await writeFile(join(src, "package.json"), JSON.stringify({ name: "spa-app", scripts: { build: "vite build" } }));
  await writeFile(join(src, "index.html"), '<!doctype html><script type="module" src="/src/main.jsx"></script>');
  return tarballBuffer(src);
}

async function deployFull(base: string, tarball: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/deployments`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: tarball as unknown as BodyInit,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function httpGetHost(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += String(c)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A ContainerEngine whose "containers" are real local HTTP servers, so the
 *  Host-routing + reverse-proxy + scale-to-zero path can be exercised end-to-end. */
class LiveContainerFake implements ContainerEngine {
  private readonly entries = new Map<string, { server: Server; port: number; listening: boolean }>();
  private seq = 0;
  async build(): Promise<{ ok: boolean; logs: string }> {
    return { ok: true, logs: "" };
  }
  async buildApp(spec: BuildScriptSpec): Promise<{ ok: boolean; logs: string }> {
    // Emulate `npm run build`: produce dist/index.html in the bind-mounted site dir.
    await mkdir(join(spec.siteDir, "dist"), { recursive: true });
    await writeFile(join(spec.siteDir, "dist", "index.html"), "<h1>built by fake</h1>");
    return { ok: true, logs: "fake build" };
  }
  async create(spec: CreateSpec): Promise<string> {
    const id = `live-${spec.slug}-${++this.seq}`;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`hello from ${spec.slug}`);
    });
    // Minimal WebSocket-ish upgrade endpoint: complete the 101 handshake, then echo.
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (d: Buffer) => socket.write(`echo:${d.toString()}`));
    });
    this.entries.set(id, { server, port: spec.hostPort, listening: false });
    return id;
  }
  async start(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.listening) return;
    await new Promise<void>((r) => e.server.listen(e.port, "127.0.0.1", r));
    e.listening = true;
  }
  async stop(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || !e.listening) return;
    await new Promise<void>((r) => e.server.close(() => r()));
    e.listening = false;
  }
  async remove(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e?.listening) await new Promise<void>((r) => e.server.close(() => r()));
    this.entries.delete(id);
  }
  async state(id: string): Promise<"running" | "stopped" | "missing"> {
    const e = this.entries.get(id);
    return e ? (e.listening ? "running" : "stopped") : "missing";
  }
  async logs(): Promise<string> {
    return "";
  }
  closeAll(): void {
    for (const e of this.entries.values()) if (e.listening) e.server.close();
  }
}

async function startDynamic(engine: ContainerEngine, overrides?: Partial<RunConfig>) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-dyn-"));
  const baseCfg = configFromEnv({});
  const config: RunConfig = {
    ...baseCfg,
    dataDir: dir,
    baseDomain: "test.sh",
    publicBase: "http://localhost",
    dynamicEnabled: true,
    dynamic: { ...baseCfg.dynamic, portMin: 24100, portMax: 24199 },
    ...overrides,
  };
  const run = await createRunServer(config, { engine, router: new NullRouter() });
  await new Promise<void>((r) => run.server.listen(0, "127.0.0.1", r));
  servers.push(run.server);
  const port = (run.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, run, dir };
}

describe("run-d hardening", () => {
  it("enforces the global deployment cap with 503", async () => {
    const { base } = await start({ maxDeployments: 2, ratePerHour: 100, ratePerDay: 100 });
    const tb = await makeTarball();
    expect(await deploy(base, tb)).toBe(201);
    expect(await deploy(base, tb)).toBe(201);
    expect(await deploy(base, tb)).toBe(503); // at capacity
  });

  it("rate-limits per IP with 429", async () => {
    const { base } = await start({ ratePerHour: 2, maxDeployments: 100, ratePerDay: 100 });
    const tb = await makeTarball();
    expect(await deploy(base, tb)).toBe(201);
    expect(await deploy(base, tb)).toBe(201);
    expect(await deploy(base, tb)).toBe(429); // over the hourly limit
  });

  it("accepts abuse reports and appends them to reports.jsonl", async () => {
    const { base, dir } = await start({});
    const res = await fetch(`${base}/api/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "phishy-abc123", reason: "phishing" }),
    });
    expect(res.status).toBe(200);
    const log = await readFile(join(dir, "reports.jsonl"), "utf8");
    expect(log).toContain("phishy-abc123");
    expect(log).toContain("phishing");
  });

  it("force-takedown is token-gated and removes even a claimed deployment", async () => {
    const { base, store } = await start({ adminToken: "s3cret" });
    const rec = await store.create({ hint: "x", bytes: 1, fileCount: 1, now: Date.now() });
    await store.claim(rec.id, rec.claimToken, Date.now()); // claimed → normally needs mgmt token

    const noToken = await fetch(`${base}/api/admin/takedown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: rec.slug }),
    });
    expect(noToken.status).toBe(403);

    const withToken = await fetch(`${base}/api/admin/takedown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "s3cret" },
      body: JSON.stringify({ slug: rec.slug }),
    });
    expect(withToken.status).toBe(200);
    expect(store.get(rec.id)).toBeUndefined();
  });
});

describe("run-d dynamic lane (M2)", () => {
  it("builds a dynamic upload, routes its host to the container, and proxies through", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { base, port } = await startDynamic(fake);

    const { status, json } = await deployFull(base, await makeDynamicTarball());
    expect(status).toBe(201);
    expect(json.kind).toBe("dynamic");
    const slug = json.slug as string;

    const proxied = await httpGetHost(port, "/", `${slug}.test.sh`);
    expect(proxied.status).toBe(200);
    expect(proxied.body).toBe(`hello from ${slug}`);
  });

  it("proxies a WebSocket upgrade to the dynamic container (M2 WS support)", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { port } = await startDynamic(fake);
    const { json } = await deployFull(`http://127.0.0.1:${port}`, await makeDynamicTarball());
    const slug = json.slug as string;

    const echoed = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/ws",
        headers: { Host: `${slug}.test.sh`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "x" },
      });
      req.on("upgrade", (_res, socket) => {
        socket.once("data", (d: Buffer) => {
          socket.destroy();
          resolve(d.toString());
        });
        socket.write("ping");
      });
      req.on("error", reject);
      req.end();
    });
    expect(echoed).toBe("echo:ping"); // round-tripped through run-d → container and back
  });

  it("closes a WebSocket upgrade to a non-dynamic host", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { port } = await startDynamic(fake);
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { Host: "openpouch.test.sh", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "x" },
      });
      req.on("upgrade", () => reject(new Error("apex host must not upgrade")));
      req.on("error", () => resolve()); // socket destroyed → client aborts
      req.on("close", () => resolve());
      req.end();
    });
  });

  it("idle-stops then wakes the container on the next request (scale-to-zero)", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { base, port, run } = await startDynamic(fake);

    const { json } = await deployFull(base, await makeDynamicTarball());
    const slug = json.slug as string;

    const stopped = await run.orchestrator!.idleSweep(Date.now() + 16 * 60_000);
    expect(stopped).toContain(slug);
    expect(run.store.get(slug)?.runtimeStatus).toBe("stopped");

    const woken = await httpGetHost(port, "/", `${slug}.test.sh`);
    expect(woken.status).toBe(200);
    expect(woken.body).toBe(`hello from ${slug}`);
    expect(run.store.get(slug)?.runtimeStatus).toBe("running");
  });

  it("serves a static upload as static even with the dynamic lane enabled", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { base } = await startDynamic(fake);
    const { status, json } = await deployFull(base, await makeTarball());
    expect(status).toBe(201);
    expect(json.kind).toBe("static");
  });

  it("builds an unbuilt static SPA server-side and serves the build output (L9)", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { base, run } = await startDynamic(fake);
    const { status, json } = await deployFull(base, await makeUnbuiltSpaTarball());
    expect(status).toBe(201);
    expect(json.kind).toBe("static"); // served as files, not a long-lived container
    // the build output was promoted to the served root (source gone, dist/ flattened)
    const siteDir = run.store.siteDir(json.slug as string);
    expect(await readFile(join(siteDir, "index.html"), "utf8")).toContain("built by fake");
    await expect(stat(join(siteDir, "dist"))).rejects.toThrow(); // dist/ promoted away
    // …and the build is visible in the logs (self-repair depth + L9 marker)
    const logs = (await (await fetch(`${base}/api/deployments/${json.id}/logs`)).json()) as { logs: Array<{ message: string }> };
    expect(logs.logs.some((l) => l.message.includes("serving dist/"))).toBe(true);
  });

  it("with the dynamic lane OFF, a dynamic upload stays static (M1 behaviour preserved)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oprun-m1-"));
    const config: RunConfig = { ...configFromEnv({}), dataDir: dir, baseDomain: "test.sh", publicBase: "http://localhost" };
    const run = await createRunServer(config); // dynamicEnabled defaults off → no orchestrator
    expect(run.orchestrator).toBeUndefined();
    await new Promise<void>((r) => run.server.listen(0, "127.0.0.1", r));
    servers.push(run.server);
    const base = `http://127.0.0.1:${(run.server.address() as AddressInfo).port}`;

    const { status, json } = await deployFull(base, await makeDynamicTarball());
    expect(status).toBe(201);
    expect(json.kind).toBe("static");
    // and the static files landed on disk for the edge to serve
    await expect(stat(join(run.store.siteDir(json.slug as string), "server.js"))).resolves.toBeTruthy();
  });
});

/** A dynamic engine that deploys fine but refuses to wake from idle — exercises
 *  the server's white-label 502 on an ensureRunning failure (D24 / D7). */
class WakeFailFake extends LiveContainerFake {
  failWake = false;
  override async start(id: string): Promise<void> {
    if (this.failWake) throw new Error("ENOSPC: no space left on /var/lib/openpouch/containers");
    return super.start(id);
  }
}

// D24 / PRD R11: surfaces an END CUSTOMER reaches at <slug>.<baseDomain> must be
// neutral / white-label — no openpouch/agent branding, no internal error detail.
// The apex host (the developer/USER surface) keeps its full "built for agents"
// branding. The deployed app itself is reverse-proxied and untouched.
describe("run-d white-label end-customer surfaces (D24/R11)", () => {
  it("keeps the apex host landing fully branded — a USER surface, not white-label", async () => {
    const { base } = await start({});
    const port = Number(new URL(base).port);
    const res = await httpGetHost(port, "/", "test.sh");
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/openpouch|We never ask/i); // built-for-agents branding is correct here
  });

  it("serves a neutral page for an expired/unknown preview subdomain — never the branded landing", async () => {
    const { base } = await start({});
    const port = Number(new URL(base).port);
    const res = await httpGetHost(port, "/", "ghost.test.sh");
    expect(res.status).toBe(404);
    expect(res.body.toLowerCase()).toContain("no longer available");
    // the leak this fixes: a dead subdomain used to fall through to the branded landing
    expect(res.body).not.toMatch(/openpouch|🦘|we never ask|built for agents/i);
  });

  it("serves a neutral white-label 502 when a running container stops responding", async () => {
    const fake = new LiveContainerFake();
    servers.push({ close: () => fake.closeAll() });
    const { base, port } = await startDynamic(fake);
    const { json } = await deployFull(base, await makeDynamicTarball());
    const slug = json.slug as string;
    expect((await httpGetHost(port, "/", `${slug}.test.sh`)).status).toBe(200); // live…

    fake.closeAll(); // …container crashes while the record still says "running"
    const res = await httpGetHost(port, "/", `${slug}.test.sh`);
    expect(res.status).toBe(502);
    expect(res.body.toLowerCase()).toContain("unavailable");
    expect(res.body).not.toMatch(/openpouch|🦘|\bagent\b|we never ask/i);
  });

  it("serves a neutral white-label 502 with NO internal detail when a container fails to wake (D7)", async () => {
    const fake = new WakeFailFake();
    servers.push({ close: () => fake.closeAll() });
    const { base, port, run } = await startDynamic(fake);
    const { json } = await deployFull(base, await makeDynamicTarball());
    const slug = json.slug as string;

    await run.orchestrator!.idleSweep(Date.now() + 16 * 60_000); // idle-stop
    expect(run.store.get(slug)?.runtimeStatus).toBe("stopped");
    fake.failWake = true; // the next wake throws an internal-looking error

    const res = await httpGetHost(port, "/", `${slug}.test.sh`);
    expect(res.status).toBe(502);
    expect(res.body.toLowerCase()).toContain("unavailable");
    // the internal error detail must never reach the end customer
    expect(res.body).not.toMatch(/ENOSPC|\/var\/lib|openpouch|🦘/i);
  });
});
