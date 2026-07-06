import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { PortExhaustedError, PortPool } from "../src/ports.js";
import { clientIp, RateLimiter } from "../src/server.js";

function fakeReq(headers: Record<string, string>, remoteAddress = "203.0.113.7"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe("PortPool", () => {
  it("allocates the lowest free port and advances", () => {
    const pool = new PortPool(20000, 20002);
    expect(pool.allocate()).toBe(20000);
    expect(pool.allocate()).toBe(20001);
    expect(pool.allocate()).toBe(20002);
  });

  it("throws when the range is exhausted", () => {
    const pool = new PortPool(20000, 20000);
    expect(pool.allocate()).toBe(20000);
    expect(() => pool.allocate()).toThrow(PortExhaustedError);
  });

  it("reserve() skips a port (used to rebuild from the registry)", () => {
    const pool = new PortPool(20000, 20002);
    pool.reserve(20000);
    pool.reserve(20001);
    expect(pool.allocate()).toBe(20002);
  });

  it("release() returns a port to the pool", () => {
    const pool = new PortPool(20000, 20001);
    expect(pool.allocate()).toBe(20000);
    expect(pool.allocate()).toBe(20001);
    pool.release(20000);
    expect(pool.allocate()).toBe(20000);
    expect(pool.size).toBe(2);
  });
});

describe("clientIp (X-Forwarded-For spoof resistance)", () => {
  it("trusts the right-most XFF hop (the one our own proxy appends), not the client-controlled left", () => {
    // Caddy appends the real peer as the last hop, so an attacker who sets
    // "X-Forwarded-For: 9.9.9.9" cannot forge attribution: the right-most wins.
    expect(clientIp(fakeReq({ "x-forwarded-for": "9.9.9.9, 198.51.100.4" }))).toBe("198.51.100.4");
    // A single spoofed value is still that value (no proxy in front) — but two
    // requests spoofing different left values behind the same proxy collapse to
    // the same real right-most IP, so the limiter can't be rotated past.
    expect(clientIp(fakeReq({ "x-forwarded-for": "1.1.1.1, 198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("falls back to the socket peer when no XFF is present", () => {
    expect(clientIp(fakeReq({}))).toBe("203.0.113.7");
    expect(clientIp(fakeReq({ "x-forwarded-for": "" }))).toBe("203.0.113.7");
  });
});

describe("RateLimiter (window + lifetime-bounded map)", () => {
  it("enforces the per-hour and per-day windows", () => {
    const rl = new RateLimiter(2, 3);
    const t = 1_000_000;
    expect(rl.allow("a", t)).toBe(true);
    expect(rl.allow("a", t)).toBe(true);
    expect(rl.allow("a", t)).toBe(false); // 3rd within the hour → per-hour cap (2) hit
    // an hour later, two more are allowed until the per-day cap (3) bites
    expect(rl.allow("a", t + 3_600_001)).toBe(true);
    expect(rl.allow("a", t + 3_600_002)).toBe(false); // per-day cap (3) reached
  });

  it("prune() drops IPs with no hits in the last 24h so the map stays bounded", () => {
    const rl = new RateLimiter(10, 100);
    const t = 1_000_000;
    rl.allow("old", t);
    rl.allow("recent", t);
    expect(rl.size).toBe(2);
    // 25h later: "old" has no recent hit and is dropped; "recent" got a fresh hit.
    rl.allow("recent", t + 25 * 3_600_000);
    rl.prune(t + 25 * 3_600_000);
    expect(rl.size).toBe(1);
  });
});
