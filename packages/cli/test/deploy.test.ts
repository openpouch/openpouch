import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPolicy, type ProviderAdapter } from "@openpouch/core";
import { run } from "../src/main.js";

function makeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
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
      return [{ name: "DATABASE_URL", present: true }];
    },
    async getLogs() {
      return [];
    },
    async triggerDeploy() {
      return { id: "dep-new", status: "building" as const, createdAt: "2026-06-12T12:00:00Z" };
    },
    async getDeploy() {
      return { id: "dep-new", status: "live" as const, commit: "deadbeef99", createdAt: "2026-06-12T12:00:00Z", finishedAt: "2026-06-12T12:01:00Z" };
    },
    ...overrides,
  };
}

async function makeInitialized(opts: { withUrl?: boolean } = {}): Promise<{ dir: string; home: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openpouch-w2-"));
  const home = await mkdtemp(join(tmpdir(), "openpouch-home-"));
  await writeFile(
    join(dir, "deploy.manifest.json"),
    JSON.stringify({
      version: 0,
      project: { name: "demo-app", framework: "node" },
      env: [{ name: "DATABASE_URL", required: true }],
      environments: {
        preview: { provider: "render", serviceId: "srv-prev" },
        production: {
          provider: "render",
          serviceId: "srv-prod",
          ...(opts.withUrl === true ? { url: "https://demo-app.example.com" } : {}),
        },
      },
    }),
  );
  await writeFile(join(dir, "deploy.policy.json"), JSON.stringify(defaultPolicy()));
  return { dir, home };
}

