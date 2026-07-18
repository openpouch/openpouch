import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunApiError } from "@openpouch/adapter-run";
import type { ProviderAdapter } from "@openpouch/core";
import { describe, expect, it } from "vitest";
import { deleteCommand } from "../src/commands/delete.js";
import { listCommand } from "../src/commands/list.js";
import type { CliContext } from "../src/shared.js";

/** A fake openpouch-run adapter with the list/delete surface (test seam). */
function fakeRun(extra: Record<string, unknown> = {}) {
  const base: ProviderAdapter = {
    id: "openpouch-run",
    listServices: async () => [],
    getService: async (id) => ({ id, name: id }),
    getRecentDeploys: async () => [],
    getEnvVarNames: async () => [],
    getLogs: async () => [],
    triggerDeploy: async () => {
      throw new Error("unsupported");
    },
    getDeploy: async (_s, id) => ({ id, status: "live" as const, createdAt: "t" }),
  };
  return {
    ...base,
    listDeployments: async () => [
      { id: "joey-aaa111", slug: "joey-aaa111", status: "live", url: "https://joey-aaa111.openpouch.sh", kind: "static", createdAt: "2026-06-30T10:00:00.000Z", expiresAt: "2026-07-03T10:00:00.000Z", claimed: true },
      { id: "api-bbb222", slug: "api-bbb222", status: "live", url: "https://api-bbb222.openpouch.sh", kind: "dynamic", runtimeStatus: "running", createdAt: "2026-06-30T11:00:00.000Z", expiresAt: "2026-07-03T11:00:00.000Z", claimed: true },
    ],
    deleteDeployment: async (slug: string) => ({ slug, kind: "static" as const }),
    ...extra,
  };
}

async function emptyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openpouch-home-"));
}
/** A context with a configured account key (the test seam ignores the value but it makes the call "keyed"). */
function keyedCtx(adapter: ProviderAdapter): CliContext {
  return { cwd: ".", env: { OPENPOUCH_API_KEY: "op_live_abc_secret" }, createAdapter: () => adapter };
}
async function anonCtx(adapter: ProviderAdapter): Promise<CliContext> {
  return { cwd: ".", env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => adapter };
}

describe("openpouch list", () => {
  it("reports anonymous (empty list + signup pointer) when no key is configured", async () => {
    const result = await listCommand(await anonCtx(fakeRun() as unknown as ProviderAdapter));
    expect(result.exitCode).toBe(0);
    expect(result.json.authenticated).toBe(false);
    expect(result.json.deployments).toEqual([]);
    expect((result.json.summary as string).toLowerCase()).toContain("account");
  });

  it("threads the key, renders the owned apps, and never leaks a token (D7)", async () => {
    let seenKey: string | undefined;
    const ctx: CliContext = {
      cwd: ".",
      env: { OPENPOUCH_API_KEY: "op_live_abc_secret" },
      createAdapter: (_p, key) => {
        seenKey = key;
        return fakeRun() as unknown as ProviderAdapter;
      },
    };
    const result = await listCommand(ctx);
    expect(result.exitCode).toBe(0);
    expect(seenKey).toBe("op_live_abc_secret");
    expect(result.json.count).toBe(2);
    const deployments = result.json.deployments as Array<{ slug: string }>;
    expect(deployments.map((d) => d.slug)).toEqual(["joey-aaa111", "api-bbb222"]);
    const human = result.human.join("\n");
    expect(human).toContain("joey-aaa111");
    expect(human).toContain("dynamic/running");
    const raw = JSON.stringify(result.json) + human;
    for (const leak of ["claimToken", "mgmtToken", "accountId"]) expect(raw).not.toContain(leak);
  });

  it("maps an auth error to exit 4", async () => {
    const adapter = fakeRun({
      listDeployments: async () => {
        throw new RunApiError(401, "invalid", "send a key");
      },
    }) as unknown as ProviderAdapter;
    const result = await listCommand(keyedCtx(adapter));
    expect(result.exitCode).toBe(4);
    expect((result.json.error as { category: string }).category).toBe("auth");
  });
});

describe("openpouch delete", () => {
  it("rejects a missing or invalid name with exit 2 and suggests `openpouch list`", async () => {
    const missing = await deleteCommand(keyedCtx(fakeRun() as unknown as ProviderAdapter), undefined);
    expect(missing.exitCode).toBe(2);
    expect((missing.json.error as { suggestedCommand: string }).suggestedCommand).toBe("openpouch list");
    const bad = await deleteCommand(keyedCtx(fakeRun() as unknown as ProviderAdapter), "Bad Slug!");
    expect(bad.exitCode).toBe(2);
  });

  it("refuses anonymous delete (exit 4 — owner-only)", async () => {
    const result = await deleteCommand(await anonCtx(fakeRun() as unknown as ProviderAdapter), "joey-aaa111");
    expect(result.exitCode).toBe(4);
    expect((result.json.error as { category: string }).category).toBe("auth");
  });

  it("deletes an owned app, threads the key, and confirms the freed slot", async () => {
    let seenKey: string | undefined;
    let deleted: string | undefined;
    const adapter = fakeRun({
      deleteDeployment: async (slug: string) => {
        deleted = slug;
        return { slug, kind: "dynamic" as const };
      },
    });
    const ctx: CliContext = {
      cwd: ".",
      env: { OPENPOUCH_API_KEY: "op_live_abc_secret" },
      createAdapter: (_p, key) => {
        seenKey = key;
        return adapter as unknown as ProviderAdapter;
      },
    };
    const result = await deleteCommand(ctx, "api-bbb222");
    expect(result.exitCode).toBe(0);
    expect(seenKey).toBe("op_live_abc_secret");
    expect(deleted).toBe("api-bbb222");
    expect(result.json.slug).toBe("api-bbb222");
    expect((result.json.summary as string).toLowerCase()).toContain("slot");
  });

  it("maps a 403 not-owner to a clear error pointing at `openpouch list`", async () => {
    const adapter = fakeRun({
      deleteDeployment: async () => {
        throw new RunApiError(403, "not-owner", "That deployment isn't on your account — run `openpouch list`.");
      },
    }) as unknown as ProviderAdapter;
    const result = await deleteCommand(keyedCtx(adapter), "someone-elses");
    expect(result.exitCode).toBe(5);
    expect((result.json.error as { suggestedCommand: string }).suggestedCommand).toBe("openpouch list");
  });
});
