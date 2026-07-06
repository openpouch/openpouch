import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@openpouch/core";
import { run } from "../src/main.js";

async function makeProject(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openpouch-test-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      scripts: { build: "npm run compile", start: "node server.js" },
      dependencies: { express: "^4.0.0" },
    }),
  );
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "server.js"),
    "const db = process.env.DATABASE_URL;\nconst port = process.env.PORT;\nconst env = process.env.NODE_ENV;\n",
  );
  return dir;
}

const stubAdapter: ProviderAdapter = {
  id: "render",
  async listServices() {
    return [
      { id: "srv-stub1", name: "demo-app", url: "https://demo-app.onrender.com", branch: "main", runtime: "node" },
      { id: "srv-other", name: "unrelated", branch: "main" },
    ];
  },
  async getService(id) {
    return { id, name: "demo-app", url: "https://demo-app.onrender.com", branch: "main", runtime: "node", suspended: false };
  },
  async getRecentDeploys() {
    return [
      { id: "dep-1", status: "live", commit: "abcdef1234", commitMessage: "feat: x", createdAt: "2026-06-12T10:00:00Z", finishedAt: "2026-06-12T10:05:00Z" },
    ];
  },
  async getEnvVarNames() {
    return [
      { name: "PORT", present: true },
      { name: "LEGACY_FLAG", present: true },
    ];
  },
  async getLogs() {
    return [];
  },
  async triggerDeploy() {
    return { id: "dep-new", status: "building" as const, createdAt: "2026-06-12T12:00:00Z" };
  },
  async getDeploy() {
    return {
      id: "dep-new",
      status: "live" as const,
      commit: "deadbeef99",
      createdAt: "2026-06-12T12:00:00Z",
      finishedAt: "2026-06-12T12:01:00Z",
    };
  },
};

const ctx = (cwd: string) => ({
  cwd,
  env: { RENDER_API_KEY: "rnd_test" },
  createAdapter: () => stubAdapter,
});

describe("openpouch init", () => {
  it("detects the project, writes manifest + policy, maps the matching service", async () => {
    const dir = await makeProject("demo-app");
    const result = await run(["init", "--json"], ctx(dir));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as Record<string, never>;
    expect(json["detected"]).toMatchObject({
      name: "demo-app",
      framework: "node",
      buildCommand: "npm run compile",
      envVars: ["DATABASE_URL", "PORT"], // NODE_ENV excluded by design
    });
    expect(json["production"]).toMatchObject({ serviceId: "srv-stub1" });

    const manifest = JSON.parse(await readFile(join(dir, "deploy.manifest.json"), "utf8")) as {
      env: Array<{ name: string; required: boolean }>;
      environments: { production?: { serviceId?: string } };
    };
    expect(manifest.environments.production?.serviceId).toBe("srv-stub1");
    expect(manifest.env.find((e) => e.name === "PORT")?.required).toBe(false);
    expect(manifest.env.find((e) => e.name === "DATABASE_URL")?.required).toBe(true);

    const policy = JSON.parse(await readFile(join(dir, "deploy.policy.json"), "utf8")) as Record<string, unknown>;
    expect(policy["version"]).toBe(0);
  });

  it("is idempotent: second run without --force changes nothing", async () => {
    const dir = await makeProject("demo-app");
    await run(["init"], ctx(dir));
    const before = await readFile(join(dir, "deploy.manifest.json"), "utf8");
    const second = await run(["init", "--json"], ctx(dir));
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.output)).toMatchObject({ ok: true, alreadyInitialized: true });
    expect(await readFile(join(dir, "deploy.manifest.json"), "utf8")).toBe(before);
  });
});

