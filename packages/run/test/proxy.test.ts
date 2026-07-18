import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeHttp, proxyRequest } from "../src/proxy.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
}

describe("reverse proxy", () => {
  it("forwards method, body, and streams the response back with headers", async () => {
    const upstreamPort = await listen(
      createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += String(c)));
        req.on("end", () => {
          res.writeHead(201, { "content-type": "application/json", "x-app": "joey" });
          res.end(JSON.stringify({ method: req.method, path: req.url, body }));
        });
      }),
    );
    const frontPort = await listen(createServer((req, res) => proxyRequest(req, res, upstreamPort)));

    const res = await fetch(`http://127.0.0.1:${frontPort}/echo?q=1`, { method: "POST", body: "hello" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-app")).toBe("joey");
    expect(await res.json()).toEqual({ method: "POST", path: "/echo?q=1", body: "hello" });
  });

  it("returns 502 when the upstream is not listening", async () => {
    const frontPort = await listen(createServer((req, res) => proxyRequest(req, res, 1)));
    const res = await fetch(`http://127.0.0.1:${frontPort}/`);
    expect(res.status).toBe(502);
  });
});

describe("probeHttp", () => {
  it("is true when a server answers and false when nothing is there", async () => {
    const port = await listen(createServer((_req, res) => res.end("ok")));
    expect(await probeHttp(port)).toBe(true);
    expect(await probeHttp(1, 300)).toBe(false);
  });
});