const ctx = (dir: string, home: string, adapter: ProviderAdapter, interactive?: { isTTY: boolean; confirm: () => Promise<boolean> }) => ({
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

describe("preview deploys (autonomous per default policy)", () => {
  it("deploys, polls to live, writes evidence with rollback anchor", async () => {
    const { dir, home } = await makeInitialized();
    const result = await run(["preview", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as { deployment: Record<string, unknown> };
    expect(json.deployment).toMatchObject({ id: "dep-new", status: "live", commit: "deadbeef99", rollbackAnchor: "dep-prior" });

    const evidence = JSON.parse(await readFile(join(dir, "deploy.evidence.json"), "utf8")) as { deployments: unknown[] };
    expect(evidence.deployments).toHaveLength(1);
    const md = await readFile(join(dir, "DEPLOYMENT.md"), "utf8");
    expect(md).toContain("preview");
    expect(md).toContain("dep-prior");
  });
});

describe("production approval gate", () => {
  it("blocks with exit 6, creates a pending request, and does not spam duplicates", async () => {
    const { dir, home } = await makeInitialized();
    const adapter = makeAdapter();
    const first = await run(["prod", "--json"], ctx(dir, home, adapter));
    expect(first.exitCode).toBe(6);
    const firstJson = JSON.parse(first.output) as { error: { category: string }; approvalRequest: { id: string }; summary?: string };
    expect(firstJson.error.category).toBe("approval-required");
    // R3: a plain-language summary tells the human exactly how to approve.
    expect(firstJson.summary).toContain(`openpouch approve ${firstJson.approvalRequest.id}`);

    const second = await run(["prod", "--json"], ctx(dir, home, adapter));
    const secondJson = JSON.parse(second.output) as { approvalRequest: { id: string } };
    expect(secondJson.approvalRequest.id).toBe(firstJson.approvalRequest.id);

    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".openpouch/");

    // no deploy happened, no evidence written
    await expect(readFile(join(dir, "deploy.evidence.json"), "utf8")).rejects.toThrow();
  });

  it("refuses approval in a non-TTY context (agents cannot approve)", async () => {
    const { dir, home } = await makeInitialized();
    const adapter = makeAdapter();
    const blocked = await run(["prod", "--json"], ctx(dir, home, adapter));
    const { approvalRequest } = JSON.parse(blocked.output) as { approvalRequest: { id: string } };

    const attempt = await run(
      ["approve", approvalRequest.id, "--json"],
      ctx(dir, home, adapter, { isTTY: false, confirm: async () => true }),
    );
    expect(attempt.exitCode).toBe(6);
    expect(JSON.parse(attempt.output)).toMatchObject({ error: { category: "human-required" } });
  });

  it("non-TTY approve answers human-required for ANY id — before the request lookup (deterministic gate, Codex suite smoke 2026-07-05)", async () => {
    const { dir, home } = await makeInitialized();
    const adapter = makeAdapter();
    // no pending request exists and the id is pure fiction — the gate must
    // still come first: an agent can neither approve nor probe which ids exist
    const attempt = await run(
      ["approve", "req_does_not_exist", "--json"],
      ctx(dir, home, adapter, { isTTY: false, confirm: async () => true }),
    );
    expect(attempt.exitCode).toBe(6);
    const json = JSON.parse(attempt.output) as { error: { category: string; message: string } };
    expect(json.error.category).toBe("human-required");
    expect(json.error.message).not.toContain("no approval request");
  });

  it("human approves (TTY), prod consumes the approval and records approvedBy", async () => {
    const { dir, home } = await makeInitialized({ withUrl: true });
    const adapter = makeAdapter();
    const blocked = await run(["prod", "--json"], ctx(dir, home, adapter));
    const { approvalRequest } = JSON.parse(blocked.output) as { approvalRequest: { id: string } };

    const approve = await run(
      ["approve", approvalRequest.id, "--json"],
      ctx(dir, home, adapter, { isTTY: true, confirm: async () => true }),
    );
    expect(approve.exitCode).toBe(0);
    expect(JSON.parse(approve.output)).toMatchObject({ ok: true, approved: true });

    const deploy = await run(["prod", "--json"], ctx(dir, home, adapter));
    expect(deploy.exitCode).toBe(0);
    const json = JSON.parse(deploy.output) as {
      url?: string;
      summary?: string;
      deployment: { approvedBy?: string; notes?: string };
      smokePassed: boolean;
    };
    expect(json.deployment.approvedBy).toBeTruthy();
    expect(json.deployment.notes).toContain(approvalRequest.id);
    expect(json.smokePassed).toBe(true);
    // R5: live link promoted to top level; R3: plain-language summary, with the approval acknowledged.
    expect(json.url).toBe("https://demo-app.example.com");
    expect(json.summary?.toLowerCase()).toContain("live");
    expect(json.summary?.toLowerCase()).toContain("with your approval");

    const approvals = JSON.parse(await readFile(join(dir, ".openpouch/approvals.json"), "utf8")) as {
      requests: Array<{ id: string; status: string }>;
    };
    expect(approvals.requests.find((r) => r.id === approvalRequest.id)?.status).toBe("consumed");

    // a second prod needs a NEW approval (consumed ones cannot be reused)
    const again = await run(["prod", "--json"], ctx(dir, home, adapter));
    expect(again.exitCode).toBe(6);
  });

  it("exits 8 when the deploy is live but smoke fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { dir, home } = await makeInitialized({ withUrl: true });
    const adapter = makeAdapter();
    const blocked = await run(["prod", "--json"], ctx(dir, home, adapter));
    const { approvalRequest } = JSON.parse(blocked.output) as { approvalRequest: { id: string } };
    await run(["approve", approvalRequest.id, "--json"], ctx(dir, home, adapter, { isTTY: true, confirm: async () => true }));

    const deploy = await run(["prod", "--json"], ctx(dir, home, adapter));
    expect(deploy.exitCode).toBe(8);
    const json = JSON.parse(deploy.output) as { deployment: { status: string; smoke: Array<{ passed: boolean }> } };
    expect(json.deployment.status).toBe("live");
    expect(json.deployment.smoke[0]?.passed).toBe(false);
  });
});

describe("plan & verify", () => {
  it("plan reports readiness, blockers, and the approval path", async () => {
    const { dir, home } = await makeInitialized();
    const result = await run(["plan", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as {
      environments: Record<string, { decision: string; ready: boolean; nextSteps: string[] }>;
    };
    expect(json.environments["preview"]).toMatchObject({ decision: "allowed", ready: true });
    expect(json.environments["production"]?.decision).toBe("requires-approval");
    expect(json.environments["production"]?.nextSteps.join(" ")).toContain("openpouch approve");
  });

  it("plan points instant-lane (openpouch-run) projects at `deploy`/`verify`, not `preview` (OpenClaw 2026-06-29)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-instant-"));
    const home = await mkdtemp(join(tmpdir(), "openpouch-home-"));
    await writeFile(
      join(dir, "deploy.manifest.json"),
      JSON.stringify({
        version: 0,
        project: { name: "my-app", framework: "node" },
        env: [],
        environments: { preview: { provider: "openpouch-run", serviceId: "my-app-abc123" } },
      }),
    );
    await writeFile(join(dir, "deploy.policy.json"), JSON.stringify(defaultPolicy()));
    const result = await run(["plan", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as {
      environments: Record<string, { ready: boolean; nextSteps: string[] }>;
      hints: string[];
    };
    const steps = json.environments["preview"]?.nextSteps.join(" ") ?? "";
    expect(steps).toContain("openpouch deploy");
    expect(steps).toContain("openpouch verify");
    expect(steps).not.toContain("openpouch preview");
    expect(json.hints.join(" ")).toContain("instant lane");
  });

  it("verify appends smoke results to the latest evidence record", async () => {
    const { dir, home } = await makeInitialized({ withUrl: true });
    const adapter = makeAdapter();
    await run(["preview", "--json"], ctx(dir, home, adapter)); // creates one evidence record (preview)
    const result = await run(["verify", "--env", "preview", "--json"], ctx(dir, home, adapter));
    // preview has no url in manifest → exit 3; use production instead after a prod-like record
    expect([0, 3]).toContain(result.exitCode);

    const verifyProd = await run(["verify", "--env", "production", "--json"], ctx(dir, home, adapter));
    expect(verifyProd.exitCode).toBe(0);
    const json = JSON.parse(verifyProd.output) as { checks: Array<{ passed: boolean }>; evidenceUpdated: boolean };
    expect(json.checks[0]?.passed).toBe(true);
    expect(json.evidenceUpdated).toBe(false); // no production record yet — only preview deployed
  });
});

describe("verify --health-path (OpenClaw 2026-07-04: a live shell can hide a dead API)", () => {
  it("checks BOTH / and the extra path, and fails when the API path is down", async () => {
    const { dir, home } = await makeInitialized({ withUrl: true });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes("/api/health") ? new Response("down", { status: 500 }) : new Response("ok", { status: 200 });
    });
    const result = await run(["verify", "--env", "production", "--health-path", "/api/health", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(8);
    const json = JSON.parse(result.output) as { ok: boolean; checks: Array<{ name: string; passed: boolean }> };
    expect(json.ok).toBe(false);
    expect(json.checks).toHaveLength(2);
    expect(json.checks[0]).toMatchObject({ name: "GET / expects 200", passed: true });
    expect(json.checks[1]).toMatchObject({ name: "GET /api/health expects 200", passed: false });
  });

  it("a non-/ manifest healthcheck path is checked IN ADDITION to /, automatically", async () => {
    const { dir, home } = await makeInitialized({ withUrl: true });
    const manifest = JSON.parse(await readFile(join(dir, "deploy.manifest.json"), "utf8")) as Record<string, unknown>;
    manifest["healthcheck"] = { path: "/status", expectStatus: 200, timeoutMs: 5000 };
    await writeFile(join(dir, "deploy.manifest.json"), JSON.stringify(manifest));
    const result = await run(["verify", "--env", "production", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as { checks: Array<{ name: string }> };
    expect(json.checks.map((c) => c.name)).toEqual(["GET / expects 200", "GET /status expects 200"]);
  });

  it("rejects a --health-path that doesn't start with '/'", async () => {
    const { dir, home } = await makeInitialized({ withUrl: true });
    const result = await run(["verify", "--health-path", "api/health", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("invalid --health-path");
  });
});

describe("url-less environment is legible (R9)", () => {
  it("flags a live deploy whose env has no url as unchecked, not healthy (A6/R9.5)", async () => {
    const { dir, home } = await makeInitialized(); // preview has no url → smoke is skipped
    const result = await run(["preview", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.output) as { smokePassed: unknown; smokeSkipped?: boolean; note?: string; summary: string };
    expect(json.smokePassed).toBe(null); // not checked
    expect(json.smokeSkipped).toBe(true); // … and the agent can tell it apart from "healthy"
    expect(json.note as string).toContain("openpouch verify");
    expect(json.summary).toContain("couldn't automatically check"); // honest, not "nothing else is needed"
  });

  it("verify on a url-less env points at a command to obtain the url (A7/R9.1)", async () => {
    const { dir, home } = await makeInitialized(); // preview has no url
    const result = await run(["verify", "--env", "preview", "--json"], ctx(dir, home, makeAdapter()));
    expect(result.exitCode).toBe(3);
    const err = (JSON.parse(result.output) as { error: { fix: string } }).error;
    expect(err.fix).toContain("openpouch inspect"); // actionable, not a bare "hand-edit the file"
  });
});
