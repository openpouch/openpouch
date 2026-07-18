import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { DockerEngine } from "../src/engine.js";
import { probeHttp } from "../src/proxy.js";

/**
 * Opt-in real-Docker validation of the hardened container profile — RUN ON THE
 * BOX during the M2 drill, not in CI (CI has no Docker). Defaults to the
 * `bridge` network so it works on any Docker host; on the box, set
 * OPENPOUCH_RUN_NETWORK=op-egress to also exercise the egress filter.
 *
 *   OPENPOUCH_RUN_DOCKER_E2E=1 npx vitest run packages/run/test/engine.e2e.test.ts
 */
const RUN = process.env.OPENPOUCH_RUN_DOCKER_E2E === "1";
const PORT = Number(process.env.OPENPOUCH_RUN_E2E_PORT ?? "23456");

function selfUser(): string {
  const getuid = process.getuid;
  const getgid = process.getgid;
  return typeof getuid === "function" && typeof getgid === "function" ? `${getuid.call(process)}:${getgid.call(process)}` : "";
}

const engine = new DockerEngine({
  image: process.env.OPENPOUCH_RUN_IMAGE ?? "node:22-alpine",
  user: process.env.OPENPOUCH_RUN_CONTAINER_USER ?? selfUser(),
  network: process.env.OPENPOUCH_RUN_NETWORK ?? "bridge",
  memory: "256m",
  cpus: "0.5",
  pidsLimit: 128,
  buildMemory: "512m",
  buildCpus: "1",
  buildTimeoutMs: 120_000,
  containerPort: 8080,
});

let containerId: string | undefined;

describe.skipIf(!RUN)("DockerEngine real-container E2E", () => {
  afterAll(async () => {
    if (containerId) await engine.remove(containerId).catch(() => {});
  });

  it(
    "builds, runs, health-checks, proxies, idle-stops, wakes, and tears down a real container",
    async () => {
      const slug = `e2e-${Date.now().toString(36)}`;
      const siteDir = await mkdtemp(join(tmpdir(), "oprun-e2e-"));
      await writeFile(join(siteDir, "package.json"), JSON.stringify({ name: slug, scripts: { start: "node server.js" } }));
      await writeFile(
        join(siteDir, "server.js"),
        "require('http').createServer((q,s)=>{s.writeHead(200);s.end('e2e-ok')}).listen(process.env.PORT||8080,'0.0.0.0')",
      );

      const build = await engine.build({ slug, siteDir, installCmd: "npm install --ignore-scripts --no-audit --no-fund" });
      expect(build.ok).toBe(true);

      containerId = await engine.create({ slug, siteDir, startCmd: "npm start", hostPort: PORT });
      await engine.start(containerId);
      expect(await engine.state(containerId)).toBe("running");

      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        up = await probeHttp(PORT);
        if (!up) await sleep(500);
      }
      expect(up).toBe(true);

      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      expect(await res.text()).toContain("e2e-ok");

      await engine.stop(containerId);
      expect(await engine.state(containerId)).toBe("stopped");
      expect(await probeHttp(PORT, 500)).toBe(false);

      await engine.start(containerId); // wake
      let woke = false;
      for (let i = 0; i < 60 && !woke; i++) {
        woke = await probeHttp(PORT);
        if (!woke) await sleep(500);
      }
      expect(woke).toBe(true);

      await engine.remove(containerId);
      expect(await engine.state(containerId)).toBe("missing");
      containerId = undefined;
    },
    180_000,
  );
});