describe("openpouch init — data persistence (L10/D20)", () => {
  it("flags an app that writes data locally (embedded DB dep + fs writes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-data-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "notes", dependencies: { "better-sqlite3": "^9" }, scripts: { start: "node server.js" } }));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "db.js"), "const fs=require('fs'); fs.writeFileSync('./notes.json','[]');");
    const result = await run(["init", "--json"], ctx(dir));
    const json = JSON.parse(result.output) as { detected: { dataPersistence: { storesData: boolean; signals: string[] } }; hints: string[] };
    expect(json.detected.dataPersistence.storesData).toBe(true);
    expect(json.detected.dataPersistence.signals).toContain("SQLite database (better-sqlite3)");
    expect(json.detected.dataPersistence.signals.some((s) => s.includes("writes files to disk"))).toBe(true);
    expect(json.hints.some((h) => h.includes("store data locally"))).toBe(true);
  });

  it("does NOT flag an app that uses only an external database (no local writes)", async () => {
    // makeProject = express + DATABASE_URL env (external DB), no local disk writes
    const dir = await makeProject("ext-db");
    const json = JSON.parse((await run(["init", "--json"], ctx(dir))).output) as { detected: { dataPersistence: { storesData: boolean } } };
    expect(json.detected.dataPersistence.storesData).toBe(false);
  });

  it("flags Prisma with a local SQLite datasource (schema provider = sqlite)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-prisma-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "p", dependencies: { "@prisma/client": "^5" }, scripts: { start: "node server.js" } }));
    await mkdir(join(dir, "prisma"), { recursive: true });
    await writeFile(join(dir, "prisma", "schema.prisma"), 'datasource db {\n  provider = "sqlite"\n  url      = "file:./dev.db"\n}\n');
    const json = JSON.parse((await run(["init", "--json"], ctx(dir))).output) as { detected: { dataPersistence: { storesData: boolean; signals: string[] } } };
    expect(json.detected.dataPersistence.storesData).toBe(true);
    expect(json.detected.dataPersistence.signals).toContain("Prisma with a local SQLite database");
  });

  it("does NOT flag Prisma with a remote provider (postgresql)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-prisma-pg-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "p", dependencies: { "@prisma/client": "^5" }, scripts: { start: "node server.js" } }));
    await mkdir(join(dir, "prisma"), { recursive: true });
    await writeFile(join(dir, "prisma", "schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n');
    const json = JSON.parse((await run(["init", "--json"], ctx(dir))).output) as { detected: { dataPersistence: { storesData: boolean } } };
    expect(json.detected.dataPersistence.storesData).toBe(false);
  });

  it("flags a database file bundled at the project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-dbfile-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "d", scripts: { start: "node server.js" } }));
    await writeFile(join(dir, "app.db"), "");
    const json = JSON.parse((await run(["init", "--json"], ctx(dir))).output) as { detected: { dataPersistence: { storesData: boolean; signals: string[] } } };
    expect(json.detected.dataPersistence.storesData).toBe(true);
    expect(json.detected.dataPersistence.signals.some((s) => s.includes("app.db"))).toBe(true);
  });
});

