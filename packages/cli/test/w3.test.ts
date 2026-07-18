import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPolicy, type Manifest, type ProviderAdapter } from "@openpouch/core";
import { run } from "../src/main.js";
import { resolveDefaultEnvironment } from "../src/shared.js";

interface DeployCall {
  serviceId: string;
  opts?: { clearCache?: boolean; commitId?: string };
}

function makeAdapter(deployCalls: DeployCall[]): ProviderAdapter {
  return {
    id: "render",
    async listServices() {
      return [];
    },
    async getService(id) {
      return { id, name: "demo-app", suspended: false };
    },
    async getRecentDeploys() {
      return [
        { id: "dep-prior", status: "live" as const, commit: "0ldc0mmit0", createdAt: "2026-06-12T09:00:00Z", finishedAt: "2026-06-12T09:05:00Z" },
      ];
    },
    async getEnvVarNames() {
      return [];
    },
    async getLogs(_id, opts) {
      return Array.from({ length: Math.min(opts?.limit ?? 50, 3) }, (_, i) => ({
        timestamp: `2026-06-12T16:00:0${i}Z`,
        message: `log line ${i}`,
      }));
    },
    async triggerDeploy(serviceId, opts) {
      deployCalls.push({ serviceId, ...(opts !== undefined ? { opts } : {}) });
      return { id: "dep-rollbacked", status: "building" as const, createdAt: "2026-06-12T16:00:00Z" };
    },
    async getDeploy(_serviceId, deployId) {
      if (deployId === "dep-prior") {
        return { id: "dep-prior", status: "live" as const, commit: "0ldc0mmit0", createdAt: "2026-06-12T09:00:00Z", finishedAt: "2026-06-12T09:05:00Z" };
      }
      return { id: deployId, status: "live" as const, commit: "0ldc0mmit0", createdAt: "2026-06-12T16:00:00Z", finishedAt: "2026-06-12T16:01:00Z" };
    },
  };
}

async function makeWorkspace(): Promise<{ dir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openpouch-w3-"));
  const home = await mkdtemp(join(tmpdir(), "openpouch-w3home-"));
  await writeFile(
    join(dir, "deploy.manifest.json"),
    JSON.stringify({
      version: 0,
      project: { name: "demo-app" },
      env: [],
      environments: { production: { provider: "render", serviceId: "srv-prod" } },
    }),
  );
  await writeFile(join(dir, "deploy.policy.json"), JSON.stringify(defaultPolicy()));
  return { dir, home };
}

const ctx = (
  dir: string,
  home: string,
  adapter: ProviderAdapter,
  interactive?: { isTTY: boolean; confirm: () => Promise<boolean> },
) => ({
  cwd: dir,
  env: { RENDER_API_KEY: "rnd_test", OPENPOUCH_POLL_MS: "1", OPENPOUCH_DEPLOY_TIMEOUT_MS: "5000", OPENPOUCH_HOME: home },
  createAdapter: () => adapter,
  ...(interactive !== undefined ? { interactive } : {}),
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function approveLatest(dir: string, home: string, adapter: ProviderAdapter): Promise<void> {
  const list = await run(["approve", "--json"], ctx(dir, home, adapter));
  const pending = (JSON.parse(list.output) as { pending: Array<{ id: string }> }).pending;
  const id = pending[0]?.id;
  if (id === undefined) throw new Error("no pending approval");
  await run(["approve", id, "--json"], ctx(dir, home, adapter, { isTTY: true, confirm: async () => true }));
}

describe("openpouch logs", () => {
  it("returns structured log lines with --limit", async () => {
    const { dir, home } = await makeWorkspace();
    const result = await run(["logs", "--limit", "3", "--json"], ctx(dir, home, makeAdapter([])));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as {
      count: number;
      requestedLimit: number;
      logs: Array<{ message: string }>;
    };
    expect(json.count).toBe(3);
    // count < requestedLimit must read as "full tail", not "limit ignored"
    // (Codex field test 2026-07-06) — the requested limit is echoed back.
    expect(json.requestedLimit).toBe(3);
    expect(json.logs[0]?.message).toBe("log line 0");
  });
});

async function makeInstantWorkspace(): Promise<{ dir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openpouch-inst-"));
  const home = await mkdtemp(join(tmpdir(), "openpouch-insthome-"));
  // Instant-lane shape: a single `preview` environment, no `production`.
  await writeFile(
    join(dir, "deploy.manifest.json"),
    JSON.stringify({
      version: 0,
      project: { name: "demo-app" },
      env: [],
      environments: { preview: { provider: "render", serviceId: "srv-prev", url: "https://prev.example.test" } },
    }),
  );
  await writeFile(join(dir, "deploy.policy.json"), JSON.stringify(defaultPolicy()));
  return { dir, home };
}

describe("default environment (no --env) resolves to the deploy's env", () => {
  it("logs targets the single preview env on an instant-lane manifest, not production", async () => {
    const { dir, home } = await makeInstantWorkspace();
    // Before the fix this hard-defaulted to `production` → exit 3 "not mapped to a service".
    const result = await run(["logs", "--limit", "3", "--json"], ctx(dir, home, makeAdapter([])));
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.output) as { count: number }).count).toBe(3);
  });

  it("verify targets the single preview env on an instant-lane manifest, not production", async () => {
    const { dir, home } = await makeInstantWorkspace();
    const result = await run(["verify", "--json"], ctx(dir, home, makeAdapter([])));
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.output) as { ok: boolean }).ok).toBe(true);
  });

  it("still defaults to production when the manifest has one (governed lane unchanged)", async () => {
    const { dir, home } = await makeWorkspace();
    const result = await run(["logs", "--limit", "3", "--json"], ctx(dir, home, makeAdapter([])));
    expect(result.exitCode).toBe(0);
  });
});

