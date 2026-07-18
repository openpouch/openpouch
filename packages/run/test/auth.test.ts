import { describe, expect, it } from "vitest";
import {
  KEY_PREFIX,
  generateKey,
  keyPrefix,
  parseBearer,
  parseKey,
  randomToken,
  sha256,
  verifySecret,
  verifyToken,
} from "../src/auth.js";

describe("auth: key generation + format", () => {
  it("mints a parseable key whose secret hashes to the stored hash", () => {
    const k = generateKey();
    expect(k.full.startsWith(KEY_PREFIX)).toBe(true);
    const parsed = parseKey(k.full);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe(k.keyId);
    expect(verifySecret(parsed!.secret, k.hashedSecret)).toBe(true);
  });

  it("never persists the raw secret — only its sha256", () => {
    const k = generateKey();
    const parsed = parseKey(k.full)!;
    expect(k.hashedSecret).toBe(sha256(parsed.secret));
    expect(k.hashedSecret).not.toContain(parsed.secret);
    expect(k.hashedSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates distinct keyIds + secrets across calls", () => {
    const ids = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = generateKey();
      ids.add(k.keyId);
      secrets.add(parseKey(k.full)!.secret);
    }
    expect(ids.size).toBe(200);
    expect(secrets.size).toBe(200);
  });

  it("keyPrefix shows only the public id, not the secret", () => {
    const k = generateKey();
    expect(keyPrefix(k.keyId)).toBe(`${KEY_PREFIX}${k.keyId}`);
    expect(k.full.startsWith(keyPrefix(k.keyId))).toBe(true);
  });
});

describe("auth: parseKey rejects malformed input", () => {
  it.each([
    ["empty", ""],
    ["no prefix", "live_abc_secret"],
    ["wrong prefix", "op_test_0123456789abcdef_secret"],
    ["missing separator", "op_live_0123456789abcdef"],
    ["short keyId", "op_live_0123_secret"],
    ["long keyId", "op_live_0123456789abcdef00_secret"],
    ["non-hex keyId", "op_live_zzzzzzzzzzzzzzzz_secret"],
    ["empty secret", "op_live_0123456789abcdef_"],
  ])("rejects %s", (_label, input) => {
    expect(parseKey(input)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseKey(undefined)).toBeNull();
    expect(parseKey(null)).toBeNull();
  });
});

describe("auth: parseBearer", () => {
  it("extracts the credential from a Bearer header (case-insensitive)", () => {
    expect(parseBearer("Bearer op_live_x")).toBe("op_live_x");
    expect(parseBearer("bearer   op_live_y")).toBe("op_live_y");
  });

  it("handles header arrays + rejects non-bearer", () => {
    expect(parseBearer(["Bearer zzz"])).toBe("zzz");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
  });
});

describe("auth: secret + token verification", () => {
  it("verifySecret accepts the right secret and rejects wrong ones", () => {
    const k = generateKey();
    const secret = parseKey(k.full)!.secret;
    expect(verifySecret(secret, k.hashedSecret)).toBe(true);
    expect(verifySecret(`${secret}x`, k.hashedSecret)).toBe(false);
    expect(verifySecret("", k.hashedSecret)).toBe(false);
  });

  it("verifyToken round-trips a random token via its stored hash", () => {
    const t = randomToken();
    const stored = sha256(t);
    expect(verifyToken(t, stored)).toBe(true);
    expect(verifyToken(`${t}tampered`, stored)).toBe(false);
    expect(randomToken()).not.toBe(t);
  });
});