describe("openpouch inspect — deploy-provided env vars (OpenClaw 2026-07-04)", () => {
  it("surfaces --var names from local evidence as deployProvided, with a hint when the provider shows none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-insp-run-"));
    const home = await mkdtemp(join(tmpdir(), "openpouch-insp-home-"));
    await writeFile(
      join(dir, "deploy.manifest.json"),
      JSON.stringify({
        version: 0,
        project: { name: "api-app", framework: "vite" },
        env: [],
        environments: { preview: { provider: "openpouch-run", serviceId: "api-app-zzz999", url: "https://api-app-zzz999.openpouch.sh" } },
      }),
    );
    await writeFile(
      join(dir, "deploy.evidence.json"),
      JSON.stringify({
        version: 0,
        deployments: [
          {
            id: "api-app-zzz999",
            environment: "preview",
            provider: "openpouch-run",
            status: "live",
            url: "https://api-app-zzz999.openpouch.sh",
            deployedAt: "2026-07-04T08:19:02.000Z",
            envVarNames: ["OPENPOUCH_TEST_MESSAGE"],
          },
        ],
      }),
    );
    const runStub: ProviderAdapter = {
      id: "openpouch-run",
      envIntrospection: "unavailable", // mirrors the real adapter: [] would mean "cannot look", not "none exist"
      listServices: async () => [],
      getService: async (id) => ({ id, name: id, url: "https://api-app-zzz999.openpouch.sh", suspended: false }),
      getRecentDeploys: async () => [{ id: "api-app-zzz999", status: "live" as const, createdAt: "2026-07-04T08:19:02.000Z" }],
      getEnvVarNames: async () => [], // the instant lane never exposes env vars via the API
      getLogs: async () => [],
      triggerDeploy: async () => {
        throw new Error("unsupported");
      },
      getDeploy: async (_s, id) => ({ id, status: "live" as const, createdAt: "2026-07-04T08:19:02.000Z" }),
    };
    const result = await run(["inspect", "--json"], { cwd: dir, env: { OPENPOUCH_HOME: home }, createAdapter: () => runStub });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as {
      url?: string;
      environments: {
        preview: {
          envVars: { runtimeIntrospection: string; present?: string[]; missingRequired: string[]; deployProvided?: string[] };
        };
      };
      hints: string[];
    };
    // Hermes 2026-07-05: deploy/verify carry the live URL top-level — inspect does too
    expect(json.url).toBe("https://api-app-zzz999.openpouch.sh");
    // deploy said the var was set, the runtime had it — inspect now says so too
    expect(json.environments.preview.envVars.deployProvided).toEqual(["OPENPOUCH_TEST_MESSAGE"]);
    // OpenClaw 2026-07-05 #2: no `present: []` on the instant lane — the shape
    // says explicitly that runtime introspection is unavailable instead of
    // looking like "env vars are missing".
    expect(json.environments.preview.envVars.runtimeIntrospection).toBe("unavailable");
    expect(json.environments.preview.envVars.present).toBeUndefined();
    expect(json.environments.preview.envVars.missingRequired).toEqual([]);
    expect(json.hints.some((h) => h.includes("provided at deploy time"))).toBe(true);
  });

  it("computes missingRequired from local evidence when introspection is unavailable (OpenClaw 2026-07-05)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-insp-req-"));
    const home = await mkdtemp(join(tmpdir(), "openpouch-insp-reqhome-"));
    await writeFile(
      join(dir, "deploy.manifest.json"),
      JSON.stringify({
        version: 0,
        project: { name: "api-app", framework: "vite" },
        env: [
          { name: "STRIPE_KEY", required: true },
          { name: "PUBLIC_URL", required: false },
        ],
        environments: { preview: { provider: "openpouch-run", serviceId: "api-app-req111", url: "https://api-app-req111.openpouch.sh" } },
      }),
    );
    await writeFile(
      join(dir, "deploy.evidence.json"),
      JSON.stringify({
        version: 0,
        deployments: [
          {
            id: "api-app-req111",
            environment: "preview",
            provider: "openpouch-run",
            status: "live",
            url: "https://api-app-req111.openpouch.sh",
            deployedAt: "2026-07-05T09:00:00.000Z",
            envVarNames: ["PUBLIC_URL"],
          },
        ],
      }),
    );
    const runStub: ProviderAdapter = {
      id: "openpouch-run",
      envIntrospection: "unavailable",
      listServices: async () => [],
      getService: async (id) => ({ id, name: id, url: "https://api-app-req111.openpouch.sh", suspended: false }),
      getRecentDeploys: async () => [{ id: "api-app-req111", status: "live" as const, createdAt: "2026-07-05T09:00:00.000Z" }],
      getEnvVarNames: async () => [],
      getLogs: async () => [],
      triggerDeploy: async () => {
        throw new Error("unsupported");
      },
      getDeploy: async (_s, id) => ({ id, status: "live" as const, createdAt: "2026-07-05T09:00:00.000Z" }),
    };
    const result = await run(["inspect", "--json"], { cwd: dir, env: { OPENPOUCH_HOME: home }, createAdapter: () => runStub });
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as {
      environments: { preview: { envVars: { runtimeIntrospection: string; missingRequired: string[] } } };
    };
    // The required var was NOT among the deploy-provided names — local evidence
    // proves the miss even though the provider API can't be asked.
    expect(json.environments.preview.envVars.runtimeIntrospection).toBe("unavailable");
    expect(json.environments.preview.envVars.missingRequired).toEqual(["STRIPE_KEY"]);
  });

  it("top-level url prefers an active production service over preview, and skips suspended ones (Hermes 2026-07-05)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-insp-url-"));
    const home = await mkdtemp(join(tmpdir(), "openpouch-insp-urlhome-"));
    const manifest = (prodSuspended: boolean) => ({
      version: 0,
      project: { name: "api-app", framework: "vite" },
      env: [],
      environments: {
        preview: { provider: "openpouch-run", serviceId: "app-preview-1", url: "https://app-preview-1.openpouch.sh" },
        production: { provider: "openpouch-run", serviceId: prodSuspended ? "app-prod-suspended" : "app-prod-1" },
      },
    });
    const runStub: ProviderAdapter = {
      id: "openpouch-run",
      envIntrospection: "unavailable",
      listServices: async () => [],
      getService: async (id) => ({ id, name: id, url: `https://${id}.openpouch.sh`, suspended: id.includes("suspended") }),
      getRecentDeploys: async () => [],
      getEnvVarNames: async () => [],
      getLogs: async () => [],
      triggerDeploy: async () => {
        throw new Error("unsupported");
      },
      getDeploy: async (_s, id) => ({ id, status: "live" as const, createdAt: "2026-07-05T09:00:00.000Z" }),
    };

    await writeFile(join(dir, "deploy.manifest.json"), JSON.stringify(manifest(false)));
    let result = await run(["inspect", "--json"], { cwd: dir, env: { OPENPOUCH_HOME: home }, createAdapter: () => runStub });
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.output) as { url?: string }).url).toBe("https://app-prod-1.openpouch.sh");

    // production suspended → the preview URL is the primary one
    await writeFile(join(dir, "deploy.manifest.json"), JSON.stringify(manifest(true)));
    result = await run(["inspect", "--json"], { cwd: dir, env: { OPENPOUCH_HOME: home }, createAdapter: () => runStub });
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.output) as { url?: string }).url).toBe("https://app-preview-1.openpouch.sh");
  });
});