describe("resolveDefaultEnvironment", () => {
  const mf = (environments: Manifest["environments"]): Manifest => ({
    version: 0,
    project: { name: "x" },
    env: [],
    environments,
  });
  it("prefers production when present (governed-lane back-compat)", () => {
    expect(resolveDefaultEnvironment(mf({ preview: { provider: "render" }, production: { provider: "render" } }))).toBe("production");
  });
  it("uses the single environment when there is exactly one (instant lane)", () => {
    expect(resolveDefaultEnvironment(mf({ preview: { provider: "openpouch-run" } }))).toBe("preview");
  });
  it("falls back to preview when several envs but no production", () => {
    expect(resolveDefaultEnvironment(mf({ preview: { provider: "render" }, staging: { provider: "render" } }))).toBe("preview");
  });
  it("falls back to production when there are no environments", () => {
    expect(resolveDefaultEnvironment(mf({}))).toBe("production");
  });
});

describe("openpouch rollback", () => {
  it("requires a recorded anchor, gates on approval, then redeploys the anchor commit", async () => {
    const { dir, home } = await makeWorkspace();
    const calls: DeployCall[] = [];
    const adapter = makeAdapter(calls);

    // no evidence yet → no anchor
    const early = await run(["rollback", "--json"], ctx(dir, home, adapter));
    expect(early.exitCode).toBe(3);
    expect(JSON.parse(early.output)).toMatchObject({ error: { message: expect.stringContaining("no rollback anchor") } });

    // create a production deploy (approval-gated) so evidence + anchor exist
    await run(["prod", "--json"], ctx(dir, home, adapter));
    await approveLatest(dir, home, adapter);
    const prod = await run(["prod", "--json"], ctx(dir, home, adapter));
    expect(prod.exitCode).toBe(0);

    // rollback is itself approval-gated on production (default policy)
    const blocked = await run(["rollback", "--json"], ctx(dir, home, adapter));
    expect(blocked.exitCode).toBe(6);
    expect(JSON.parse(blocked.output)).toMatchObject({ error: { category: "approval-required" } });

    await approveLatest(dir, home, adapter);
    const rollback = await run(["rollback", "--json"], ctx(dir, home, adapter));
    expect(rollback.exitCode).toBe(0);
    const json = JSON.parse(rollback.output) as { rolledBackTo: { commit: string }; deployment: { notes?: string } };
    expect(json.rolledBackTo.commit).toBe("0ldc0mmit0");
    expect(json.deployment.notes).toContain("rollback to 0ldc0mmit0");

    // the actual provider call carried the anchor commit
    const rollbackCall = calls.at(-1);
    expect(rollbackCall?.opts?.commitId).toBe("0ldc0mmit0");

    // evidence now has the rollback deploy as newest record
    const evidence = JSON.parse(await readFile(join(dir, "deploy.evidence.json"), "utf8")) as {
      deployments: Array<{ id: string }>;
    };
    expect(evidence.deployments[0]?.id).toBe("dep-rollbacked");
  });

  it("tells the truth on an instant-lane project instead of implying a reachable anchor (R9.2)", async () => {
    // Instant previews (provider openpouch-run) never record a rollback anchor —
    // each deploy ships a fresh ephemeral preview. The generic "no anchor" fix
    // would imply a reachable state that doesn't exist for instant; we return a
    // tailored message that points at the move that works (redeploy).
    const dir = await mkdtemp(join(tmpdir(), "openpouch-inst-rb-"));
    const home = await mkdtemp(join(tmpdir(), "openpouch-inst-rbhome-"));
    await writeFile(
      join(dir, "deploy.manifest.json"),
      JSON.stringify({
        version: 0,
        project: { name: "joey" },
        env: [],
        environments: { preview: { provider: "openpouch-run", serviceId: "joey-zzz999", url: "https://joey-zzz999.openpouch.sh" } },
      }),
    );
    await writeFile(join(dir, "deploy.policy.json"), JSON.stringify(defaultPolicy()));
    const result = await run(["rollback", "--json"], ctx(dir, home, makeAdapter([])));
    expect(result.exitCode).toBe(3); // manifest/env
    const json = JSON.parse(result.output) as { error: { message: string; fix: string } };
    expect(json.error.message).toContain("can't be rolled back");
    expect(json.error.fix).toContain("openpouch deploy");
  });
});
