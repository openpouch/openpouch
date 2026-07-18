import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ProviderAdapter } from "@openpouch/core";
import { describe, expect, it, vi } from "vitest";
import { deleteCommand } from "../src/commands/delete.js";
import { upgradeCommand } from "../src/commands/upgrade.js";
import { inspectCommand } from "../src/commands/inspect.js";
import { instantCommand } from "../src/commands/instant.js";
import { listCommand } from "../src/commands/list.js";
import { logsCommand } from "../src/commands/logs.js";
import { verifyCommand } from "../src/commands/verify.js";
import { whoamiCommand } from "../src/commands/whoami.js";
import type { CliContext } from "../src/shared.js";

/**
 * Drift guard for docs/schemas/ (B1, pre-launch plan 2026-07-05): every published
 * JSON Schema is validated here against a REAL command result produced by the
 * actual command code — a field rename or contract break fails CI, so the schemas
 * can never drift into fiction. Schemas promise additive evolution: they must
 * accept today's real outputs; unknown extra fields stay allowed by design.
 */

// format assertions off: `format` is annotation-only in our contract (draft 2020-12
// treats it as non-assertive by default); structure is what we guarantee.
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
// compile once per schema — ajv registers each by $id and rejects duplicates
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const schema = (name: string) => {
  let v = compiled.get(name);
  if (v === undefined) {
    v = ajv.compile(JSON.parse(readFileSync(new URL(`../../../docs/schemas/${name}.schema.json`, import.meta.url), "utf8")));
    compiled.set(name, v);
  }
  return v;
};

