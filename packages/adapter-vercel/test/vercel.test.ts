import { describe, expect, it } from "vitest";
import { VercelApiError, createVercelAdapter } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(routes: Array<[match: string, body: unknown | number]>, calls?: Array<{ url: string; body?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls?.push({ url, ...(init?.body !== undefined ? { body: String(init.body) } : {}) });
    for (const [match, body] of routes) {
      if (url.includes(match)) return typeof body === "number" ? jsonResponse({}, body) : jsonResponse(body);
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

const PROJECT = {
  id: "prj_123",
  name: "demo-site",
  framework: "nextjs",
  targets: { production: { alias: ["demo.example.com", "demo.vercel.app"] } },
  link: { productionBranch: "main" },
};

const DEPLOYMENTS = {
  deployments: [
    {
      uid: "dpl_live",
      readyState: "READY",
      created: 1781000000000,
      ready: 1781000300000,
      meta: { githubCommitSha: "cafe123456", githubCommitMessage: "feat: launch" },
    },
    { uid: "dpl_old", readyState: "ERROR", created: 1780000000000, meta: { githubCommitSha: "00dead0000" } },
  ],
};

describe("vercel adapter: mapping", () => {
  it("maps projects to services (alias url, production branch, framework)", async () => {
    const a = createVercelAdapter({ apiKey: "vt", fetchImpl: stubFetch([["/v9/projects?limit", { projects: [PROJECT] }]]) });
    expect(await a.listServices()).toEqual([
      { id: "prj_123", name: "demo-site", url: "https://demo.example.com", branch: "main", runtime: "nextjs", suspended: false },
    ]);
  });

  it("maps deployment states and converts epoch ms to ISO", async () => {
    const a = createVercelAdapter({ apiKey: "vt", fetchImpl: stubFetch([["/v6/deployments", DEPLOYMENTS]]) });
    const deploys = await a.getRecentDeploys("prj_123");
    expect(deploys.map((d) => d.status)).toEqual(["live", "failed"]);
    expect(deploys[0]?.createdAt).toBe(new Date(1781000000000).toISOString());
    expect(deploys[0]?.finishedAt).toBe(new Date(1781000300000).toISOString());
    expect(deploys[0]?.commit).toBe("cafe123456");
  });

  it("appends teamId to every request when configured", async () => {
    const calls: Array<{ url: string }> = [];
    const a = createVercelAdapter({
      apiKey: "vt",
      teamId: "team_abc",
      fetchImpl: stubFetch([["/v9/projects?limit", { projects: [] }]], calls),
    });
    await a.listServices();
    expect(calls[0]?.url).toContain("teamId=team_abc");
  });
});

describe("vercel adapter: secret boundary", () => {
  it("returns env var names/presence and NEVER the value", async () => {
    const a = createVercelAdapter({
      apiKey: "vt",
      fetchImpl: stubFetch([
        ["/env", { envs: [{ key: "DATABASE_URL", value: "postgres://VERCEL-SECRET@host/db" }, { key: "ENCRYPTED_ONE" }, { key: "EMPTY", value: "" }] }],
      ]),
    });
    const vars = await a.getEnvVarNames("prj_123");
    expect(vars).toEqual([
      { name: "DATABASE_URL", present: true },
      { name: "ENCRYPTED_ONE", present: true },
      { name: "EMPTY", present: false },
    ]);
    expect(JSON.stringify(vars)).not.toContain("VERCEL-SECRET");
  });
});

describe("vercel adapter: redeploy & rollback primitive", () => {
  it("triggerDeploy redeploys the latest deployment; commitId selects the matching one", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const routes: Array<[string, unknown]> = [
      ["/v6/deployments", DEPLOYMENTS],
      ["/v9/projects/prj_123", PROJECT],
      ["/v13/deployments?forceNew=1", { uid: "dpl_new", readyState: "QUEUED", created: 1781000400000 }],
    ];
    const a = createVercelAdapter({ apiKey: "vt", fetchImpl: stubFetch(routes, calls) });

    const redeploy = await a.triggerDeploy("prj_123");
    expect(redeploy.status).toBe("queued");
    const lastBody = JSON.parse(calls.at(-1)?.body ?? "{}") as { deploymentId: string };
    expect(lastBody.deploymentId).toBe("dpl_live");

    await a.triggerDeploy("prj_123", { commitId: "00dead0000" });
    const rollbackBody = JSON.parse(calls.at(-1)?.body ?? "{}") as { deploymentId: string };
    expect(rollbackBody.deploymentId).toBe("dpl_old");
  });

  it("throws a provider error when no deployment matches the commit", async () => {
    const a = createVercelAdapter({ apiKey: "vt", fetchImpl: stubFetch([["/v6/deployments", DEPLOYMENTS]]) });
    await expect(a.triggerDeploy("prj_123", { commitId: "ffffffffff" })).rejects.toMatchObject({ category: "provider" });
  });
});

describe("vercel adapter: agent-readable errors", () => {
  it("classifies 401 as auth with a fix hint", async () => {
    const a = createVercelAdapter({ apiKey: "vt", fetchImpl: stubFetch([["/v9/projects?limit", 401]]) });
    await expect(a.listServices()).rejects.toMatchObject({ category: "auth", fix: expect.stringContaining("VERCEL_TOKEN") });
  });
});
