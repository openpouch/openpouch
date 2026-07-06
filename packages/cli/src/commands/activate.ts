import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunAdapter } from "@openpouch/adapter-run";
import {
  EXIT,
  errorResult,
  isProviderApiError,
  makeAdapter,
  runKeyPath,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { activateSummary } from "../summary.js";

/** The non-secret public prefix of an op_live_<keyId>_<secret> key. */
function keyPublicPrefix(key: string): string {
  const m = /^(op_live_[0-9a-f]+)_/.exec(key);
  return m ? m[1]! : "op_live_…";
}

/**
 * True only for content we are confident *we* wrote: a single-line
 * op_live_/op_test_ token (optionally with a trailing newline). Everything else
 * — PEM/OpenSSH private keys, arbitrary files, anything multi-line — is foreign
 * and must never be overwritten. An empty file has nothing to lose.
 *
 * The 2026-06-21 incident: `activate` clobbered an SSH private key that happened
 * to sit at the default key path, locking the owner out of the production box.
 * This guard makes that impossible — only our own key shape is ever replaced.
 */
function looksLikeOpenpouchKey(content: string): boolean {
  const t = content.trim();
  if (t.length === 0) return true; // empty/whitespace → nothing to lose
  if (t.includes("\n")) return false; // multi-line → PEM/OpenSSH/etc., never ours
  return /^op_(?:live|test)_[0-9a-f]{6,}_[A-Za-z0-9_-]+$/.test(t);
}

/** Best-effort PEM/OpenSSH private-key sniff — only to phrase the refusal precisely. */
function looksLikePrivateKey(content: string): boolean {
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(content);
}

/**
 * `openpouch activate --account <id> --token <token>` — complete an email
 * signup. Activates the account and saves the issued API key to the protected
 * credential store (~/.openpouch/openpouch-run.key, chmod 600 — or the path from
 * OPENPOUCH_KEY_FILE / --key-file) so future deploys run under the account
 * automatically (PRD R4 — no manual step).
 *
 * Data-loss guard (2026-06-21): the key path is written ONLY when it is absent,
 * empty, or already holds an openpouch key. If anything else is there (e.g. a
 * private key), activate refuses to write rather than overwrite — default-safe
 * and non-interactive (no TTY prompt). A pre-existing openpouch key is backed up
 * to `<path>.bak` (0600) before being replaced.
 *
 * Secret discipline (global rule 7): on a successful save the JSON carries only
 * the non-secret key prefix; the full key goes to the 0600 file, never to stdout
 * or the model context. ONLY when the key could NOT be saved (write failure or
 * the overwrite guard) does the response include the raw key (under `key`) — the
 * verification token is single-use, so otherwise the key would be lost — together
 * with `saved:false` and a `reason`.
 */
export async function activateCommand(
  ctx: CliContext,
  opts: { account?: string | undefined; token?: string | undefined; keyFile?: string | undefined },
): Promise<CommandResult> {
  const account = opts.account?.trim();
  const token = opts.token?.trim();
  if (!account || !token) {
    return errorResult(
      EXIT.USAGE,
      "usage",
      "activate needs --account and --token",
      "Run `openpouch signup --email <you@example.com>` first; the verification email contains both.",
    );
  }

  const adapter = makeAdapter(ctx, "openpouch-run", "anonymous") as Partial<RunAdapter>;
  if (typeof adapter.verifyEmail !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "activation unavailable", "This is an internal wiring error.");
  }
  try {
    const res = await adapter.verifyEmail(account, token);

    // Persist the key to the protected credential store so deploys are keyed —
    // but never at the cost of destroying an existing non-openpouch file.
    let saved = false;
    let reason: string | undefined;
    const keyPath = opts.keyFile?.trim() || runKeyPath(ctx.env);
    try {
      let existing: string | null = null;
      try {
        existing = await readFile(keyPath, "utf8");
      } catch (e) {
        // ENOENT = first run (safe to create). Anything else (unreadable, a
        // directory, …) → do not risk a blind overwrite; rethrow to saved:false.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (existing !== null && existing.trim().length > 0 && !looksLikeOpenpouchKey(existing)) {
        const how = "Set OPENPOUCH_KEY_FILE (or pass --key-file) to a free path, or move that file.";
        reason = looksLikePrivateKey(existing)
          ? `refusing to overwrite ${keyPath} — it looks like an existing private key. ${how}`
          : `refusing to overwrite ${keyPath} — it is not an openpouch key file. ${how}`;
      } else {
        await mkdir(dirname(keyPath), { recursive: true });
        // Replacing one of our own keys → keep the prior key recoverable (0600).
        if (existing !== null && existing.trim().length > 0) {
          await writeFile(`${keyPath}.bak`, existing, { mode: 0o600 });
        }
        await writeFile(keyPath, `${res.key}\n`, { mode: 0o600 });
        saved = true;
      }
    } catch (e) {
      reason = `could not save the key to ${keyPath}: ${(e as Error).message}`;
    }

    return summarized(
      EXIT.OK,
      {
        ok: true,
        account: res.account,
        keyPrefix: keyPublicPrefix(res.key),
        saved,
        ...(saved ? { keyPath } : { reason, key: res.key }),
      },
      activateSummary(saved),
      [
        `openpouch activate ✓ ${res.account.id} [${res.account.tier}]`,
        ...(saved
          ? [`  saved your key to ${keyPath} (chmod 600) — deploys now run under your account`]
          : [`  ⚠ key NOT saved: ${reason}`, `  → use it now:  export OPENPOUCH_API_KEY=${res.key}`]),
        `  key: ${keyPublicPrefix(res.key)}…`,
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
