import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRenderAdapter } from "@openpouch/adapter-render";
import { createRunAdapter } from "@openpouch/adapter-run";
import { createVercelAdapter } from "@openpouch/adapter-vercel";
import {
  MANIFEST_FILENAME,
  POLICY_FILENAME,
  defaultPolicy,
  parseManifest,
  policySchema,
  type EnvironmentName,
  type Manifest,
  type Policy,
  type ProviderAdapter,
  type ProviderId,
} from "@openpouch/core";
import { errorSummary } from "./summary.js";

// Version is injected at bundle time by release/build.mjs (esbuild `define`,
// sourced from release/openpouch/package.json). `typeof` keeps it safe in dev,
// where the identifier is undeclared at runtime → the fallback applies. Lives
// here (not main.ts) so commands can record it without an import cycle.
declare const __OPENPOUCH_VERSION__: string;
export const VERSION = typeof __OPENPOUCH_VERSION__ !== "undefined" ? __OPENPOUCH_VERSION__ : "0.0.0-dev";

/** Outcome of a post-deploy health probe (instant-lane GET / gate). */
export interface HealthProbeResult {
  /** The probe got the expected 200 back. */
  healthy: boolean;
  /** HTTP status observed, if the server responded at all. */
  status?: number;
  /** Short machine detail, e.g. "received 404" or "request failed: …". */
  detail: string;
}

export interface CliContext {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Test seam: replaces the real provider adapters. The key never leaves this boundary. */
  createAdapter?: (provider: ProviderId, apiKey: string) => ProviderAdapter;
  /**
   * Human-interaction seam. Default: real TTY + readline. Agents running in
   * non-TTY harnesses cannot pass this — that is the point of the local gate.
   */
  interactive?: { isTTY: boolean; confirm: (question: string) => Promise<boolean> };
  /**
   * Test seam: probe a freshly-deployed URL's health (instant-lane post-deploy
   * GET / gate). Default: a real fetch via runSmokeChecks. Tests inject a
   * deterministic probe so no network is touched.
   */
  probeUrl?: (url: string) => Promise<HealthProbeResult>;
}

export interface CommandResult {
  exitCode: number;
  /**
   * Machine-readable result (printed verbatim with --json, and the body the MCP
   * server returns). Every result carries a top-level `summary` string (PRD R3):
   * plain-language, jargon-free text the agent can relay to a non-technical
   * human. Build results with `summarized()`/`errorResult()` so it is always set.
   */
  json: Record<string, unknown>;
  /** Human-readable lines (printed without --json). */
  human: string[];
}

/**
 * Build a result with the plain-language `summary` (PRD R3) placed right after
 * `ok` in the JSON and echoed at the end of the human output. Keeping summary
 * generation here means CLI (`--json`), CLI (human), and MCP all carry the same
 * relay-ready text from one source.
 */
export function summarized(
  exitCode: number,
  json: Record<string, unknown> & { ok: boolean },
  summary: string,
  human: string[],
): CommandResult {
  const { ok, ...rest } = json;
  return {
    exitCode,
    json: { ok, summary, ...rest },
    human: [...human, "", summary],
  };
}

/** Exit codes (documented in docs/CLI.md): */
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  MANIFEST: 3,
  AUTH: 4,
  PROVIDER: 5,
  /** Blocked by policy: approval required (pending) or denied outright. */
  POLICY: 6,
  DEPLOY_FAILED: 7,
  VERIFY_FAILED: 8,
} as const;

/** Both adapter error classes (Render/Vercel/run) share this agent-readable shape.
 *  `status` is the HTTP status when the server responded (run adapter sets it) —
 *  optional, so callers can special-case e.g. a 409 conflict. */
export function isProviderApiError(
  e: unknown,
): e is Error & { category: "auth" | "quota" | "provider" | "network"; fix: string; status?: number } {
  return e instanceof Error && "category" in e && "fix" in e;
}

