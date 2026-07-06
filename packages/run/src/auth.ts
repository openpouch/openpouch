import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API-key + token primitives for the account subsystem (B3 / SSOT D16).
 *
 * Design (PRD R8 — agent-first, never a human check):
 *   - The agent's daily-operation credential is an openpouch API key. It is
 *     headless and durable: an agent presents `Authorization: Bearer <key>` and
 *     is lifted into its account's quota tier — no OAuth dance, no CAPTCHA.
 *   - Keys look like `op_live_<keyId>_<secret>`:
 *       · the `op_live_` prefix makes keys greppable for secret scanners,
 *       · `keyId` is fixed-length hex (no `_`) so the secret can be split off
 *         unambiguously and the matching record looked up in O(1),
 *       · `secret` is 32 random bytes (base64url).
 *   - Only the SHA-256 of the secret is ever persisted (see AccountStore). The
 *     raw key is shown to the caller exactly once, at creation. This module
 *     never logs a secret and the public key view exposes only `op_live_<keyId>`.
 *
 * Zero third-party deps (node:crypto only), matching the run-d rule.
 */

/** Stable prefix on every key — greppable, and a fast pre-check before parsing. */
export const KEY_PREFIX = "op_live_";
/** Hex length of the public key id (8 bytes → 16 hex chars). */
const KEY_ID_HEX_LEN = 16;
/** Raw secret entropy in bytes (→ 43 base64url chars). */
const SECRET_BYTES = 32;

export interface GeneratedKey {
  /** The full secret to hand back to the caller exactly once. */
  full: string;
  /** Public, non-secret identifier — stored in the clear, used for lookup + the `op_live_<keyId>` prefix shown to users. */
  keyId: string;
  /** SHA-256 hex of the secret half — the only thing persisted. */
  hashedSecret: string;
}

/** SHA-256 hex of an arbitrary string (secret halves, verification tokens). */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Mint a fresh API key. Returns the full key (show once) + the persistable parts. */
export function generateKey(): GeneratedKey {
  const keyId = randomBytes(KEY_ID_HEX_LEN / 2).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    full: `${KEY_PREFIX}${keyId}_${secret}`,
    keyId,
    hashedSecret: sha256(secret),
  };
}

/** The non-secret display form of a key, safe to log/show (identifies it for revocation). */
export function keyPrefix(keyId: string): string {
  return `${KEY_PREFIX}${keyId}`;
}

export interface ParsedKey {
  keyId: string;
  secret: string;
}

/**
 * Parse a presented key into its id + secret, or null if it is malformed.
 * Strict: requires the prefix, a hex keyId of the exact length, a `_`, and a
 * non-empty secret. Never throws (callers treat null as "unauthenticated").
 */
export function parseKey(presented: string | undefined | null): ParsedKey | null {
  if (typeof presented !== "string" || !presented.startsWith(KEY_PREFIX)) return null;
  const rest = presented.slice(KEY_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep !== KEY_ID_HEX_LEN) return null; // keyId must be exactly KEY_ID_HEX_LEN hex chars
  const keyId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!/^[0-9a-f]+$/.test(keyId) || secret.length === 0) return null;
  return { keyId, secret };
}

/** Extract a bearer credential from an Authorization header value. */
export function parseBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1]!.trim() : null;
}

/** Constant-time check that a presented secret hashes to the stored hash. */
export function verifySecret(presentedSecret: string, hashedSecret: string): boolean {
  const a = Buffer.from(sha256(presentedSecret), "utf8");
  const b = Buffer.from(hashedSecret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A random capability token (email-verification links, etc.). Returned raw to
 * the caller once; persist only `sha256(token)` and compare with `verifyToken`.
 */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time compare of a presented token against a stored SHA-256. */
export function verifyToken(presentedToken: string, hashedToken: string): boolean {
  return verifySecret(presentedToken, hashedToken);
}

/**
 * Constant-time equality of two plaintext strings. Used for capability tokens
 * that are (still) stored in cleartext — claim/mgmt/admin tokens — so a naive
 * `!==` early-exit can't leak a byte-by-byte timing oracle. (Length is not
 * secret here: these tokens are fixed-length.)
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
