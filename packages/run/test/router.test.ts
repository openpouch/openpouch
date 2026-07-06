import { describe, expect, it } from "vitest";
import { CaddyAdminRouter } from "../src/router.js";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  origin: string | undefined;
}

function headerGet(headers: HeadersInit | undefined, name: string): string | undefined {
  const rec = (headers ?? {}) as Record<string, string>;
  return rec[name];
}

function mockFetch(opts: { routeExists: boolean }): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, origin: headerGet(init?.headers, "origin") });
    if (method === "GET" && u.pathname.startsWith("/id/")) {
      return { ok: opts.routeExists, status: opts.routeExists ? 200 : 404, text: async () => (opts.routeExists ? "{}" : "") };
    }
    if (method === "GET" && u.pathname === "/config/apps/http/servers") {
      return { ok: true, status: 200, text: async () => JSON.stringify({ srv1: { listen: [":80"] }, srv0: { listen: [":443"] } }) };
    }
    return { ok: true, status: 200, text: async () => "" };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CFG = { adminBase: "http://127.0.0.1:2019", upstream: "127.0.0.1:8787", routeId: "openpouch_dynamic" };

describe("CaddyAdminRouter", () => {
  it("deletes the route when there are no dynamic hosts", async () => {
    const { fetchImpl, calls } = mockFetch({ routeExists: true });
    await new CaddyAdminRouter({ ...CFG, fetchImpl }).sync([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/id/openpouch_dynamic" });
  });

  it("creates the route (prepended on the :443 server) when it does not exist yet", async () => {
    const { fetchImpl, calls } = mockFetch({ routeExists: false });
    await new CaddyAdminRouter({ ...CFG, fetchImpl }).sync(["b.openpouch.sh", "a.openpouch.sh"]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /id/openpouch_dynamic",
      "GET /config/apps/http/servers",
      "PUT /config/apps/http/servers/srv0/routes/0",
    ]);
    const put = calls[2]!.body as { match: { host: string[] }[]; handle: { handler: string; upstreams: { dial: string }[] }[]; terminal: boolean; "@id": string };
    expect(put.match[0]!.host).toEqual(["a.openpouch.sh", "b.openpouch.sh"]); // deduped + sorted
    expect(put.handle[0]!.handler).toBe("reverse_proxy");
    expect(put.handle[0]!.upstreams[0]!.dial).toBe("127.0.0.1:8787");
    expect(put.terminal).toBe(true);
    expect(put["@id"]).toBe("openpouch_dynamic");
  });

  it("patches the existing route in place when it already exists", async () => {
    const { fetchImpl, calls } = mockFetch({ routeExists: true });
    await new CaddyAdminRouter({ ...CFG, fetchImpl }).sync(["a.openpouch.sh"]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /id/openpouch_dynamic", "PATCH /id/openpouch_dynamic"]);
    const patch = calls[1]!.body as { match: { host: string[] }[] };
    expect(patch.match[0]!.host).toEqual(["a.openpouch.sh"]);
  });

  it("sends the admin endpoint as Origin (Caddy anti-DNS-rebinding check)", async () => {
    const { fetchImpl, calls } = mockFetch({ routeExists: true });
    await new CaddyAdminRouter({ ...CFG, fetchImpl }).sync(["a.openpouch.sh"]);
    // every admin call carries Origin = the admin base, else Caddy returns 403 "origin ''"
    expect(calls.every((c) => c.origin === "http://127.0.0.1:2019")).toBe(true);
  });
});
