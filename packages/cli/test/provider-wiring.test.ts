import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAdapter, ProviderId } from "@openpouch/core";
import { run } from "../src/main.js";
import { positiveNumberEnv } from "../src/shared.js";

const stub = (id: ProviderId): ProviderAdapter => ({
  id,
  async listServices() {
    return [];
  },
  async getService(sid) {
    return { id: sid, name: "vercel-app", url: "https://vercel-app.example.com", suspended: false };
  },
  async getRecentDeploys() {
    return [{ id: "dpl_1", status: "live" as const, commit: "cafe123456", createdAt: "2026-06-12T10:00:00Z" }];
  },
  async getEnvVarNames() {
    return [];
  },
  async getLogs() {
    return [];
  },
  async triggerDeploy() {
    return { id: "dpl_2", status: "live" as const, createdAt: "2026-06-12T11:00:00Z" };
  },
  async getDeploy(_s, id) {
    return { id, status: "live" as const, createdAt: "2026-06-12T11:00:00Z" };
  },
});

async function vercelWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openpouch-wire-"));
  await writeFile(
    join(dir, "deploy.manifest.json"),
    JSON.stringify({
      version: 0,
      project: { name: "vercel-app" },
      env: [],
      environments: { production: { provider: "vercel", serviceId: "prj_123" } },
    }),
  );
  return dir;
}

describe("multi-provider wiring (D13/D2: the manifest decides the adapter)", () => {
  it("inspect on a vercel-mapped environment requests the vercel adapter with the vercel token", async () => {
    const dir = await vercelWorkspace();
    const calls: Array<{ provider: ProviderId; apiKey: string }> = [];
    const result = await run(["inspect", "--json"], {
      cwd: dir,
      env: { VERCEL_TOKEN: "vt_test" },
      createAdapter: (provider, apiKey) => {
        calls.push({ provider, apiKey });
        return stub(provider);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ provider: "vercel", apiKey: "vt_test" }]);
    const json = JSON.parse(result.output) as { environments: { production: { liveDeploy: { commit: string } } } };
    expect(json.environments.production.liveDeploy.commit).toBe("cafe123456");
  });

  it("missing vercel token yields a vercel-specific auth fix (not a Render hint)", async () => {
    const dir = await vercelWorkspace();
    const home = await mkdtemp(join(tmpdir(), "openpouch-wirehome-"));
    const result = await run(["inspect", "--json"], {
      cwd: dir,
      env: { RENDER_API_KEY: "rnd_wrong_provider", OPENPOUCH_HOME: home },
    });
    expect(result.exitCode).toBe(4);
    const json = JSON.parse(result.output) as { error: { message: string; fix: string } };
    expect(json.error.message).toContain("vercel");
    expect(json.error.fix).toContain("VERCEL_TOKEN");
    expect(json.error.fix).not.toContain("RENDER_API_KEY");
  });
});

describe("positiveNumberEnv (deploy poll/timeout NaN guard)", () => {
  it("uses the fallback for unset, garbage, zero, and negative values", () => {
    expect(positiveNumberEnv({}, "OPENPOUCH_POLL_MS", 5000)).toBe(5000);
    expect(positiveNumberEnv({ OPENPOUCH_POLL_MS: "5s" }, "OPENPOUCH_POLL_MS", 5000)).toBe(5000); // NaN → fallback (no hot loop)
    expect(positiveNumberEnv({ OPENPOUCH_POLL_MS: "0" }, "OPENPOUCH_POLL_MS", 5000)).toBe(5000);
    expect(positiveNumberEnv({ OPENPOUCH_POLL_MS: "-1" }, "OPENPOUCH_POLL_MS", 5000)).toBe(5000);
    expect(positiveNumberEnv({ OPENPOUCH_POLL_MS: "" }, "OPENPOUCH_POLL_MS", 5000)).toBe(5000);
  });

  it("honours a valid positive override", () => {
    expect(positiveNumberEnv({ OPENPOUCH_POLL_MS: "250" }, "OPENPOUCH_POLL_MS", 5000)).toBe(250);
  });
});
