import { describe, expect, it } from "vitest";
import { createVercelAdapter, VercelApiError } from "../src/index.js";

/**
 * Live E2E against the real Vercel API. Opt-in only:
 *   VERCEL_TOKEN=$(cat ~/.openpouch/vercel.token) VERCEL_TEAM_ID=team_… \
 *     npx vitest run packages/adapter-vercel/test/e2e.test.ts
 * Read-only. Designed to pass against an empty account (the fresh,
 * customer-free openpouch team): an empty project list is itself a valid
 * proof of auth + team scoping + response shape. Env vars are reported
 * by NAME and presence only — values never appear anywhere.
 */
const token = process.env.VERCEL_TOKEN ?? "";
const teamId = process.env.VERCEL_TEAM_ID;

describe.skipIf(token === "")("vercel adapter E2E (live, read-only)", () => {
  const adapter = createVercelAdapter({
    apiKey: token,
    ...(teamId !== undefined ? { teamId } : {}),
  });

  it("lists projects (team-scoped) without leaking values", async () => {
    const services = await adapter.listServices();
    expect(Array.isArray(services)).toBe(true);

    console.log(
      `\n=== Vercel live (${teamId !== undefined ? `team ${teamId}` : "personal scope"}): ${services.length} project(s) ===`,
    );
    for (const s of services) {
      console.log(`Project: ${s.name} (${s.id}) | URL: ${s.url ?? "—"}`);

      const deploys = await adapter.getRecentDeploys(s.id, 3);
      const latest = deploys[0];
      if (latest) {
        console.log(
          `  Latest deploy: ${latest.id} | ${latest.status} | ${latest.commit?.slice(0, 10) ?? "?"} | ${latest.createdAt ?? "?"}`,
        );
      }

      const envVars = await adapter.getEnvVarNames(s.id);
      console.log(`  Env vars (${envVars.length}, names only): ${envVars.map((v) => v.name).join(", ") || "none"}`);
      for (const v of envVars) {
        expect(Object.keys(v).sort()).toEqual(["name", "present"]);
      }
    }
    console.log("=== End Vercel live read ===\n");
  }, 60_000);

  it("classifies a bad token as auth (live error mapping)", async () => {
    const bad = createVercelAdapter({
      apiKey: "openpouch-invalid-token-probe",
      ...(teamId !== undefined ? { teamId } : {}),
    });
    try {
      await bad.listServices();
      expect.unreachable("a bad token must not succeed");
    } catch (e) {
      expect(e).toBeInstanceOf(VercelApiError);
      expect((e as VercelApiError).category).toBe("auth");
    }
  }, 30_000);
});

/**
 * Write-path E2E (redeploy primitive). DOUBLE opt-in:
 *   OPENPOUCH_VERCEL_WRITE_E2E=1 VERCEL_TOKEN=… VERCEL_TEAM_ID=… npx vitest run …
 * Only ever targets the dedicated `openpouch-dogfood` test project (rule
 * D12) — it refuses to run if that exact project is not found.
 */
const writeE2E = process.env.OPENPOUCH_VERCEL_WRITE_E2E === "1";

describe.skipIf(token === "" || !writeE2E)("vercel adapter E2E (live, write — redeploy primitive)", () => {
  const adapter = createVercelAdapter({
    apiKey: token,
    ...(teamId !== undefined ? { teamId } : {}),
  });

  it("redeploys the latest deployment of openpouch-dogfood and polls it to live", async () => {
    const services = await adapter.listServices();
    const dogfood = services.find((s) => s.name === "openpouch-dogfood");
    expect(dogfood, "dedicated test project openpouch-dogfood must exist (D12)").toBeDefined();

    const before = await adapter.getRecentDeploys(dogfood!.id, 1);
    expect(before[0]).toBeDefined();

    const triggered = await adapter.triggerDeploy(dogfood!.id);
    expect(triggered.id).toBeTruthy();
    expect(triggered.id).not.toBe(before[0]!.id);
    console.log(`triggered redeploy ${triggered.id} (source ${before[0]!.id}), status: ${triggered.status}`);

    let current = triggered;
    for (let i = 0; i < 30 && current.status !== "live" && current.status !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      current = await adapter.getDeploy(dogfood!.id, triggered.id);
    }
    expect(current.status).toBe("live");

    const logs = await adapter.getLogs(dogfood!.id, { limit: 10 });
    expect(Array.isArray(logs)).toBe(true);
    console.log(`redeploy ${triggered.id} -> ${current.status}; ${logs.length} log event(s)`);
  }, 180_000);
});
