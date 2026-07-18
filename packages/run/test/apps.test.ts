import { spawn } from "node:child_process";
import { readFile, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildSpec, ContainerEngine, CreateSpec } from "../src/engine.js";
import type { BindConfirmMail, InactivityWarningMail, Mailer, VerificationMail } from "../src/mailer.js";
import { NullRouter } from "../src/router.js";
import { configFromEnv, createRunServer, type RunConfig, type RunServerDeps } from "../src/server.js";

/**
 * L12 — named apps: a redeploy of the same (account, app) updates the existing
 * record behind its STABLE slug/URL instead of minting a fresh one. The new
 * content is proven on a transient shadow first; the live version survives a
 * failed update untouched.
 */

const servers: { close: () => void }[] = [];
const fakes: LiveContainerFake[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const f of fakes.splice(0)) f.closeAll();
});

class CapturingMailer implements Mailer {
  sent: VerificationMail[] = [];
  warnings: InactivityWarningMail[] = [];
  binds: BindConfirmMail[] = [];
  async sendVerification(mail: VerificationMail): Promise<void> {
    this.sent.push(mail);
  }
  async sendInactivityWarning(mail: InactivityWarningMail): Promise<void> {
    this.warnings.push(mail);
  }
  async sendBindConfirm(mail: BindConfirmMail): Promise<void> {
    this.binds.push(mail);
  }
}

function tarballBuffer(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    tar.stdout.on("data", (c: Buffer) => chunks.push(c));
    tar.on("error", reject);
    tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
  });
}

async function staticTarball(marker: string): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "oprun-l12-site-"));
  await writeFile(join(src, "index.html"), `<h1>${marker}</h1>`);
  return tarballBuffer(src);
}

async function dynamicTarball(marker: string): Promise<Buffer> {
  const src = await mkdtemp(join(tmpdir(), "oprun-l12-app-"));
  await writeFile(join(src, "package.json"), JSON.stringify({ name: "l12-app", scripts: { start: "node server.js" } }));
  await writeFile(join(src, "server.js"), `// ${marker}\nrequire('http').createServer((_q,s)=>s.end('${marker}')).listen(process.env.PORT)`);
  return tarballBuffer(src);
}

/** Containers are real local HTTP servers answering with the marker baked into server.js. */
class LiveContainerFake implements ContainerEngine {
  private readonly entries = new Map<string, { server: Server; port: number; listening: boolean }>();
  private seq = 0;
  failNextBuild = false;
  async build(spec: BuildSpec): Promise<{ ok: boolean; logs: string }> {
    void spec;
    if (this.failNextBuild) {
      this.failNextBuild = false;
      return { ok: false, logs: "npm ERR! broken lockfile (faked)" };
    }
    return { ok: true, logs: "" };
  }
  async buildApp(): Promise<{ ok: boolean; logs: string }> {
    return { ok: true, logs: "" };
  }
  async create(spec: CreateSpec): Promise<string> {
    const id = `live-${spec.slug}-${++this.seq}`;
    // Answer with the marker from the mounted /data volume when present (proves
    // the container reads pushed data after a restart), else from the site
    // dir's server.js (proves WHICH code version serves after an update swap).
    const server = createServer((_req, res) => {
      void (async () => {
        let marker = "unknown";
        try {
          marker = spec.volumeDir !== undefined ? (await readFile(join(spec.volumeDir, "marker.txt"), "utf8")).trim() : "no-volume";
          if (marker === "" || spec.volumeDir === undefined) throw new Error("fall through");
        } catch {
          try {
            const src = await readFile(join(spec.siteDir, "server.js"), "utf8");
            marker = /end\('([^']+)'\)/.exec(src)?.[1] ?? "unknown";
          } catch {
            // dir gone — keep current marker
          }
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(marker);
      })();
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
    this.entries.clear();
  }
}

function makeFake(): LiveContainerFake {
  const f = new LiveContainerFake();
  fakes.push(f);
  return f;
}

async function start(deps: RunServerDeps = {}, overrides: Partial<RunConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oprun-l12-"));
  const base = configFromEnv({});
  const config: RunConfig = {
    ...base,
    dataDir: dir,
    baseDomain: "test.sh",
    publicBase: "http://localhost",
    accounts: { ...base.accounts, publicBase: "http://localhost" },
    ...overrides,
  };
  const run = await createRunServer(config, deps);
  await new Promise<void>((r) => run.server.listen(0, "127.0.0.1", r));
  servers.push(run.server);
  const port = (run.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, run, dir };
}

async function signupKey(base: string, mailer: CapturingMailer, email = "l12@example.com"): Promise<string> {
  const created = await fetch(`${base}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(created.status).toBe(201);
  const u = new URL(mailer.sent.at(-1)!.verifyUrl);
  const verify = await fetch(`${base}/api/accounts/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: u.searchParams.get("account"), token: u.searchParams.get("token") }),
  });
  expect(verify.status).toBe(200);
  return ((await verify.json()) as { key: string }).key;
}

