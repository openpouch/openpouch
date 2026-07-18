import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Counters } from "../src/counters.js";

const DAY = 24 * 3_600_000;

describe("Counters (M-1 aggregate daily tallies)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "op-counters-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("buckets plain and nested increments by UTC day", async () => {
    const c = new Counters({ dataDir: dir });
    await c.init();
    const now = Date.parse("2026-07-15T10:00:00Z");
    c.bump("signups", undefined, now);
    c.bump("signups", undefined, now);
    c.bump("deploys", "static", now);
    c.bump("deploys", "anon", now);
    c.bump("deploys", "static", now + DAY); // next day → new bucket
    await c.flush();

    const snap = c.snapshot();
    expect(snap["2026-07-15"]).toEqual({ signups: 2, deploys: { static: 1, anon: 1 } });
    expect(snap["2026-07-16"]).toEqual({ deploys: { static: 1 } });
  });

  it("persists atomically and survives a reload", async () => {
    const c = new Counters({ dataDir: dir });
    await c.init();
    const now = Date.parse("2026-07-15T10:00:00Z");
    c.bump("claims", "token", now);
    c.bump("quota429", "rate-hour", now);
    await c.flush();

    const raw = JSON.parse(await readFile(join(dir, "counters.json"), "utf8")) as Record<string, unknown>;
    expect(raw["2026-07-15"]).toEqual({ claims: { token: 1 }, quota429: { "rate-hour": 1 } });

    const reloaded = new Counters({ dataDir: dir });
    await reloaded.init();
    reloaded.bump("claims", "token", now);
    await reloaded.flush();
    expect(reloaded.snapshot()["2026-07-15"]).toEqual({ claims: { token: 2 }, quota429: { "rate-hour": 1 } });
  });

  it("prunes buckets older than the retention window on rollover", async () => {
    const c = new Counters({ dataDir: dir, retentionDays: 10 });
    await c.init();
    const old = Date.parse("2026-01-01T00:00:00Z");
    const recent = old + 30 * DAY;
    c.bump("signups", undefined, old);
    c.bump("signups", undefined, recent); // new bucket → prune runs
    await c.flush();

    const snap = c.snapshot();
    expect(snap["2026-01-01"]).toBeUndefined();
    expect(snap["2026-01-31"]).toEqual({ signups: 1 });
  });

  it("starts fresh on a corrupt file instead of failing", async () => {
    await writeFile(join(dir, "counters.json"), "{not json", "utf8");
    const c = new Counters({ dataDir: dir });
    await c.init();
    c.bump("signups");
    await c.flush();
    expect(Object.keys(c.snapshot()).length).toBe(1);
  });

  it("never throws out of bump when the disk write fails", async () => {
    const errors: string[] = [];
    const c = new Counters({ dataDir: join(dir, "\0invalid"), onError: (m) => errors.push(m) });
    await c.init();
    expect(() => c.bump("signups")).not.toThrow();
    await c.flush(); // resolves despite the failed write
    expect(errors.length).toBe(1);
  });
});
