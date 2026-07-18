import { describe, expect, it } from "vitest";
import { createRenderAdapter } from "../src/index.js";

/**
 * Live E2E against the real Render API. Opt-in only:
 *   RENDER_API_KEY=$(cat ~/.openpouch/render.key) npx vitest run packages/adapter-render/test/e2e.test.ts
 * Prints the week-1 proof: what is deployed where, on which commit, which
 * env vars exist (NAMES only — values never appear anywhere).
 */
const apiKey = process.env.RENDER_API_KEY ?? "";

describe.skipIf(apiKey === "")("render adapter E2E (live)", () => {
  const adapter = createRenderAdapter({ apiKey });

  it("answers the week-1 question without a dashboard", async () => {
    const services = await adapter.listServices();
    expect(services.length).toBeGreaterThan(0);

    console.log("\n=== W1-BEWEIS: Deployment-Wahrheit ohne Dashboard ===");
    for (const s of services) {
      console.log(
        `Service: ${s.name} (${s.id}) | Runtime: ${s.runtime ?? "?"} | Branch: ${s.branch ?? "?"} | ${
          s.suspended ? "SUSPENDED" : "aktiv"
        } | URL: ${s.url ?? "—"}`,
      );

      const deploys = await adapter.getRecentDeploys(s.id, 3);
      const live = deploys.find((d) => d.status === "live") ?? deploys[0];
      if (live) {
        console.log(
          `  Live-Deploy: ${live.id} | Status: ${live.status} | Commit: ${live.commit?.slice(0, 10) ?? "?"} | ${
            live.commitMessage?.split("\n")[0] ?? ""
          } | ${live.finishedAt ?? live.createdAt}`,
        );
        expect(live.id).toBeTruthy();
      }

      const envVars = await adapter.getEnvVarNames(s.id);
      const names = envVars.map((v) => `${v.name}${v.present ? "" : " (leer!)"}`);
      console.log(`  Env-Vars (${envVars.length}, nur Namen): ${names.join(", ") || "keine"}`);
      for (const v of envVars) {
        expect(Object.keys(v).sort()).toEqual(["name", "present"]);
      }

      try {
        const logs = await adapter.getLogs(s.id, { limit: 5 });
        console.log(`  Logs: ${logs.length} Zeilen abrufbar`);
      } catch (e) {
        console.log(`  Logs: Endpoint-Form noch zu verfeinern (${(e as Error).name})`);
      }
    }
    console.log("=== Ende W1-Beweis ===\n");
  }, 60_000);
});
