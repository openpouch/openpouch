import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_TIER,
  type Tier,
  type QuotaUsage,
  checkQuota,
  defaultTiers,
  pruneDeploys,
  resolveTier,
  tiersFromEnv,
} from "../src/quota.js";

const NOW = 1_700_000_000_000;

const TIER: Tier = {
  name: "test",
  deploysPerHour: 3,
  deploysPerDay: 5,
  maxLiveDeployments: 4,
  maxBytes: 1000,
  maxDynamic: 2, volumeMaxBytes: 0, maxAlwaysOn: 0,
};

const emptyUsage = (): QuotaUsage => ({ recentDeploys: [], liveCount: 0, dynamicCount: 0 });

describe("quota: defaults + resolution", () => {
  it("ships an anonymous tier and tier lookup falls back to it", () => {
    const tiers = defaultTiers();
    expect(tiers[ANONYMOUS_TIER]).toBeDefined();
    expect(resolveTier(tiers, "free").name).toBe("free");
    expect(resolveTier(tiers, "does-not-exist").name).toBe(ANONYMOUS_TIER);
    expect(resolveTier(tiers, undefined).name).toBe(ANONYMOUS_TIER);
  });

  it("anonymous tier is no looser than free on every axis", () => {
    const { anonymous, free } = defaultTiers() as Record<string, Tier>;
    expect(anonymous!.deploysPerHour).toBeLessThanOrEqual(free!.deploysPerHour);
    expect(anonymous!.deploysPerDay).toBeLessThanOrEqual(free!.deploysPerDay);
    expect(anonymous!.maxLiveDeployments).toBeLessThanOrEqual(free!.maxLiveDeployments);
    expect(anonymous!.maxDynamic).toBeLessThanOrEqual(free!.maxDynamic);
  });
});

describe("quota: tiersFromEnv (configurable, D16)", () => {
  it("returns defaults when unset", () => {
    expect(tiersFromEnv({}).tiers).toEqual(defaultTiers());
  });

  it("fully replaces the table with a valid JSON override", () => {
    const custom = {
      anonymous: { deploysPerHour: 1, deploysPerDay: 2, maxLiveDeployments: 1, maxBytes: 100, maxDynamic: 0, volumeMaxBytes: 0, maxAlwaysOn: 0 },
      free: { deploysPerHour: 9, deploysPerDay: 9, maxLiveDeployments: 9, maxBytes: 999, maxDynamic: 9, volumeMaxBytes: 0, maxAlwaysOn: 0 },
    };
    const { tiers, warning } = tiersFromEnv({ OPENPOUCH_TIERS_JSON: JSON.stringify(custom) });
    expect(warning).toBeUndefined();
    expect(tiers.free!.deploysPerHour).toBe(9);
    expect(tiers.anonymous!.maxBytes).toBe(100);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["not an object", "[1,2,3]"],
    ["malformed tier", JSON.stringify({ anonymous: { deploysPerHour: "lots" } })],
    ["missing anonymous", JSON.stringify({ free: { deploysPerHour: 1, deploysPerDay: 1, maxLiveDeployments: 1, maxBytes: 1, maxDynamic: 1, volumeMaxBytes: 0, maxAlwaysOn: 0 } })],
  ])("falls back to defaults with a warning on %s", (_label, value) => {
    const { tiers, warning } = tiersFromEnv({ OPENPOUCH_TIERS_JSON: value });
    expect(tiers).toEqual(defaultTiers());
    expect(warning).toBeTruthy();
  });
});

