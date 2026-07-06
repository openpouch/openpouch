import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Minimal zero-dependency reverse proxy: forwards an inbound request to a
 * dynamic app's container on 127.0.0.1:<port> and streams the response back.
 * run-d sits in the path only for dynamic hosts (ADR §8(A)) so it can track
 * idle and wake stopped containers. HTTP requests go through `proxyRequest`;
 * WebSocket (and other) `Upgrade` handshakes go through `proxyUpgrade`.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  opts?: { timeoutMs?: number; onUnavailable?: (res: ServerResponse, err?: Error) => void },
): void {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: withoutHopByHop(req.headers),
    },
    (ures) => {
      res.writeHead(ures.statusCode ?? 502, withoutHopByHop(ures.headers));
      ures.pipe(res);
    },
  );
  upstream.setTimeout(opts?.timeoutMs ?? 30_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    // Container unreachable (crashed, or not up yet). When the caller supplies a
    // white-label responder (this surface is END CUSTOMER-visible — D24), let it
    // render; otherwise fall back to a neutral, brand-free plain-text 502.
    if (res.headersSent) res.end();
    else if (opts?.onUnavailable) opts.onUnavailable(res, err);
    else {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("502 — the app is not responding");
    }
  });
  req.pipe(upstream);
}

/**
 * Forward a WebSocket (or other `Upgrade`) handshake to the dynamic app's
 * container and pipe the two sockets bidirectionally. Unlike `proxyRequest`,
 * the hop-by-hop headers ARE forwarded — the upstream needs `Upgrade`,
 * `Connection`, and the `Sec-WebSocket-*` headers to complete the handshake.
 * Zero-dep: built on `node:http`'s client `upgrade` event.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  targetPort: number,
  opts?: { timeoutMs?: number },
): void {
  const upstream = httpRequest({
    host: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: req.url,
    headers: req.headers, // forward as-is: the upgrade handshake needs Connection/Upgrade/Sec-WebSocket-*
  });

  // Idle-wake/connect timeout only until the handshake completes; once upgraded,
  // the long-lived socket manages its own lifetime.
  upstream.setTimeout(opts?.timeoutMs ?? 30_000, () => upstream.destroy(new Error("upstream upgrade timeout")));

  upstream.on("upgrade", (ures, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0); // handshake done — drop the timeout for the live connection
    // Relay the upstream's 101 status line + headers back to the client verbatim.
    const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
    for (const [k, v] of Object.entries(ures.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
      else if (v !== undefined) lines.push(`${k}: ${v}`);
    }
    clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);

    const shutdown = () => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on("error", shutdown);
    clientSocket.on("error", shutdown);
    upstreamSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstream.on("error", () => clientSocket.destroy());
  upstream.end();
}

/**
 * Single-shot health probe: resolves true if 127.0.0.1:<port> returns ANY HTTP
 * response (even 404/500 means the server is listening). The orchestrator polls
 * this after start/wake.
 */
export function probeHttp(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const reqObj = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "/" }, (res) => {
      res.resume(); // drain
      resolve(typeof res.statusCode === "number");
    });
    reqObj.setTimeout(timeoutMs, () => {
      reqObj.destroy();
      resolve(false);
    });
    reqObj.on("error", () => resolve(false));
    reqObj.end();
  });
}
