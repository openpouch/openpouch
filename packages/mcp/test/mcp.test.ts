import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultPolicy, type ProviderAdapter } from "@openpouch/core";
import { createOpenpouchServer, mcpCliResponse } from "../src/server.js";

const stubAdapter: ProviderAdapter = {
  id: "render",
  async listServices() {
    return [];
  },
  async getService(id) {
    return { id, name: "demo-app", url: "https://demo.example.com", suspended: false };
  },
  async getRecentDeploys() {
    return [
      { id: "dep-1", status: "live" as const, commit: "abcdef1234", commitMessage: "feat: x", createdAt: "2026-06-12T10:00:00Z", finishedAt: "2026-06-12T10:05:00Z" },
    ];
  },
  async getEnvVarNames() {
    return [{ name: "PORT", present: true }];
  },
  async getLogs() {
    return [{ timestamp: "t", message: "m" }];
  },
  async triggerDeploy() {
    return { id: "dep-2", status: "live" as const, createdAt: "2026-06-12T11:00:00Z", finishedAt: "2026-06-12T11:01:00Z" };
  },
  async getDeploy(_s, id) {
    return { id, status: "live" as const, commit: "abcdef1234", createdAt: "2026-06-12T11:00:00Z", finishedAt: "2026-06-12T11:01:00Z" };
  },
};

