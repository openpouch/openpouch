import { describe, expect, it } from "vitest";
import { RenderApiError, createRenderAdapter } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(routes: Record<string, unknown | number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.replace("https://api.render.com", "");
    for (const [route, body] of Object.entries(routes)) {
      if (path.startsWith(route)) {
        return typeof body === "number" ? jsonResponse({}, body) : jsonResponse(body);
      }
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

const adapter = (routes: Record<string, unknown | number>) =>
  createRenderAdapter({ apiKey: "rnd_test", fetchImpl: stubFetch(routes) });

describe("render adapter: mapping", () => {
  it("maps the service list (cursor-wrapped)", async () => {
    const a = adapter({
      "/v1/services": [
        {
          cursor: "c1",
          service: {
            id: "srv-1",
            name: "demo-app",
            branch: "main",
            suspended: "not_suspended",
            serviceDetails: { url: "https://demo-app.onrender.com", env: "node" },
          },
        },
      ],
    });
    const services = await a.listServices();
    expect(services).toEqual([
      {
        id: "srv-1",
        name: "demo-app",
        url: "https://demo-app.onrender.com",
        branch: "main",
        runtime: "node",
        suspended: false,
      },
    ]);
  });

  it("maps deploy statuses to the openpouch enum", async () => {
    const mk = (id: string, status: string) => ({
      cursor: id,
      deploy: { id, status, commit: { id: "abc123", message: "m" }, createdAt: "2026-06-12T10:00:00Z" },
    });
    const a = adapter({
      "/v1/services/srv-1/deploys": [
        mk("d1", "live"),
        mk("d2", "build_in_progress"),
        mk("d3", "update_failed"),
        mk("d4", "canceled"),
        mk("d5", "created"),
      ],
    });
    const deploys = await a.getRecentDeploys("srv-1");
    expect(deploys.map((d) => d.status)).toEqual(["live", "building", "failed", "canceled", "queued"]);
    expect(deploys[0]?.commit).toBe("abc123");
  });
});

describe("render adapter: secret boundary", () => {
  it("returns env var names/presence and NEVER the value", async () => {
    const a = adapter({
      "/v1/services/srv-1/env-vars": [
        { cursor: "c1", envVar: { key: "DATABASE_URL", value: "postgres://user:SUPER-SECRET@host/db" } },
        { cursor: "c2", envVar: { key: "EMPTY_VAR", value: "" } },
      ],
    });
    const vars = await a.getEnvVarNames("srv-1");
    expect(vars).toEqual([
      { name: "DATABASE_URL", present: true },
      { name: "EMPTY_VAR", present: false },
    ]);
    expect(JSON.stringify(vars)).not.toContain("SUPER-SECRET");
  });
});

describe("render adapter: write path & logs", () => {
  it("triggerDeploy posts commitId when given (rollback primitive)", async () => {
    const bodies: string[] = [];
    const capturingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ id: "dep-x", status: "created", createdAt: "2026-06-12T16:00:00Z" });
    }) as typeof fetch;
    const a = createRenderAdapter({ apiKey: "rnd_test", fetchImpl: capturingFetch });
    const deploy = await a.triggerDeploy("srv-1", { commitId: "abc123" });
    expect(deploy.status).toBe("queued");
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ commitId: "abc123", clearCache: "do_not_clear" });
  });

  it("getLogs resolves ownerId via the service, then queries /v1/logs", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/v1/services/srv-1") && !url.includes("logs")) {
        return jsonResponse({ id: "srv-1", name: "x", ownerId: "tea-owner1" });
      }
      return jsonResponse({ hasMore: false, logs: [{ timestamp: "2026-06-12T16:00:00Z", message: "hello" }] });
    }) as typeof fetch;
    const a = createRenderAdapter({ apiKey: "rnd_test", fetchImpl });
    const logs = await a.getLogs("srv-1", { limit: 5 });
    expect(logs).toEqual([{ timestamp: "2026-06-12T16:00:00Z", message: "hello" }]);
    expect(urls.some((u) => u.includes("/v1/logs?ownerId=tea-owner1&resource=srv-1&limit=5"))).toBe(true);

    // second call reuses the cached ownerId (no extra service lookup)
    await a.getLogs("srv-1", { limit: 5 });
    expect(urls.filter((u) => u.includes("/v1/services/srv-1") && !u.includes("logs"))).toHaveLength(1);
  });
});

describe("render adapter: agent-readable errors", () => {
  it("classifies 401 as auth with a fix hint", async () => {
    const a = adapter({ "/v1/services": 401 });
    const err = await a.listServices().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RenderApiError);
    const apiErr = err as RenderApiError;
    expect(apiErr.category).toBe("auth");
    expect(apiErr.status).toBe(401);
    expect(apiErr.fix).toContain("RENDER_API_KEY");
  });

  it("classifies 429 as quota", async () => {
    const a = adapter({ "/v1/services": 429 });
    await expect(a.listServices()).rejects.toMatchObject({ category: "quota" });
  });
});
