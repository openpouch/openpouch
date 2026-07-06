import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts.js";
import { parseKey } from "../src/auth.js";

const NOW = 1_700_000_000_000;

async function freshStore(verifyTtlMs?: number): Promise<AccountStore> {
  const dir = await mkdtemp(join(tmpdir(), "oprun-acct-"));
  const store = new AccountStore({ dataDir: dir, ...(verifyTtlMs !== undefined ? { verifyTtlMs } : {}) });
  await store.init();
  return store;
}

describe("AccountStore: email signup → verify → key", () => {
  it("creates a pending account, verifies it, and issues a working key", async () => {
    const store = await freshStore();
    const created = await store.createPendingEmail("Joey@Example.COM", NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.account.status).toBe("pending");

    // wrong token rejected
    const bad = await store.verifyEmail(created.account.id, "wrong", NOW);
    expect(bad.ok).toBe(false);

    const verified = await store.verifyEmail(created.account.id, created.token, NOW + 1000);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.account.status).toBe("active");
    expect(verified.account.identities[0]).toEqual({ kind: "email", value: "joey@example.com" });

    const resolved = store.resolveKey(verified.key, NOW + 2000);
    expect(resolved?.account.id).toBe(created.account.id);
  });

  it("rejects a duplicate email and an invalid email", async () => {
    const store = await freshStore();
    const first = await store.createPendingEmail("dup@example.com", NOW);
    expect(first.ok).toBe(true);
    if (first.ok) await store.verifyEmail(first.account.id, first.token, NOW);

    const dup = await store.createPendingEmail("dup@example.com", NOW);
    expect(dup).toEqual({ ok: false, reason: "exists" });

    const bad = await store.createPendingEmail("not-an-email", NOW);
    expect(bad).toEqual({ ok: false, reason: "invalid-email" });
  });

  it("re-signup for a still-pending email refreshes it in place (no duplicate accounts; doubles as resend)", async () => {
    const store = await freshStore();
    const first = await store.createPendingEmail("pending@example.com", NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second signup before verifying → same account, a fresh token (resend), and
    // crucially NOT a second pending account piling up.
    const second = await store.createPendingEmail("pending@example.com", NOW + 5000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.account.id).toBe(first.account.id);
    expect(second.token).not.toBe(first.token);

    // On disk there is exactly ONE account (no duplicate pending pile-up).
    const persisted = JSON.parse(await readFile(join(store.dataDir, "accounts.json"), "utf8")) as {
      accounts: Array<{ pendingEmail?: string }>;
    };
    expect(persisted.accounts.filter((a) => a.pendingEmail === "pending@example.com")).toHaveLength(1);
    expect(persisted.accounts).toHaveLength(1);

    // The refreshed token verifies; the superseded first token no longer does.
    const staleTry = await store.verifyEmail(first.account.id, first.token, NOW + 6000);
    expect(staleTry.ok).toBe(false);
    const ok = await store.verifyEmail(first.account.id, second.token, NOW + 6000);
    expect(ok.ok).toBe(true);
  });

  it("rejects an expired verification token", async () => {
    const store = await freshStore(1000);
    const created = await store.createPendingEmail("slow@example.com", NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const late = await store.verifyEmail(created.account.id, created.token, NOW + 5000);
    expect(late).toEqual({ ok: false, reason: "expired" });
  });
});

describe("AccountStore: GitHub path", () => {
  it("creates an active account on first sign-in and reuses it on the next", async () => {
    const store = await freshStore();
    const first = await store.linkOrCreateGithub(42, "octocat", NOW);
    expect(first.account.status).toBe("active");
    expect(first.account.identities[0]).toEqual({ kind: "github", value: "github:42", label: "octocat" });

    const second = await store.linkOrCreateGithub(42, "octocat", NOW + 1000);
    expect(second.account.id).toBe(first.account.id); // same account
    expect(store.resolveKey(first.key, NOW)?.account.id).toBe(first.account.id);
    expect(store.resolveKey(second.key, NOW)?.account.id).toBe(first.account.id); // both keys valid
  });
});

describe("AccountStore: key lifecycle", () => {
  it("mints additional keys only for active accounts and never leaks the secret", async () => {
    const store = await freshStore();
    const created = await store.createPendingEmail("k@example.com", NOW);
    if (!created.ok) throw new Error("setup");

    // pending account cannot mint
    expect(await store.mintKey(created.account.id, "ci", NOW)).toEqual({ ok: false, reason: "not-active" });

    await store.verifyEmail(created.account.id, created.token, NOW);
    const minted = await store.mintKey(created.account.id, "ci", NOW);
    expect(minted.ok).toBe(true);

    const views = store.listKeys(created.account.id);
    expect(views.length).toBe(2); // default + ci
    const serialized = JSON.stringify(views);
    if (minted.ok) expect(serialized).not.toContain(parseKey(minted.key)!.secret);
    for (const v of views) expect(v.prefix.startsWith("op_live_")).toBe(true);
  });

  it("revokes a key so it no longer authenticates", async () => {
    const store = await freshStore();
    const created = await store.createPendingEmail("r@example.com", NOW);
    if (!created.ok) throw new Error("setup");
    const verified = await store.verifyEmail(created.account.id, created.token, NOW);
    if (!verified.ok) throw new Error("setup");

    const keyId = store.listKeys(created.account.id)[0]!.keyId;
    expect(store.resolveKey(verified.key, NOW)).not.toBeNull();
    await store.revokeKey(created.account.id, keyId);
    expect(store.resolveKey(verified.key, NOW)).toBeNull();
  });

  it("resolveKey rejects malformed keys, suspended accounts, and unknown ids", async () => {
    const store = await freshStore();
    const created = await store.createPendingEmail("s@example.com", NOW);
    if (!created.ok) throw new Error("setup");
    const verified = await store.verifyEmail(created.account.id, created.token, NOW);
    if (!verified.ok) throw new Error("setup");

    expect(store.resolveKey("garbage", NOW)).toBeNull();
    expect(store.resolveKey(undefined, NOW)).toBeNull();
    expect(store.resolveKey(verified.key, NOW)).not.toBeNull();

    await store.setStatus(created.account.id, "suspended");
    expect(store.resolveKey(verified.key, NOW)).toBeNull(); // suspended → denied
  });

  it("updates lastUsedAt on resolve", async () => {
    const store = await freshStore();
    const created = await store.createPendingEmail("u@example.com", NOW);
    if (!created.ok) throw new Error("setup");
    const verified = await store.verifyEmail(created.account.id, created.token, NOW);
    if (!verified.ok) throw new Error("setup");

    expect(store.listKeys(created.account.id)[0]!.lastUsedAt).toBeUndefined();
    store.resolveKey(verified.key, NOW + 9999);
    expect(store.listKeys(created.account.id)[0]!.lastUsedAt).toBe(new Date(NOW + 9999).toISOString());
  });
});

describe("AccountStore: usage + tier", () => {
  it("records deploys and prunes the 24h window", async () => {
    const store = await freshStore();
    const g = await store.linkOrCreateGithub(7, "u7", NOW);
    await store.recordDeploy(g.account.id, NOW - 25 * 3_600_000); // old
    await store.recordDeploy(g.account.id, NOW - 1000); // recent
    expect(store.usageWindows(g.account.id, NOW)).toEqual([NOW - 1000]);
  });

  it("changes tier and status", async () => {
    const store = await freshStore();
    const g = await store.linkOrCreateGithub(8, "u8", NOW);
    expect(g.account.tier).toBe("free");
    await store.setTier(g.account.id, "pro");
    expect(store.getAccount(g.account.id)?.tier).toBe("pro");
  });
});

describe("AccountStore: persistence", () => {
  it("round-trips accounts + keys through disk; the file never holds a raw secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oprun-acct-rt-"));
    const store = new AccountStore({ dataDir: dir });
    await store.init();
    const created = await store.createPendingEmail("persist@example.com", NOW);
    if (!created.ok) throw new Error("setup");
    const verified = await store.verifyEmail(created.account.id, created.token, NOW);
    if (!verified.ok) throw new Error("setup");

    const onDisk = await readFile(join(dir, "accounts.json"), "utf8");
    expect(onDisk).not.toContain(parseKey(verified.key)!.secret);
    expect(onDisk).not.toContain(created.token);

    const reopened = new AccountStore({ dataDir: dir });
    await reopened.init();
    expect(reopened.resolveKey(verified.key, NOW)?.account.id).toBe(created.account.id);
    expect(reopened.findByEmail("persist@example.com")?.id).toBe(created.account.id);
  });
});
