import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@openpouch/core";
import { upsertAgentsSection } from "../src/agentsmd.js";
import { run } from "../src/main.js";

const stubAdapter: ProviderAdapter = {
  id: "render",
  async listServices() {
    return [];
  },
  async getService(id) {
    return { id, name: "x", suspended: false };
  },
  async getRecentDeploys() {
    return [];
  },
  async getEnvVarNames() {
    return [];
  },
  async getLogs() {
    return [];
  },
  async triggerDeploy() {
    return { id: "d", status: "live" as const, createdAt: "2026-06-12T10:00:00Z" };
  },
  async getDeploy() {
    return { id: "d", status: "live" as const, createdAt: "2026-06-12T10:00:00Z" };
  },
};

describe("AGENTS.md writer (cross-harness discovery, D13)", () => {
  it("init creates AGENTS.md with the openpouch section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-agents-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo-app" }));
    const result = await run(["init", "--json"], { cwd: dir, env: { RENDER_API_KEY: "rnd_test" }, createAdapter: () => stubAdapter });
    expect(JSON.parse(result.output)).toMatchObject({ agentsMd: "created" });

    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("<!-- openpouch:start -->");
    expect(content).toContain("openpouch inspect");
    expect(content).toContain("You cannot approve it");
    // R9.7: named multi-step workflows, not just a verb list (self-repair, claim-to-keep, happy path).
    expect(content).toContain("Workflows");
    expect(content).toContain("Self-repair loop");
    expect(content).toContain("claimUrl");
  });

  it("preserves existing AGENTS.md content and replaces only its own section idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-agents2-"));
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS.md\n\nTeam rule: always run lint before commit.\n");

    expect(await upsertAgentsSection(dir, "demo")).toBe("updated");
    expect(await upsertAgentsSection(dir, "demo")).toBe("unchanged");

    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("Team rule: always run lint before commit.");
    expect(content.match(/openpouch:start/g)).toHaveLength(1);

    // changed project name → section replaced in place, custom content intact
    expect(await upsertAgentsSection(dir, "renamed")).toBe("updated");
    const next = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(next).toContain("renamed deploys via openpouch");
    expect(next).toContain("Team rule: always run lint before commit.");
    expect(next.match(/openpouch:start/g)).toHaveLength(1);
  });
});