function deployApp(base: string, tarball: Buffer, opts: { key?: string; app?: string } = {}) {
  return fetch(`${base}/api/deployments`, {
    method: "POST",
    headers: {
      "content-type": "application/gzip",
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.app ? { "x-openpouch-app": opts.app } : {}),
    },
    body: tarball as unknown as BodyInit,
  });
}

function httpGetHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += String(c)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("L12 named apps — stable URLs across redeploys", () => {
  it("keyed --app deploy creates a named app; the same app name redeploys BEHIND THE SAME URL (static swap)", async () => {
    const mailer = new CapturingMailer();
    const { base, run } = await start({ mailer });
    const key = await signupKey(base, mailer);

    const first = await deployApp(base, await staticTarball("v1"), { key, app: "shop" });
    expect(first.status).toBe(201);
    const one = (await first.json()) as Record<string, unknown>;
    expect(one["app"]).toBe("shop");
    expect(one["updated"]).toBe(false);
    expect(String(one["slug"])).toMatch(/^shop-/);
    expect(await readFile(join(run.store.siteDir(String(one["slug"])), "index.html"), "utf8")).toContain("v1");

    const second = await deployApp(base, await staticTarball("v2"), { key, app: "shop" });
    expect(second.status).toBe(201);
    const two = (await second.json()) as Record<string, unknown>;
    // The identity promise: same id, same slug, same URL — content swapped.
    expect(two["slug"]).toBe(one["slug"]);
    expect(two["id"]).toBe(one["id"]);
    expect(two["url"]).toBe(one["url"]);
    expect(two["updated"]).toBe(true);
    expect(two["ownership"]).toBe("account");
    expect(await readFile(join(run.store.siteDir(String(one["slug"])), "index.html"), "utf8")).toContain("v2");

    // Exactly ONE live record — the shadow is gone, no slot was consumed.
    expect(run.store.list()).toHaveLength(1);
    const rec = run.store.get(String(one["slug"]))!;
    expect(rec.app).toBe("shop");
    expect(rec.lastRequestAt).toBeDefined(); // the update healed the rolling expiry (D25)
    const messages = rec.events.map((e) => e.message);
    expect(messages.some((m) => m.startsWith("update accepted"))).toBe(true);
    expect(messages.some((m) => m.startsWith("updated → live"))).toBe(true);

    // The owned list shows one app, named.
    const list = await fetch(`${base}/api/deployments`, { headers: { authorization: `Bearer ${key}` } });
    const owned = (await list.json()) as { deployments: Array<{ app?: string }> };
    expect(owned.deployments).toHaveLength(1);
    expect(owned.deployments[0]!.app).toBe("shop");
  });

  it("rejects --app without an account (no provable ownership to overwrite)", async () => {
    const { base } = await start();
    const res = await deployApp(base, await staticTarball("v1"), { app: "shop" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; fix: string };
    expect(body.error).toContain("need an account");
    expect(body.fix).toContain("openpouch signup");
  });

  it("rejects an invalid app name with a usage-grade fix", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({ mailer });
    const key = await signupKey(base, mailer);
    const res = await deployApp(base, await staticTarball("v1"), { key, app: "Shop_Prod!" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("invalid app name");
  });

  it("the same app name under ANOTHER account is a different app — never an overwrite", async () => {
    const mailer = new CapturingMailer();
    const { base } = await start({ mailer });
    const keyA = await signupKey(base, mailer, "a@example.com");
    const keyB = await signupKey(base, mailer, "b@example.com");
    const a = (await (await deployApp(base, await staticTarball("va"), { key: keyA, app: "shop" })).json()) as Record<string, unknown>;
    const b = (await (await deployApp(base, await staticTarball("vb"), { key: keyB, app: "shop" })).json()) as Record<string, unknown>;
    expect(b["updated"]).toBe(false);
    expect(b["slug"]).not.toBe(a["slug"]);
  });

  it("updates a DYNAMIC app behind the same URL — new container serves the new version (stop-swap-start)", async () => {
    const mailer = new CapturingMailer();
    const engine = makeFake();
    const base0 = configFromEnv({});
    const { base, port, run } = await start(
      { mailer, engine, router: new NullRouter() },
      { dynamicEnabled: true, dynamic: { ...base0.dynamic, portMin: 24300, portMax: 24399 } },
    );
    const key = await signupKey(base, mailer);

    const first = await deployApp(base, await dynamicTarball("api-v1"), { key, app: "api" });
    expect(first.status).toBe(201);
    const one = (await first.json()) as Record<string, unknown>;
    expect(one["kind"]).toBe("dynamic");
    const host = `${String(one["slug"])}.test.sh`;
    expect((await httpGetHost(port, host)).body).toBe("api-v1");
    const containerBefore = run.store.get(String(one["slug"]))!.containerId;

    const second = await deployApp(base, await dynamicTarball("api-v2"), { key, app: "api" });
    expect(second.status).toBe(201);
    const two = (await second.json()) as Record<string, unknown>;
    expect(two["slug"]).toBe(one["slug"]);
    expect(two["updated"]).toBe(true);
    // Same URL, new container, new version answering.
    expect((await httpGetHost(port, host)).body).toBe("api-v2");
    const rec = run.store.get(String(one["slug"]))!;
    expect(rec.containerId).not.toBe(containerBefore);
    expect(rec.runtimeStatus).toBe("running");
    expect(run.store.list()).toHaveLength(1);
  });

  it("a FAILED update leaves the previous version serving untouched (build fails on the shadow)", async () => {
    const mailer = new CapturingMailer();
    const engine = makeFake();
    const base0 = configFromEnv({});
    const { base, port, run } = await start(
      { mailer, engine, router: new NullRouter() },
      { dynamicEnabled: true, dynamic: { ...base0.dynamic, portMin: 24400, portMax: 24499 } },
    );
    const key = await signupKey(base, mailer);

    const first = await deployApp(base, await dynamicTarball("stable-v1"), { key, app: "api" });
    const one = (await first.json()) as Record<string, unknown>;
    const host = `${String(one["slug"])}.test.sh`;
    const containerBefore = run.store.get(String(one["slug"]))!.containerId;

    engine.failNextBuild = true;
    const second = await deployApp(base, await dynamicTarball("broken-v2"), { key, app: "api" });
    expect(second.status).toBe(422);
    const err = (await second.json()) as { error: string; logs?: string; url?: string };
    expect(err.error).toContain("previous version is still live");
    expect(err.logs).toContain("broken lockfile");

    // The live app never blinked: same container, same answer, one record, no shadow left.
    const rec = run.store.get(String(one["slug"]))!;
    expect(rec.containerId).toBe(containerBefore);
    expect((await httpGetHost(port, host)).body).toBe("stable-v1");
    expect(run.store.list()).toHaveLength(1);
    expect(rec.events.map((e) => e.message).some((m) => m.includes("previous version is still live"))).toBe(true);
  });

  it("an update can change the app's kind: static → dynamic behind the same URL", async () => {
    const mailer = new CapturingMailer();
    const engine = makeFake();
    const base0 = configFromEnv({});
    const { base, port, run } = await start(
      { mailer, engine, router: new NullRouter() },
      { dynamicEnabled: true, dynamic: { ...base0.dynamic, portMin: 24500, portMax: 24599 } },
    );
    const key = await signupKey(base, mailer);

    const first = await deployApp(base, await staticTarball("landing"), { key, app: "site" });
    const one = (await first.json()) as Record<string, unknown>;
    expect(one["kind"]).toBe("static");

    const second = await deployApp(base, await dynamicTarball("now-dynamic"), { key, app: "site" });
    expect(second.status).toBe(201);
    const two = (await second.json()) as Record<string, unknown>;
    expect(two["slug"]).toBe(one["slug"]);
    expect(two["kind"]).toBe("dynamic");
    expect((await httpGetHost(port, `${String(one["slug"])}.test.sh`)).body).toBe("now-dynamic");
    expect(run.store.get(String(one["slug"]))!.kind).toBe("dynamic");
  });
});

describe("L13 data channel — push/pull/ls on a named app's /data volume", () => {
  const VOLUME_TIERS = {
    anonymous: { name: "anonymous", deploysPerHour: 100, deploysPerDay: 100, maxLiveDeployments: 10, maxBytes: 1e9, maxDynamic: 5, volumeMaxBytes: 0, maxAlwaysOn: 0 },
    free: { name: "free", deploysPerHour: 100, deploysPerDay: 100, maxLiveDeployments: 10, maxBytes: 1e9, maxDynamic: 5, volumeMaxBytes: 64 * 1024 * 1024, maxAlwaysOn: 0 },
  };

  async function dataTarball(marker: string): Promise<Buffer> {
    const src = await mkdtemp(join(tmpdir(), "oprun-l13-data-"));
    await writeFile(join(src, "marker.txt"), marker);
    await writeFile(join(src, "inventory.db"), `sqlite-bytes-${marker}`);
    return tarballBuffer(src);
  }

  let nextPortBase = 24600;
  async function startVolumeApp() {
    const mailer = new CapturingMailer();
    const engine = makeFake();
    const base0 = configFromEnv({});
    const portMin = nextPortBase;
    nextPortBase += 50;
    const started = await start(
      { mailer, engine, router: new NullRouter() },
      {
        dynamicEnabled: true,
        dynamic: { ...base0.dynamic, portMin, portMax: portMin + 49 },
        accounts: { ...base0.accounts, publicBase: "http://localhost", tiers: VOLUME_TIERS },
      },
    );
    const key = await signupKey(started.base, mailer);
    const res = await fetch(`${started.base}/api/deployments`, {
      method: "POST",
      headers: {
        "content-type": "application/gzip",
        authorization: `Bearer ${key}`,
        "x-openpouch-app": "inv",
        "x-openpouch-volume": "1",
      },
      body: (await dynamicTarball("code-v1")) as unknown as BodyInit,
    });
    expect(res.status).toBe(201);
    const dep = (await res.json()) as Record<string, unknown>;
    return { ...started, key, dep, mailer };
  }

  it("push replaces the volume (container stopped for the write, restarted health-gated), app serves the pushed data; ls and pull round-trip", async () => {
    const { base, port, key, dep, dir } = await startVolumeApp();
    const host = `${String(dep["slug"])}.test.sh`;

    // The volume dir is a live bind-mount TARGET: capture its inode so we can
    // prove push replaces CONTENTS, never the dir itself (a rename would
    // strand a stopped container's mount on the old inode — the app then
    // wakes with an empty /data; found live 2026-07-18 by the 0.4.0 self-smoke).
    const volBase = join(dir, "volumes");
    const acct = (await readdir(volBase))[0]!;
    const volDir = join(volBase, acct, "inv");
    const inoBefore = (await stat(volDir)).ino;

    const push = await fetch(`${base}/api/apps/inv/data`, {
      method: "PUT",
      headers: { "content-type": "application/gzip", authorization: `Bearer ${key}` },
      body: (await dataTarball("migrated-data")) as unknown as BodyInit,
    });
    expect(push.status).toBe(200);
    const pushed = (await push.json()) as { restarted: boolean };
    expect(pushed.restarted).toBe(true);
    expect((await stat(volDir)).ino).toBe(inoBefore); // same dir object — mount stays valid
    // The running app now answers with the PUSHED data — the whole point of a migration.
    expect((await httpGetHost(port, host)).body).toBe("migrated-data");

    const ls = await fetch(`${base}/api/apps/inv/data?list=1`, { headers: { authorization: `Bearer ${key}` } });
    const listing = (await ls.json()) as { files: Array<{ path: string; bytes: number }> };
    expect(listing.files.map((f) => f.path).sort()).toEqual(["inventory.db", "marker.txt"]);

    const pull = await fetch(`${base}/api/apps/inv/data`, { headers: { authorization: `Bearer ${key}` } });
    expect(pull.status).toBe(200);
    expect(pull.headers.get("content-type")).toBe("application/gzip");
    const tgz = Buffer.from(await pull.arrayBuffer());
    expect(tgz.length).toBeGreaterThan(0);
    // Round-trip: the backup contains exactly the pushed files.
    const outDir = await mkdtemp(join(tmpdir(), "oprun-l13-pull-"));
    const tgzFile = join(outDir, "backup.tgz");
    await writeFile(tgzFile, tgz);
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-xzf", tgzFile, "-C", outDir]);
      tar.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`tar ${c}`))));
    });
    expect((await readFile(join(outDir, "marker.txt"), "utf8")).trim()).toBe("migrated-data");
  });

  it("push on an app WITHOUT a volume gets a 400 with the redeploy fix", async () => {
    const mailer = new CapturingMailer();
    const engine = makeFake();
    const base0 = configFromEnv({});
    const { base } = await start(
      { mailer, engine, router: new NullRouter() },
      { dynamicEnabled: true, dynamic: { ...base0.dynamic, portMin: 24700, portMax: 24799 }, accounts: { ...base0.accounts, publicBase: "http://localhost", tiers: VOLUME_TIERS } },
    );
    const key = await signupKey(base, mailer);
    await deployApp(base, await dynamicTarball("v1"), { key, app: "novol" });
    const push = await fetch(`${base}/api/apps/novol/data`, {
      method: "PUT",
      headers: { "content-type": "application/gzip", authorization: `Bearer ${key}` },
      body: (await dataTarball("x")) as unknown as BodyInit,
    });
    expect(push.status).toBe(400);
    expect(((await push.json()) as { fix: string }).fix).toContain("--volume");
  });

  it("the data channel is owner-only: anonymous 401, another account 404 (no name leak)", async () => {
    const { base, mailer } = await startVolumeApp();
    const anon = await fetch(`${base}/api/apps/inv/data?list=1`);
    expect(anon.status).toBe(401);
    // A REAL second account on the same instance must not see (or write) the app.
    const otherKey = await signupKey(base, mailer, "other@example.com");
    const foreign = await fetch(`${base}/api/apps/inv/data?list=1`, { headers: { authorization: `Bearer ${otherKey}` } });
    expect(foreign.status).toBe(404);
  });
});