export function errorResult(
  exitCode: number,
  category: string,
  message: string,
  fix: string,
  /**
   * Optional machine-readable next command (R9 agent-legibility). Set this only
   * when there is ONE unambiguous, directly-runnable command that moves the agent
   * forward (e.g. `openpouch init`, `openpouch deploy dist`), so an agent does not
   * have to parse it out of the prose `fix`. Omit it when the fix is an example,
   * has placeholders, or offers several options — the `fix` text stays the guide.
   */
  suggestedCommand?: string,
): CommandResult {
  const summary = errorSummary(category, message, fix);
  return {
    exitCode,
    json: {
      ok: false,
      summary,
      error: {
        category,
        message,
        fix,
        ...(suggestedCommand !== undefined ? { suggestedCommand } : {}),
      },
    },
    human: [`error [${category}]: ${message}`, `fix: ${fix}`, "", summary],
  };
}

export type ManifestLoad =
  | { status: "missing" }
  | { status: "invalid"; errors: string[] }
  | { status: "ok"; manifest: Manifest };

export async function loadManifest(cwd: string): Promise<ManifestLoad> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, MANIFEST_FILENAME), "utf8");
  } catch {
    return { status: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: "invalid", errors: [`${MANIFEST_FILENAME}: not valid JSON (${(e as Error).message})`] };
  }
  const result = parseManifest(parsed);
  return result.ok ? { status: "ok", manifest: result.value } : { status: "invalid", errors: result.errors };
}

/**
 * Pick the target environment for verify/logs/rollback when the user passed no
 * `--env`. Hard-defaulting to "production" broke the instant lane, whose manifest
 * holds only a `preview` environment, so `openpouch logs` after `openpouch deploy`
 * failed with a misleading "add production.serviceId" hint. Order:
 *   1. "production" if present — governed-lane back-compat (unchanged default),
 *   2. else the single mapped environment — the instant lane's lone `preview`,
 *   3. else "preview" if present,
 *   4. else "production" — lets the command surface its own manifest error.
 */
export function resolveDefaultEnvironment(manifest: Manifest): EnvironmentName {
  const names = (Object.keys(manifest.environments) as EnvironmentName[]).filter(
    (n) => manifest.environments[n] !== undefined,
  );
  if (names.includes("production")) return "production";
  if (names.length === 1 && names[0] !== undefined) return names[0];
  if (names.includes("preview")) return "preview";
  return "production";
}

/**
 * Resolve the target environment for verify/logs/rollback — shared by BOTH the CLI
 * (main.ts) and the MCP server, so the smart default can never diverge between
 * surfaces again (R9.8: same behaviour either way). Explicit env → used verbatim;
 * omitted → the manifest's default via resolveDefaultEnvironment().
 */
export async function targetEnvironment(
  cwd: string,
  explicit: EnvironmentName | undefined,
): Promise<EnvironmentName> {
  if (explicit !== undefined) return explicit;
  const loaded = await loadManifest(cwd);
  return loaded.status === "ok" ? resolveDefaultEnvironment(loaded.manifest) : "production";
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export type PolicyLoad =
  | { status: "ok"; policy: Policy; usedDefault: false }
  | { status: "default"; policy: Policy; usedDefault: true }
  | { status: "invalid"; errors: string[] };

/** Missing policy file → safe defaults (previews autonomous, production gated). */
export async function loadPolicy(cwd: string): Promise<PolicyLoad> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, POLICY_FILENAME), "utf8");
  } catch {
    return { status: "default", policy: defaultPolicy(), usedDefault: true };
  }
  try {
    return { status: "ok", policy: policySchema.parse(JSON.parse(raw)), usedDefault: false };
  } catch (e) {
    return { status: "invalid", errors: [`${POLICY_FILENAME}: ${(e as Error).message}`] };
  }
}

const PROVIDER_CREDENTIALS: Partial<Record<ProviderId, { envVar: string; file: string }>> = {
  render: { envVar: "RENDER_API_KEY", file: "render.key" },
  vercel: { envVar: "VERCEL_TOKEN", file: "vercel.token" },
};

/**
 * Sentinel for an anonymous instant-lane call (no openpouch account). Keeps the
 * key-flow uniform: resolveProviderApiKey always returns a string for
 * openpouch-run; makeAdapter sends a Bearer only when it is a real key.
 */
export const ANONYMOUS_KEY = "anonymous";
/** openpouch-run account key (B3): env var, then the key file (runKeyPath). */
const RUN_KEY = { envVar: "OPENPOUCH_API_KEY", file: "openpouch-run.key" } as const;