const validate = (name: string, json: unknown) => {
  const v = schema(name);
  const ok = v(json);
  expect(v.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
};

function mockRunAdapter() {
  const base: ProviderAdapter = {
    id: "openpouch-run",
    listServices: async () => [],
    getService: async (id) => ({ id, name: id, url: `https://${id}.openpouch.sh` }),
    // Shaped like the real run adapter since the A-6 pass-through: the box's
    // public GET carries the live expiry, so inspect's liveDeploy does too.
    getRecentDeploys: async (id) => [
      { id, status: "live" as const, createdAt: "2026-07-05T00:00:00.000Z", expiresAt: "2026-10-05T00:00:00.000Z" },
    ],
    getEnvVarNames: async () => [],
    getLogs: async () => [
      { timestamp: "2026-07-05T20:00:00.000Z", message: "[install] added 12 packages" },
      { message: "serving on port 3000" },
    ],
    triggerDeploy: async () => {
      throw new Error("unsupported");
    },
    getDeploy: async (_s, id) => ({ id, status: "live", createdAt: "2026-07-05T00:00:00.000Z" }),
  };
  return {
    ...base,
    envIntrospection: "unavailable" as const,
    instantDeploy: async (_t: Uint8Array, opts?: { projectHint?: string }) => ({
      id: `${opts?.projectHint ?? "joey"}-sch111`,
      slug: `${opts?.projectHint ?? "joey"}-sch111`,
      url: `https://${opts?.projectHint ?? "joey"}-sch111.openpouch.sh`,
      claimUrl: "https://openpouch.sh/claim/x-sch111?token=tok",
      claimToken: "tok",
      expiresAt: "2026-07-08T00:00:00.000Z",
      status: "live" as const,
    }),
    whoami: async () => ({
      account: {
        id: "acct_schema1",
        status: "active",
        tier: "free",
        identities: [{ kind: "email", value: "s@example.com", label: "s@example.com" }],
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      tier: { name: "free", deploysPerHour: 10, deploysPerDay: 40, maxLiveDeployments: 5, maxBytes: 26214400, maxDynamic: 2 },
      usage: { liveDeployments: 1, dynamicDeployments: 0, deploysLastHour: 1, deploysLastDay: 1 },
    }),
    listDeployments: async () => [
      {
        id: "app-sch111",
        slug: "app-sch111",
        status: "live" as const,
        url: "https://app-sch111.openpouch.sh",
        kind: "static" as const,
        createdAt: "2026-07-05T00:00:00.000Z",
        expiresAt: "2026-07-08T00:00:00.000Z",
        claimed: false,
      },
    ],
    deleteDeployment: async (slug: string) => ({ slug, kind: "static" }),
    createCheckout: async (plan: string) => ({
      ok: true,
      plan,
      founderPricing: false,
      checkoutUrl: "https://sandbox-pay.example/txn_sch111",
      summary: `Checkout link for the ${plan} plan: hand this URL to the human who pays.`,
    }),
  };
}

const healthyProbe = async () => ({ healthy: true, status: 200, detail: "received 200" });

async function tmpProject(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "opschema-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  return dir;
}

const emptyHome = () => mkdtemp(join(tmpdir(), "opschema-home-"));

describe("published JSON Schemas validate real command results (docs/schemas/, B1)", () => {
  it("deploy result (healthy static, default claim tiering) matches deploy.schema.json", async () => {
    const cwd = await tmpProject("schema-site");
    const ctx: CliContext = { cwd, env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(0);
    validate("deploy", result.json);
  });

  it("account-owned deploy result (0.3.1: ownership fields, no claim fields) matches deploy.schema.json", async () => {
    const cwd = await tmpProject("schema-owned");
    const ownedAdapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => ({
        id: "owned-s1",
        slug: "owned-s1",
        url: "https://owned-s1.openpouch.sh",
        ownership: "account" as const,
        expiryPolicy: "rolling-while-used" as const,
        expiresAt: "2026-10-10T00:00:00.000Z",
        status: "live" as const,
      }),
    };
    const ctx: CliContext = { cwd, env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => ownedAdapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(0);
    validate("deploy", result.json);
    expect((result.json as { claimUrlIsPrivate?: boolean }).claimUrlIsPrivate).toBeUndefined();
  });

  it("verify + inspect + logs on the deployed project match their schemas", async () => {
    const cwd = await tmpProject("schema-site2");
    const ctx: CliContext = { cwd, env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    expect((await instantCommand(ctx)).exitCode).toBe(0);

    // verify's smoke checks go through global fetch (same seam the other tests stub)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    try {
      const verify = await verifyCommand(ctx, "preview");
      expect(verify.exitCode).toBe(0);
      validate("verify", verify.json);
    } finally {
      vi.unstubAllGlobals();
    }

    const inspect = await inspectCommand(ctx);
    expect(inspect.exitCode).toBe(0);
    // A-6: the resume surface names the machine-readable expiry (live server truth).
    const envs = (inspect.json as { environments: Record<string, { liveDeploy?: { expiresAt?: string } }> }).environments;
    expect(envs["preview"]?.liveDeploy?.expiresAt).toBe("2026-10-05T00:00:00.000Z");
    validate("inspect", inspect.json);

    const logs = await logsCommand(ctx, "preview", 50);
    expect(logs.exitCode).toBe(0);
    validate("logs", logs.json);
  });

  it("whoami (anonymous AND authenticated) matches whoami.schema.json", async () => {
    const anon: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => mockRunAdapter() };
    const anonResult = await whoamiCommand(anon);
    expect(anonResult.json.authenticated).toBe(false);
    validate("whoami", anonResult.json);

    const authed: CliContext = {
      cwd: ".",
      env: { OPENPOUCH_HOME: await emptyHome(), OPENPOUCH_API_KEY: "op_live_schematest_secret" },
      createAdapter: () => mockRunAdapter(),
    };
    const authResult = await whoamiCommand(authed);
    expect(authResult.json.authenticated).toBe(true);
    validate("whoami", authResult.json);
  });

  it("upgrade (authenticated) matches upgrade.schema.json", async () => {
    const authed: CliContext = {
      cwd: ".",
      env: { OPENPOUCH_HOME: await emptyHome(), OPENPOUCH_API_KEY: "op_live_schematest_secret" },
      createAdapter: () => mockRunAdapter(),
    };
    const up = await upgradeCommand(authed, "starter");
    expect(up.exitCode).toBe(0);
    validate("upgrade", up.json);
  });

  it("list (anonymous AND authenticated) matches list.schema.json; delete success matches delete.schema.json", async () => {
    const anon: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => mockRunAdapter() };
    validate("list", (await listCommand(anon)).json);

    const authed: CliContext = {
      cwd: ".",
      env: { OPENPOUCH_HOME: await emptyHome(), OPENPOUCH_API_KEY: "op_live_schematest_secret" },
      createAdapter: () => mockRunAdapter(),
    };
    validate("list", (await listCommand(authed)).json);

    const del = await deleteCommand(authed, "app-sch111");
    expect(del.exitCode).toBe(0);
    validate("delete", del.json);
  });

  it("failure results match error.schema.json across categories (usage preflight, quota, anonymous delete)", async () => {
    // usage: the empty-directory preflight stops locally before any upload
    const emptyDir = await mkdtemp(join(tmpdir(), "opschema-empty-"));
    const usage = await instantCommand({ cwd: emptyDir, env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => mockRunAdapter() });
    expect(usage.exitCode).toBeGreaterThan(0);
    expect((usage.json.error as { category: string }).category).toBe("usage");
    validate("error", usage.json);

    // quota: the adapter surfaces a classified 429 (anonymous-aware fix, Hermes suite 2026-07-05)
    const quotaErr = Object.assign(new Error("openpouch-run 429: rate limit exceeded — try later"), {
      category: "quota",
      status: 429,
      fix: "A limit was reached. You're deploying anonymously, and anonymous previews can't be deleted manually — wait for a slot to roll off or sign up.",
    });
    const quotaAdapter = { ...mockRunAdapter(), instantDeploy: async () => Promise.reject(quotaErr) };
    const cwd = await tmpProject("schema-quota");
    const quota = await instantCommand({ cwd, env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => quotaAdapter, probeUrl: healthyProbe });
    expect(quota.exitCode).toBeGreaterThan(0);
    expect((quota.json.error as { category: string }).category).toBe("quota");
    validate("error", quota.json);

    // auth boundary: deleting without a key is refused with an agent-actionable fix
    const anonDelete = await deleteCommand({ cwd: ".", env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => mockRunAdapter() }, "someone-elses-app");
    expect(anonDelete.exitCode).toBeGreaterThan(0);
    validate("error", anonDelete.json);
  });
});
