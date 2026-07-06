import { describe, expect, it } from "vitest";
import { RunApiError, RunNetworkError, createRunAdapter } from "../src/index.js";

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("openpouch-run adapter", () => {
  it("instantDeploy POSTs the tarball with the project hint and returns the preview", async () => {
    const { impl, calls } = mockFetch((url) => {
      expect(url).toBe("https://run.test/api/deployments");
      return {
        status: 201,
        body: {
          id: "joey-abc123",
          slug: "joey-abc123",
          url: "https://joey-abc123.openpouch.sh",
          claimUrl: "https://openpouch.sh/claim/joey-abc123?token=tok",
          claimToken: "tok",
          expiresAt: "2026-06-15T00:00:00.000Z",
          status: "live",
        },
      };
    });
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    const out = await adapter.instantDeploy(new Uint8Array([1, 2, 3]), { projectHint: "my-app" });
    expect(out.slug).toBe("joey-abc123");
    expect(out.url).toBe("https://joey-abc123.openpouch.sh");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/gzip");
    expect(headers["x-openpouch-project"]).toBe("my-app");
    expect(calls[0]!.init!.method).toBe("POST");
  });

  it("getService and getRecentDeploys map a deployment DTO", async () => {
    const dto = {
      id: "s1",
      slug: "s1",
      status: "live",
      url: "https://s1.openpouch.sh",
      createdAt: "2026-06-12T00:00:00.000Z",
      expiresAt: "2026-06-15T00:00:00.000Z",
      claimed: false,
    };
    const { impl } = mockFetch(() => ({ body: { deployment: dto } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    expect((await adapter.getService("s1")).url).toBe("https://s1.openpouch.sh");
    const deploys = await adapter.getRecentDeploys("s1");
    expect(deploys[0]!.status).toBe("live");
    expect(deploys[0]!.createdAt).toBe("2026-06-12T00:00:00.000Z");
  });

  it("getLogs honours the limit; getEnvVarNames is empty; triggerDeploy is unsupported", async () => {
    const { impl } = mockFetch((url) => {
      if (url.endsWith("/logs")) {
        return { body: { logs: [{ message: "a" }, { message: "b" }, { message: "c" }] } };
      }
      return { body: {} };
    });
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    expect(await adapter.getLogs("s1", { limit: 2 })).toEqual([{ message: "b" }, { message: "c" }]);
    expect(await adapter.getEnvVarNames("s1")).toEqual([]);
    expect(() => adapter.triggerDeploy("s1")).toThrow(RunApiError);
  });

  it("maps a 429 to a quota error and a 404 to provider", async () => {
    const { impl } = mockFetch(() => ({ status: 429, body: { error: "rate limit exceeded" } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    await expect(adapter.getService("x")).rejects.toMatchObject({ category: "quota", status: 429 });
  });

  it("tunes the quota fix to the anonymous caller — no manual delete, wait for expiry or sign up (Hermes suite 2026-07-05)", async () => {
    const { impl } = mockFetch(() => ({ status: 429, body: { error: "rate limit exceeded — try later" } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    const err = (await adapter.instantDeploy(new Uint8Array([1])).catch((e) => e)) as RunApiError;
    expect(err).toBeInstanceOf(RunApiError);
    expect(err.category).toBe("quota");
    // the anonymous branch must state the hard truth and both real options
    expect(err.fix).toContain("anonymous previews can't be deleted manually");
    expect(err.fix).toContain("openpouch signup");
    // and must NOT dangle the account-only self-service as if it applied now
    expect(err.fix).not.toContain("If you have an openpouch account");
  });

  it("keeps the list/delete self-service quota fix for an authenticated caller", async () => {
    const { impl } = mockFetch(() => ({ status: 429, body: { error: "rate limit exceeded — try later" } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", apiKey: "opk_test", fetchImpl: impl });
    const err = (await adapter.instantDeploy(new Uint8Array([1])).catch((e) => e)) as RunApiError;
    expect(err).toBeInstanceOf(RunApiError);
    expect(err.category).toBe("quota");
    expect(err.fix).toContain("free a slot yourself");
    expect(err.fix).toContain("openpouch list");
    expect(err.fix).not.toContain("can't be deleted manually");
  });

  it("carries the server's captured output on a 422 build/start failure and gives app-directed guidance (OpenClaw suite 2026-07-05)", async () => {
    const failed = mockFetch(() => ({
      status: 422,
      body: { error: "dynamic deploy failed: app did not answer HTTP in time", logs: "[install] added 94 packages\n[app] Error: boom at server.js:2" },
    }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: failed.impl });
    const err = (await adapter.instantDeploy(new Uint8Array([1])).catch((e) => e)) as RunApiError;
    expect(err).toBeInstanceOf(RunApiError);
    // the self-repair loop gets the CAUSE in hand — the failed record is gone server-side
    expect(err.serverLogs).toContain("Error: boom at server.js:2");
    expect(err.fix).toContain("rerun the same deploy command");
    // no misleading service-status/expiry guidance for an app-caused failure
    expect(err.fix).not.toContain("service status");
  });

  it("gives a usage-grade fix when the server bounces an empty upload (no misleading expiry text)", async () => {
    const { impl } = mockFetch(() => ({ status: 400, body: { error: "tarball contained no files" } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    const err = (await adapter.instantDeploy(new Uint8Array([1])).catch((e) => e)) as RunApiError;
    expect(err).toBeInstanceOf(RunApiError);
    expect(err.fix).toContain("no deployable files");
    expect(err.fix).not.toContain("service status");
    expect(err.serverLogs).toBeUndefined();
  });
});

describe("openpouch-run adapter — accounts (B3)", () => {
  it("sends the API key as a Bearer header when configured, and not when anonymous", async () => {
    const keyed = mockFetch(() => ({ status: 201, body: { id: "a", slug: "a", url: "u", claimUrl: "c", claimToken: "t", expiresAt: "e", status: "live" } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", apiKey: "op_live_abc_secret", fetchImpl: keyed.impl });
    await adapter.instantDeploy(new Uint8Array([1]));
    const headers = keyed.calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer op_live_abc_secret");

    const anon = mockFetch(() => ({ status: 201, body: { id: "a", slug: "a", url: "u", claimUrl: "c", claimToken: "t", expiresAt: "e", status: "live" } }));
    const anonAdapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: anon.impl });
    await anonAdapter.instantDeploy(new Uint8Array([1]));
    expect((anon.calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("whoami GETs /api/account with the bearer and returns the status", async () => {
    const { impl, calls } = mockFetch((url) => {
      expect(url).toBe("https://run.test/api/account");
      return { body: { ok: true, account: { id: "acct_1", status: "active", tier: "free", identities: [], createdAt: "x" }, tier: { name: "free", deploysPerHour: 1, deploysPerDay: 1, maxLiveDeployments: 1, maxBytes: 1, maxDynamic: 1 }, usage: { liveDeployments: 0, dynamicDeployments: 0, deploysLastHour: 0, deploysLastDay: 0 } } };
    });
    const adapter = createRunAdapter({ apiBase: "https://run.test", apiKey: "op_live_x_y", fetchImpl: impl });
    const status = await adapter.whoami();
    expect(status.account.id).toBe("acct_1");
    expect(status.tier.name).toBe("free");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer op_live_x_y");
  });

  it("signupEmail + verifyEmail drive the account endpoints", async () => {
    const { impl, calls } = mockFetch((url) => {
      if (url.endsWith("/api/accounts")) return { status: 201, body: { ok: true, accountId: "acct_9", message: "check email" } };
      return { body: { ok: true, key: "op_live_new_secret", account: { id: "acct_9", status: "active", tier: "free", identities: [], createdAt: "x" } } };
    });
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    const signup = await adapter.signupEmail("a@b.com");
    expect(signup.accountId).toBe("acct_9");
    const verify = await adapter.verifyEmail("acct_9", "tok");
    expect(verify.key).toBe("op_live_new_secret");
    expect(calls[1]!.url).toBe("https://run.test/api/accounts/verify");
  });

  it("maps a 401 to an auth error and carries the server's fix", async () => {
    const { impl } = mockFetch(() => ({ status: 401, body: { error: "invalid or missing API key", fix: "send a Bearer key" } }));
    const adapter = createRunAdapter({ apiBase: "https://run.test", apiKey: "bad", fetchImpl: impl });
    await expect(adapter.whoami()).rejects.toMatchObject({ category: "auth", status: 401, fix: "send a Bearer key" });
  });

  it("exposes the GitHub start URL", () => {
    const adapter = createRunAdapter({ apiBase: "https://run.test/" });
    expect(adapter.githubStartUrl()).toBe("https://run.test/api/auth/github/start");
  });

  it("listDeployments GETs /api/deployments with the bearer and returns the owned set", async () => {
    const { impl, calls } = mockFetch((url) => {
      expect(url).toBe("https://run.test/api/deployments");
      return { body: { ok: true, deployments: [{ id: "a", slug: "a", status: "live", url: "https://a.openpouch.sh", kind: "static", createdAt: "t", expiresAt: "t2", claimed: false }] } };
    });
    const adapter = createRunAdapter({ apiBase: "https://run.test", apiKey: "op_live_x_y", fetchImpl: impl });
    const list = await adapter.listDeployments();
    expect(list).toHaveLength(1);
    expect(list[0]!.slug).toBe("a");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer op_live_x_y");
  });

  it("deleteDeployment DELETEs /api/deployments/:slug, returns slug + kind; 404 → provider", async () => {
    const ok = mockFetch((url, init) => {
      expect(url).toBe("https://run.test/api/deployments/joey-x");
      expect(init!.method).toBe("DELETE");
      return { body: { ok: true, slug: "joey-x", kind: "dynamic" } };
    });
    const adapter = createRunAdapter({ apiBase: "https://run.test", apiKey: "op_live_x_y", fetchImpl: ok.impl });
    expect(await adapter.deleteDeployment("joey-x")).toEqual({ slug: "joey-x", kind: "dynamic" });

    const notFound = mockFetch(() => ({ status: 404, body: { error: "not-found", fix: "run `openpouch list`" } }));
    const a2 = createRunAdapter({ apiBase: "https://run.test", apiKey: "op_live_x_y", fetchImpl: notFound.impl });
    await expect(a2.deleteDeployment("gone")).rejects.toMatchObject({ category: "provider", status: 404 });
  });
});

describe("network failures are classified, not generic (Codex 2026-07-04)", () => {
  it("a rejected fetch becomes a RunNetworkError naming the host + cause, with a diagnosable fix", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    const adapter = createRunAdapter({ apiBase: "https://run.test", fetchImpl: impl });
    const err = await adapter.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunNetworkError);
    const ne = err as RunNetworkError;
    expect(ne.category).toBe("network"); // NOT "provider" — the request never arrived
    expect(ne.message).toContain("run.test");
    expect(ne.message).toContain("DNS lookup failed");
    expect(ne.fix).toContain("curl -sS https://run.test/healthz"); // a concrete next check
    expect(ne.fix).toContain("NOT a problem with your app");
  });

  it("connection refused and timeout map to their own causes", async () => {
    const make = (code: string) =>
      createRunAdapter({
        apiBase: "https://run.test",
        fetchImpl: (async () => {
          throw new TypeError("fetch failed", { cause: { code } });
        }) as unknown as typeof fetch,
      });
    await expect(make("ECONNREFUSED").whoami()).rejects.toThrow(/connection refused/);
    await expect(make("UND_ERR_CONNECT_TIMEOUT").whoami()).rejects.toThrow(/connection timed out/);
  });
});
