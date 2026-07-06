import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";

/**
 * Live CLI E2E (opt-in):
 *   RENDER_API_KEY=$(cat ~/.openpouch/render.key) npx vitest run packages/cli/test/e2e.test.ts
 * Creates a temp project and lets `init` auto-match a Render service by name,
 * then `inspect` answers the week-1 question via the CLI (point it at any
 * dedicated, isolated test service).
 */
const apiKey = process.env.RENDER_API_KEY ?? "";

describe.skipIf(apiKey === "")("openpouch CLI E2E (live)", () => {
  it("init auto-matches the real service and inspect reports the live state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-e2e-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo-app", scripts: { start: "node index.js" } }));
    await writeFile(join(dir, "index.js"), "const p = process.env.PORT;\n");

    const ctx = { cwd: dir, env: { RENDER_API_KEY: apiKey } };

    const init = await run(["init", "--json"], ctx);
    expect(init.exitCode).toBe(0);
    const initJson = JSON.parse(init.output) as { production: { serviceId: string } | null };
    expect(initJson.production?.serviceId).toMatch(/^srv-/);

    const inspect = await run(["inspect"], ctx);
    expect(inspect.exitCode).toBe(0);
    console.log(`\n=== W1: CLI-Beweis live ===\n${inspect.output}\n=== Ende ===\n`);

    const inspectJson = await run(["inspect", "--json"], ctx);
    const data = JSON.parse(inspectJson.output) as {
      environments: { production?: { status: string; liveDeploy?: { status: string } } };
    };
    expect(data.environments.production?.status).toBe("ok");
    expect(data.environments.production?.liveDeploy?.status).toBe("live");
  }, 60_000);
});