/**
 * Filesystem location of the openpouch-run account key — the single source of
 * truth shared by the writer (`activate`) and the reader (`resolveRunKey`) so the
 * two can never drift. Resolution order:
 *   1. `OPENPOUCH_KEY_FILE` — an explicit path, honoured by BOTH read and write;
 *      use it to keep the key off the default path.
 *   2. `~/.openpouch/openpouch-run.key` (`OPENPOUCH_HOME` relocates `~`, for tests).
 */
export function runKeyPath(env: Record<string, string | undefined>): string {
  const override = env["OPENPOUCH_KEY_FILE"]?.trim();
  if (override) return override;
  const home = env["OPENPOUCH_HOME"] ?? homedir();
  return join(home, ".openpouch", RUN_KEY.file);
}

/** Resolve the openpouch-run API key from env, then the key file (runKeyPath). */
async function resolveRunKey(env: Record<string, string | undefined>): Promise<string> {
  const fromEnv = env[RUN_KEY.envVar]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = (await readFile(runKeyPath(env), "utf8")).trim();
    if (fromFile.length > 0) return fromFile;
  } catch {
    // no key file — anonymous
  }
  return ANONYMOUS_KEY;
}

/**
 * Key resolution per provider: env var, then ~/.openpouch/<file>.
 * The value is handed to the adapter and never logged or echoed.
 * openpouch-run is optional (PRD R5): an account key lifts you into your tier,
 * otherwise the call is anonymous (ANONYMOUS_KEY sentinel).
 */
export async function resolveProviderApiKey(
  env: Record<string, string | undefined>,
  provider: ProviderId,
): Promise<string | undefined> {
  if (provider === "openpouch-run") return resolveRunKey(env);
  const cred = PROVIDER_CREDENTIALS[provider];
  if (!cred) return undefined;
  const fromEnv = env[cred.envVar]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const home = env["OPENPOUCH_HOME"] ?? homedir();
    const fromFile = (await readFile(join(home, ".openpouch", cred.file), "utf8")).trim();
    return fromFile.length > 0 ? fromFile : undefined;
  } catch {
    return undefined;
  }
}

/** Origin of the instant-lane run-d API (override for self-hosting/tests). */
export function runApiBase(env: Record<string, string | undefined>): string {
  return env["OPENPOUCH_RUN_API"]?.trim() || "https://openpouch.sh";
}

/**
 * Read a positive-number env override (ms), falling back to `fallback` for any
 * unset/non-finite/non-positive value. Guards the deploy poll loop against a
 * garbage value like "5s" → `Number(...)` = NaN → `sleep(NaN)` fires instantly
 * AND `Date.now() > NaN` is never true → an unbounded hot loop hammering the
 * provider API. Mirrors the validation the instant-lane smoke budget already uses.
 */
export function positiveNumberEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

/** Back-compat alias (init's service auto-match is Render-only today). */
export const resolveRenderApiKey = (env: Record<string, string | undefined>) =>
  resolveProviderApiKey(env, "render");

export function missingKeyError(provider: ProviderId): CommandResult {
  const cred = PROVIDER_CREDENTIALS[provider];
  if (!cred) {
    return errorResult(EXIT.AUTH, "auth", `no credentials configured for ${provider}`, "This provider needs no API key.");
  }
  return errorResult(
    EXIT.AUTH,
    "auth",
    `no ${provider} API key found`,
    `Set ${cred.envVar} or write the key to ~/.openpouch/${cred.file} (chmod 600).`,
  );
}

/**
 * Adapter selection by the environment's provider (design rule D13/D2):
 * the manifest decides, not the code. ctx.createAdapter is the test seam.
 */
export function makeAdapter(ctx: CliContext, provider: ProviderId, apiKey: string): ProviderAdapter {
  if (ctx.createAdapter !== undefined) return ctx.createAdapter(provider, apiKey);
  if (provider === "openpouch-run") {
    // A real key lifts the call into the account tier; the sentinel stays anonymous.
    return createRunAdapter({
      apiBase: runApiBase(ctx.env),
      ...(apiKey && apiKey !== ANONYMOUS_KEY ? { apiKey } : {}),
    });
  }
  if (provider === "vercel") {
    const teamId = ctx.env["VERCEL_TEAM_ID"]?.trim();
    return createVercelAdapter({ apiKey, ...(teamId ? { teamId } : {}) });
  }
  return createRenderAdapter({ apiKey });
}
