import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMED_TTL_MS, DEFAULT_INACTIVITY_MS, DEFAULT_TTL_MS, Store, sanitizeHint } from "../src/store.js";

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "oprun-"));
  const store = new Store({ dataDir: dir });
  await store.init();
  return { dir, store };
}

describe("instant-lane store", () => {
  it("sanitizeHint produces DNS-label-safe hints with a fallback", () => {
    expect(sanitizeHint("My Cool App!")).toBe("my-cool-app");
    expect(sanitizeHint("___")).toBe("joey");
    expect(sanitizeHint(undefined)).toBe("joey");
    expect(sanitizeHint("a".repeat(50)).length).toBeLessThanOrEqual(24);
  });

  it("create reserves a unique slug, sets the 72h TTL, and seeds events", async () => {
    const { store } = await freshStore();
    const now = 1_000_000;
    const a = await store.create({ hint: "joey", bytes: 100, fileCount: 2, now });
    const b = await store.create({ hint: "joey", bytes: 100, fileCount: 2, now });
    expect(a.slug).not.toBe(b.slug);
    expect(a.slug.startsWith("joey-")).toBe(true);
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(DEFAULT_TTL_MS);
    expect(a.status).toBe("live");
    expect(a.events.length).toBeGreaterThanOrEqual(2);
    // create seeds "accepted", never "live" — the server appends "status: live"
    // only after build/start succeed (Codex OP-002, 2026-07-13).
    expect(a.events.map((e) => e.message)).toContain("status: accepted");
    expect(a.events.map((e) => e.message)).not.toContain("status: live");
    expect(a.claimToken.length).toBeGreaterThan(10);
  });

  it("create with accountId starts on the rolling inactivity window, not the 72h TTL (Codex F-01, 2026-07-12)", async () => {
    // The deploy response is the surface agents trust: an account-owned deploy
    // must show the rolling window from second zero — before, it showed the
    // anonymous 72h TTL and only healed on the first request (touchActivity).
    const { store } = await freshStore();
    const now = 1_000_000;
    const owned = await store.create({ hint: "joey", bytes: 100, fileCount: 2, now, accountId: "acct_1" });
    expect(Date.parse(owned.expiresAt) - now).toBe(DEFAULT_INACTIVITY_MS);
    const anon = await store.create({ hint: "joey", bytes: 100, fileCount: 2, now });
    expect(Date.parse(anon.expiresAt) - now).toBe(DEFAULT_TTL_MS);
  });

  it("appendEvents adds many lines in one persist and survives a reload", async () => {
    const { dir, store } = await freshStore();
    const rec = await store.create({ hint: "site", bytes: 1, fileCount: 1, now: 0 });
    const before = store.get(rec.id)!.events.length;
    await store.appendEvents(rec.id, ["[install] line a", "[install] line b"], 10);
    await store.appendEvents(rec.id, [], 20); // no-op
    const reopened = new Store({ dataDir: dir });
    await reopened.init();
    const events = reopened.get(rec.id)!.events;
    expect(events.length).toBe(before + 2);
    expect(events.map((e) => e.message)).toContain("[install] line b");
  });

  it("stamps strictly-increasing event timestamps even under a single deploy 'now' (Hermes 2026-07-02)", async () => {
    const { store } = await freshStore();
    const rec = await store.create({ hint: "site", bytes: 1, fileCount: 1, now: 1000 });
    const before = store.get(rec.id)!.events.length;
    // A real deploy records install + build + a lifecycle line all with the SAME
    // deploy `now` — previously every `logs` line collapsed to one timestamp.
    await store.appendEvents(rec.id, ["[install] a", "[install] b", "[install] c"], 5000);
    await store.appendEvents(rec.id, ["[build] x", "[build] y"], 5000);
    await store.appendEvent(rec.id, "live", 5000);
    const appended = store.get(rec.id)!.events.slice(before);
    const ts = appended.map((e) => Date.parse(e.timestamp));
    expect(ts).toHaveLength(6);
    expect(ts[0]!).toBeGreaterThanOrEqual(5000); // at least the deploy instant
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!); // sortable
  });

  it("persists across reloads", async () => {
    const { dir, store } = await freshStore();
    const rec = await store.create({ hint: "site", bytes: 1, fileCount: 1, now: 5 });
    const reopened = new Store({ dataDir: dir });
    await reopened.init();
    expect(reopened.get(rec.id)?.slug).toBe(rec.slug);
    expect(reopened.list()).toHaveLength(1);
  });

  it("claim requires the exact token, is single-use, and extends to 7 days", async () => {
    const { store } = await freshStore();
    const now = 2_000_000;
    const rec = await store.create({ hint: "x", bytes: 1, fileCount: 1, now });
    expect((await store.claim(rec.id, "wrong", now)).ok).toBe(false);
    const good = await store.claim(rec.id, rec.claimToken, now);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(Date.parse(good.record.expiresAt) - now).toBe(CLAIMED_TTL_MS);
      expect(good.record.mgmtToken).toBeTruthy();
    }
    // second claim refused
    expect((await store.claim(rec.id, rec.claimToken, now)).ok).toBe(false);
  });

  it("remove deletes the site dir and requires the mgmt token once claimed", async () => {
    const { store } = await freshStore();
    const now = 3_000_000;
    const rec = await store.create({ hint: "x", bytes: 1, fileCount: 1, now });
    await mkdir(store.siteDir(rec.slug), { recursive: true });
    await writeFile(join(store.siteDir(rec.slug), "index.html"), "hi");
    const claimed = await store.claim(rec.id, rec.claimToken, now);
    expect(claimed.ok).toBe(true);
    // wrong/absent mgmt token is refused
    expect((await store.remove(rec.id)).ok).toBe(false);
    const mgmt = claimed.ok ? claimed.record.mgmtToken : undefined;
    const removed = await store.remove(rec.id, { mgmtToken: mgmt });
    expect(removed.ok).toBe(true);
    expect(store.get(rec.id)).toBeUndefined();
    await expect(stat(store.siteDir(rec.slug))).rejects.toThrow();
  });

  it("listOwned returns only an account's own live deployments (no cross-account, no anonymous)", async () => {
    const { store } = await freshStore();
    const a1 = await store.create({ hint: "a", bytes: 1, fileCount: 1, now: 0, accountId: "acct_a" });
    const a2 = await store.create({ hint: "a", bytes: 1, fileCount: 1, now: 0, accountId: "acct_a" });
    await store.create({ hint: "b", bytes: 1, fileCount: 1, now: 0, accountId: "acct_b" });
    await store.create({ hint: "anon", bytes: 1, fileCount: 1, now: 0 }); // anonymous (no accountId)
    expect(store.listOwned("acct_a").map((r) => r.slug).sort()).toEqual([a1.slug, a2.slug].sort());
    expect(store.listOwned("acct_b")).toHaveLength(1);
    expect(store.listOwned("acct_none")).toHaveLength(0);
  });

  it("remove with accountId is owner-only — cross-account delete is impossible", async () => {
    const { store } = await freshStore();
    const rec = await store.create({ hint: "x", bytes: 1, fileCount: 1, now: 0, accountId: "acct_a" });
    const denied = await store.remove(rec.id, { accountId: "acct_b" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("not-owner");
    expect(store.get(rec.id)).toBeDefined(); // still there
    const ok = await store.remove(rec.id, { accountId: "acct_a" });
    expect(ok.ok).toBe(true);
    expect(store.get(rec.id)).toBeUndefined();
  });

  it("an account-owned (unclaimed) record can't be tokenlessly deleted via the anonymous path", async () => {
    const { store } = await freshStore();
    const rec = await store.create({ hint: "x", bytes: 1, fileCount: 1, now: 0, accountId: "acct_a" });
    const denied = await store.remove(rec.id, {}); // no accountId, no mgmt token
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("bad-token");
    expect(store.get(rec.id)).toBeDefined();
    // a truly anonymous unclaimed preview, by contrast, stays tokenlessly removable (M1 behaviour)
    const anon = await store.create({ hint: "x", bytes: 1, fileCount: 1, now: 0 });
    expect((await store.remove(anon.id, {})).ok).toBe(true);
  });

  it("sweepExpired removes only past-expiry deployments", async () => {
    const { store } = await freshStore();
    const old = await store.create({ hint: "old", bytes: 1, fileCount: 1, now: 0 });
    const fresh = await store.create({ hint: "new", bytes: 1, fileCount: 1, now: 10 * DEFAULT_TTL_MS });
    const removed = await store.sweepExpired(DEFAULT_TTL_MS + 1);
    expect(removed.map((r) => r.slug)).toContain(old.slug);
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(fresh.id)?.slug).toBe(fresh.slug);
  });

  it("serializes concurrent persists — parallel update/appendEvent/touchActivity never race on the shared temp file", async () => {
    // touchActivity persists fire-and-forget on the request hot path while the
    // scale-to-zero wake persists update() in the same tick; unserialized, both
    // rename the same registry.json.tmp and the loser throws ENOENT — the END
    // CUSTOMER saw a 502 on wake (flaky CI runs on 0.3.0–0.3.2, 2026-07-12…14).
    const { dir, store } = await freshStore();
    const rec = await store.create({ hint: "joey", bytes: 1, fileCount: 1, now: 0, accountId: "acct_1" });
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.update(rec.id, { runtimeStatus: i % 2 ? "running" : "stopped" })),
      ...Array.from({ length: 10 }, (_, i) => store.appendEvent(rec.id, `probe ${i}`, i)),
      store.touchActivity(rec.id, 5),
    ]);
    const reopened = new Store({ dataDir: dir });
    await reopened.init();
    expect(reopened.get(rec.id)).toBeDefined(); // registry survived the burst and is valid JSON
    expect(reopened.get(rec.id)!.events.map((e) => e.message)).toContain("probe 9");
  });
});