describe("openpouch inspect", () => {
  it("exits 3 with a fix hint when no manifest exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-empty-"));
    const result = await run(["inspect", "--json"], ctx(dir));
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { fix: "Run `openpouch init` first.", suggestedCommand: "openpouch init" },
    });
  });

  it("reports live deploy, missing required vars, and provider drift", async () => {
    const dir = await makeProject("demo-app");
    await run(["init"], ctx(dir));
    const result = await run(["inspect", "--json"], ctx(dir));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as {
      environments: { production: { liveDeploy: { status: string; commit: string }; envVars: Record<string, string[]> } };
    };
    expect(json.environments.production.liveDeploy).toMatchObject({ status: "live", commit: "abcdef1234" });
    // DATABASE_URL is required in the manifest but absent on the provider:
    expect(json.environments.production.envVars["missingRequired"]).toEqual(["DATABASE_URL"]);
    // LEGACY_FLAG exists on the provider but not in the manifest (drift):
    expect(json.environments.production.envVars["extraOnProvider"]).toEqual(["LEGACY_FLAG"]);
  });
});

describe("usage", () => {
  it("unknown command exits 2 with machine-readable error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-usage-"));
    const result = await run(["explode", "--json"], ctx(dir));
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: { category: "usage" } });
  });
});

describe("openpouch --version", () => {
  const bare = { cwd: ".", env: {} };
  it("prints the version with --version (exit 0)", async () => {
    const r = await run(["--version"], bare);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^openpouch \d+\.\d+\.\d+/);
  });
  it("also supports -v and the `version` command", async () => {
    expect((await run(["-v"], bare)).output).toMatch(/^openpouch \d+\.\d+\.\d+/);
    expect((await run(["version"], bare)).output).toMatch(/^openpouch \d+\.\d+\.\d+/);
  });
  it("emits a machine-readable object with --json", async () => {
    const json = JSON.parse((await run(["--version", "--json"], bare)).output) as { ok: boolean; version: string };
    expect(json.ok).toBe(true);
    expect(json.version).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("command-specific help (OpenClaw 2026-07-04)", () => {
  const bare = { cwd: ".", env: {} };

  it("deploy --help shows the deploy page, not the global one", async () => {
    const result = await run(["deploy", "--help"], bare);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("usage: openpouch deploy");
    expect(result.output).toContain("--health-path");
    expect(result.output).toContain("common failure");
    expect(result.output).not.toContain("usage: openpouch <command>");
  });

  it("help <cmd> works too and carries the command's flags", async () => {
    const logs = await run(["help", "logs"], bare);
    expect(logs.exitCode).toBe(0);
    expect(logs.output).toContain("--limit");
    const verify = await run(["help", "verify"], bare);
    expect(verify.output).toContain("--health-path");
    expect(verify.output).toContain("exit 8");
  });

  it("every registered command has a help page", async () => {
    for (const cmd of ["deploy", "list", "delete", "signup", "activate", "whoami", "init", "inspect", "plan", "preview", "prod", "approve", "verify", "logs", "rollback", "feedback"]) {
      const result = await run([cmd, "--help"], bare);
      expect(result.exitCode, cmd).toBe(0);
      expect(result.output, cmd).toContain(`usage: openpouch ${cmd}`);
    }
  });

  it("help for an unknown command exits 2 and falls back to the global usage", async () => {
    const result = await run(["help", "nonsense"], bare);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("unknown command: nonsense");
    expect(result.output).toContain("usage: openpouch <command>");
  });

  it("--json returns the help as a structured object", async () => {
    const result = await run(["deploy", "--help", "--json"], bare);
    const json = JSON.parse(result.output) as { ok: boolean; command: string; help: string[] };
    expect(json.ok).toBe(true);
    expect(json.command).toBe("deploy");
    expect(json.help.some((l) => l.includes("--health-path"))).toBe(true);
  });

  it("bare --help still shows the global page", async () => {
    const result = await run(["--help"], bare);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("usage: openpouch <command>");
  });
});