describe("quota: checkQuota", () => {
  it("allows a deploy well within limits", () => {
    expect(checkQuota(TIER, emptyUsage(), { now: NOW, bytes: 500, dynamic: false })).toEqual({ ok: true });
  });

  it("rejects an oversized upload with 413", () => {
    const r = checkQuota(TIER, emptyUsage(), { now: NOW, bytes: 1001, dynamic: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("too-large");
      expect(r.status).toBe(413);
    }
  });

  it("enforces the dynamic concurrency cap only for dynamic deploys", () => {
    const usage: QuotaUsage = { recentDeploys: [], liveCount: 2, dynamicCount: 2 };
    expect(checkQuota(TIER, usage, { now: NOW, bytes: 10, dynamic: false }).ok).toBe(true);
    const r = checkQuota(TIER, usage, { now: NOW, bytes: 10, dynamic: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("max-dynamic");
  });

  it("enforces the live-deployment cap", () => {
    const usage: QuotaUsage = { recentDeploys: [], liveCount: 4, dynamicCount: 0 };
    const r = checkQuota(TIER, usage, { now: NOW, bytes: 10, dynamic: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("max-live");
      expect(r.status).toBe(429);
    }
  });

  it("enforces the hourly rate with a retry hint", () => {
    const recentDeploys = [NOW - 1000, NOW - 2000, NOW - 3000]; // 3 within the hour = limit
    const r = checkQuota(TIER, { recentDeploys, liveCount: 0, dynamicCount: 0 }, { now: NOW, bytes: 10, dynamic: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rate-hour");
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(r.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    }
  });

  it("enforces the daily rate before the hourly one", () => {
    // 5 deploys spread across the day (only 1 in the last hour) → daily limit hit first.
    const recentDeploys = [NOW - 1000, NOW - 2 * 3_600_000, NOW - 4 * 3_600_000, NOW - 6 * 3_600_000, NOW - 8 * 3_600_000];
    const r = checkQuota(TIER, { recentDeploys, liveCount: 0, dynamicCount: 0 }, { now: NOW, bytes: 10, dynamic: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rate-day");
  });

  it("ignores deploys older than the rolling windows", () => {
    const recentDeploys = [NOW - 2 * 3_600_000, NOW - 25 * 3_600_000, NOW - 26 * 3_600_000]; // only 1 in last 24h
    const r = checkQuota(TIER, { recentDeploys, liveCount: 0, dynamicCount: 0 }, { now: NOW, bytes: 10, dynamic: false });
    expect(r.ok).toBe(true);
  });
});

describe("quota: pruneDeploys", () => {
  it("drops timestamps older than 24h", () => {
    const pruned = pruneDeploys([NOW - 1000, NOW - 25 * 3_600_000], NOW);
    expect(pruned).toEqual([NOW - 1000]);
  });
});

describe("tiersFromEnv: staged-0.3.0 fields are optional (rollout back-compat)", () => {
  it("parses a pre-0.3.0 OPENPOUCH_TIERS_JSON (no volume/always-on fields) with the features OFF", () => {
    const legacy = JSON.stringify({
      anonymous: { deploysPerHour: 5, deploysPerDay: 20, maxLiveDeployments: 5, maxBytes: 1, maxDynamic: 1 },
      free: { deploysPerHour: 20, deploysPerDay: 80, maxLiveDeployments: 25, maxBytes: 1, maxDynamic: 2 },
    });
    const { tiers, warning } = tiersFromEnv({ OPENPOUCH_TIERS_JSON: legacy });
    expect(warning).toBeUndefined();
    expect(tiers.free!.volumeMaxBytes).toBe(0);
    expect(tiers.free!.maxAlwaysOn).toBe(0);
  });

  it("honours the new fields when present", () => {
    const table = JSON.stringify({
      anonymous: { deploysPerHour: 5, deploysPerDay: 20, maxLiveDeployments: 5, maxBytes: 1, maxDynamic: 1 },
      pro: { deploysPerHour: 100, deploysPerDay: 600, maxLiveDeployments: 200, maxBytes: 1, maxDynamic: 15, volumeMaxBytes: 5e9, maxAlwaysOn: 3 },
    });
    const { tiers } = tiersFromEnv({ OPENPOUCH_TIERS_JSON: table });
    expect(tiers.pro!.volumeMaxBytes).toBe(5e9);
    expect(tiers.pro!.maxAlwaysOn).toBe(3);
  });
});