async function setup(environments?: Record<string, unknown>): Promise<Client> {
  const dir = await mkdtemp(join(tmpdir(), "openpouch-mcp-"));
  const home = await mkdtemp(join(tmpdir(), "openpouch-mcphome-"));
  await writeFile(
    join(dir, "deploy.manifest.json"),
    JSON.stringify({
      version: 0,
      project: { name: "demo-app" },
      env: [],
      environments: environments ?? { production: { provider: "render", serviceId: "srv-prod" } },
    }),
  );
  await writeFile(join(dir, "deploy.policy.json"), JSON.stringify(defaultPolicy()));

  const server = createOpenpouchServer({
    baseCtx: {
      cwd: dir,
      env: { RENDER_API_KEY: "rnd_test", OPENPOUCH_POLL_MS: "1", OPENPOUCH_DEPLOY_TIMEOUT_MS: "5000", OPENPOUCH_HOME: home },
      createAdapter: () => stubAdapter,
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** The JSON payload is the text block that starts with "{" (a leading summary
 * relay block may precede it — see toolResult). */
function parseText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  const jsonText = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .find((t) => t.trimStart().startsWith("{"));
  return JSON.parse(jsonText ?? "{}") as Record<string, unknown>;
}

/** The leading "Relay this to your human: …" block (PRD R3), if present. */
function relayText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .find((t) => t.startsWith("Relay this to your human:"));
}

describe("openpouch MCP server (harness-neutral, stdio-compatible)", () => {
  it("exposes EXACTLY the 13-tool set — and deliberately NO approve tool", async () => {
    const client = await setup();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    // Pin the EXACT set (not a superset): a stray tool — or a slipped-in approve
    // path (D13) — must fail the gate, and the count must stay in lockstep with
    // the CI dist-smoke (which asserts 13) and the docs (llms.txt/MCP.md).
    expect(tools).toEqual(
      [
        "openpouch_delete",
        "openpouch_deploy",
        "openpouch_deploy_preview",
        "openpouch_deploy_production",
        "openpouch_init",
        "openpouch_inspect",
        "openpouch_list",
        "openpouch_list_approvals",
        "openpouch_logs",
        "openpouch_plan",
        "openpouch_rollback",
        "openpouch_verify",
        "openpouch_whoami",
      ].sort(),
    );
    expect(tools).toHaveLength(13);
    expect(tools.some((t) => t.includes("approve") && t !== "openpouch_list_approvals")).toBe(false);
  });

  it("openpouch_deploy runs the instant lane end-to-end and redacts the claim link by default (Codex 2026-07-04)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openpouch-mcp-instant-"));
    const home = await mkdtemp(join(tmpdir(), "openpouch-mcphome2-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "mcp-instant-app" }));
    await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
    const runStub = {
      id: "openpouch-run" as const,
      listServices: async () => [],
      getService: async (id: string) => ({ id, name: id }),
      getRecentDeploys: async () => [],
      getEnvVarNames: async () => [],
      getLogs: async () => [],
      triggerDeploy: async () => {
        throw new Error("unsupported");
      },
      getDeploy: async (_s: string, id: string) => ({ id, status: "live" as const, createdAt: "2026-07-04T00:00:00.000Z" }),
      instantDeploy: async (_tarball: Uint8Array, opts?: { projectHint?: string; env?: Record<string, string> }) => ({
        id: "mcp-instant-app-abc123",
        slug: "mcp-instant-app-abc123",
        url: "https://mcp-instant-app-abc123.openpouch.sh",
        claimUrl: "https://openpouch.sh/claim/mcp-instant-app-abc123?token=sekrit",
        claimToken: "sekrit",
        expiresAt: "2026-07-07T00:00:00.000Z",
        status: "live" as const,
        envSeen: opts?.env, // not part of the real DTO — lets the assertion below see what arrived
      }),
    };
    const server = createOpenpouchServer({
      baseCtx: {
        cwd: dir,
        env: { OPENPOUCH_HOME: home },
        createAdapter: () => runStub as unknown as typeof stubAdapter,
        probeUrl: async () => ({ healthy: true, status: 200, detail: "received 200" }),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-harness", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "openpouch_deploy",
      arguments: { env: { GREETING: "hello" }, healthPath: "/api/health" },
    });
    const json = parseText(result);
    expect(json.ok).toBe(true);
    expect(json.url).toBe("https://mcp-instant-app-abc123.openpouch.sh");
    expect(json.healthStatus).toBe("healthy");
    expect(json.healthPathCheck).toEqual({ path: "/api/health", passed: true, httpStatus: 200 });
    expect(json.envVars).toEqual(["GREETING"]);
    // copyable follow-ups ride along over MCP too (OpenClaw 2026-07-05 #4)
    expect((json.nextCommands as { verify: string }).verify).toBe("openpouch verify --json --health-path /api/health");
    // redaction is the DEFAULT over MCP: the token never enters chat context
    expect(json.claimUrlRedacted).toBe(true);
    expect(JSON.stringify(json)).not.toContain("sekrit");
    const relay = relayText(result);
    expect(relay).toBeDefined();
    expect(relay).not.toContain("sekrit");
    expect(relay).toContain(".openpouch/claim.json"); // the redacted summary points at the local file
  });

  it("marks the read-only tools with readOnlyHint (agent permission-UX, R9)", async () => {
    const client = await setup();
    const tools = (await client.listTools()).tools;
    const readOnly = new Set(["openpouch_inspect", "openpouch_plan", "openpouch_logs", "openpouch_whoami", "openpouch_list", "openpouch_list_approvals"]);
    for (const t of tools) {
      const hint = t.annotations?.readOnlyHint === true;
      expect(hint, `${t.name} readOnlyHint`).toBe(readOnly.has(t.name));
    }
  });

  it("list through MCP is anonymous-safe (empty owned set, read-only)", async () => {
    const client = await setup();
    const result = await client.callTool({ name: "openpouch_list", arguments: {} });
    const json = parseText(result) as { authenticated: boolean; deployments: unknown[] };
    expect(json.authenticated).toBe(false);
    expect(json.deployments).toEqual([]);
  });

  it("whoami through MCP reports anonymous when no key is set (R8: agent-usable, read-only)", async () => {
    const client = await setup();
    const result = await client.callTool({ name: "openpouch_whoami", arguments: {} });
    const json = parseText(result) as { authenticated: boolean };
    expect(json.authenticated).toBe(false);
    expect(relayText(result)).toBeDefined();
  });

  it("inspect answers the core question through MCP", async () => {
    const client = await setup();
    const result = await client.callTool({ name: "openpouch_inspect", arguments: {} });
    const json = parseText(result) as { environments: { production: { liveDeploy: { commit: string } } } };
    expect(json.environments.production.liveDeploy.commit).toBe("abcdef1234");
  });

  it("surfaces a plain-language summary for the human (R3): leading relay block + json.summary", async () => {
    const client = await setup();
    const result = await client.callTool({ name: "openpouch_inspect", arguments: {} });
    // R3: a relay-ready, jargon-free block precedes the JSON…
    const relay = relayText(result);
    expect(relay).toBeDefined();
    expect(relay).toContain("demo-app");
    // …and the identical summary is also inside the JSON (CLI/MCP contract parity, D13).
    const json = parseText(result) as { summary?: string };
    expect(typeof json.summary).toBe("string");
    expect(json.summary).toContain("demo-app");
  });

  it("production deploy through MCP hits the approval gate with isError + request id", async () => {
    const client = await setup();
    const result = await client.callTool({ name: "openpouch_deploy_production", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const json = parseText(result) as { error: { category: string }; approvalRequest: { id: string } };
    expect(json.error.category).toBe("approval-required");
    expect(json.approvalRequest.id).toMatch(/^[0-9a-f]{8}$/);

    const list = await client.callTool({ name: "openpouch_list_approvals", arguments: {} });
    const pending = parseText(list) as { pending: Array<{ id: string }> };
    expect(pending.pending[0]?.id).toBe(json.approvalRequest.id);
  });

  it("logs flow through MCP with limit", async () => {
    const client = await setup();
    const result = await client.callTool({ name: "openpouch_logs", arguments: { limit: 5 } });
    const json = parseText(result) as { count: number };
    expect(json.count).toBe(1);
  });

  it("logs defaults to the lone preview env on an instant-lane manifest (R9: no production dead-end)", async () => {
    // Instant-lane shape: only a `preview` env, no `production`. With no `environment`
    // arg, the MCP tool must target preview via the shared `targetEnvironment` helper —
    // not hard-default to a missing `production` (the bug that used to leak through the
    // MCP `?? "production"` defaults after the CLI was fixed).
    const client = await setup({ preview: { provider: "render", serviceId: "srv-prev" } });
    const result = await client.callTool({ name: "openpouch_logs", arguments: {} });
    const json = parseText(result) as { ok: boolean; environment: string };
    expect(json.ok).toBe(true);
    expect(json.environment).toBe("preview");
  });
});

describe("mcpCliResponse — --version/--help shell probes (OpenClaw 2026-07-06)", () => {
  it("answers --version with the package version instead of silent exit 0", () => {
    expect(mcpCliResponse(["--version"])).toContain("@openpouch/mcp");
    expect(mcpCliResponse(["-v"])).toBe(mcpCliResponse(["--version"]));
  });

  it("answers --help with stdio setup guidance, the no-approve rule, and the docs pointer", () => {
    const help = mcpCliResponse(["--help"]) ?? "";
    expect(help).toContain("stdio");
    expect(help).toContain("human-only");
    expect(help).toContain("docs/MCP.md");
  });

  it("stays in server mode when no flags are passed (an MCP client passes none)", () => {
    expect(mcpCliResponse([])).toBeUndefined();
  });
});
