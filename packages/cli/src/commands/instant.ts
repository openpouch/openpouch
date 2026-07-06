import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { RunAdapter } from "@openpouch/adapter-run";
import {
  appendDeployment,
  defaultPolicy,
  MANIFEST_FILENAME,
  POLICY_FILENAME,
  type Manifest,
} from "@openpouch/core";
import {
  EXIT,
  VERSION,
  errorResult,
  isProviderApiError,
  loadManifest,
  makeAdapter,
  resolveProviderApiKey,
  summarized,
  writeJsonFile,
  type CliContext,
  type CommandResult,
  type HealthProbeResult,
} from "../shared.js";
import { detectProject } from "../detect.js";
import { dataDurabilityNote, humanList, instantDeploySummary } from "../summary.js";
import { ensureGitignored } from "../approvals.js";

const DEFAULT_INSTANT_SMOKE_BUDGET_MS = 15_000;
const INSTANT_SMOKE_POLL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Default post-deploy health probe: one GET of the EXACT url given (the `/`
 *  gate passes the base url; the --health-path check passes url+path). */
async function defaultProbe(url: string): Promise<HealthProbeResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    return { healthy: response.status === 200, status: response.status, detail: `received ${response.status}` };
  } catch (e) {
    return { healthy: false, detail: `request failed: ${(e as Error).message}` };
  }
}

/** Read the post-deploy smoke budget (ms) from env; 0 disables the check. */
function instantSmokeBudgetMs(env: Record<string, string | undefined>): number {
  const raw = env["OPENPOUCH_INSTANT_SMOKE_TIMEOUT_MS"];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_INSTANT_SMOKE_BUDGET_MS;
}

/**
 * Poll GET / until it returns 200 or the budget elapses. A dynamic container can
 * briefly 502/404 right after the runtime reports "live", so we retry; a route
 * that never comes up (e.g. an unbuilt frontend served by an Express server)
 * stays non-200 and surfaces as degraded.
 */
async function probeInstantHealth(
  probe: (url: string) => Promise<HealthProbeResult>,
  url: string,
  budgetMs: number,
): Promise<{ checked: boolean } & Partial<HealthProbeResult>> {
  if (budgetMs <= 0) return { checked: false };
  const deadline = Date.now() + budgetMs;
  let last = await probe(url);
  while (!last.healthy && Date.now() < deadline) {
    await sleep(Math.min(INSTANT_SMOKE_POLL_MS, Math.max(0, deadline - Date.now())));
    last = await probe(url);
  }
  return { checked: true, ...last };
}

const TAR_EXCLUDES = [
  "./node_modules",
  "./.git",
  "./dist",
  "./build",
  "./.next",
  "./coverage",
  "./.vercel",
  "./.turbo",
  "./.openpouch",
  // openpouch's own deploy artifacts: they belong in the repo, but must not be
  // packed into the upload bundle. A follow-up deploy would otherwise re-ship
  // them (Codex 2026-07-01: file count grew 17 -> 20 on the second deploy).
  "./deploy.manifest.json",
  "./deploy.policy.json",
  "./deploy.evidence.json",
  "./DEPLOYMENT.md",
  // Dotenv files: local SECRETS, never for the wire. A static deploy would
  // otherwise serve them publicly at https://<slug>.openpouch.sh/.env (Caddy
  // doesn't hide dotfiles by default). The sanctioned secret channel is
  // `--var`/`--env-file` (D7: injected as runtime env, values never surfaced),
  // which makes shipping the file itself both redundant and dangerous. The `*`
  // form also covers .env.local / .env.production etc. at the project root.
  "./.env",
  "./.env.*",
];

/**
 * Directories dropped wholesale (build/vcs caches) or holding third-party
 * fixtures — never walked when hunting for dotenv secrets. Mirrors the heavy
 * entries in TAR_EXCLUDES so the walk stays cheap and skips dependency trees.
 */
const DOTENV_WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".vercel",
  ".turbo",
  ".openpouch",
]);

/** A dotenv secret file: `.env` itself, or `.env.<anything>` (.env.local, .env.production, …). */
function isDotenvName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Find every dotenv secret file (`.env`, `.env.*`) at ANY depth under `root`,
 * returned as `./`-relative EXACT tar excludes.
 *
 * Why this exists on top of the `./.env` / `./.env.*` globs in TAR_EXCLUDES:
 * tar's exclude-glob anchoring is implementation-dependent and outside our
 * control (the tarball is built by whatever `tar` sits on the user's machine).
 * Verified 2026-07-02: GNU tar 1.35 does NOT exclude a nested `packages/api/.env`
 * with the `./.env` pattern (bsdtar does) — so on a Linux client a nested dotenv
 * would be packed and then served publicly for a static deploy
 * (`https://<slug>.openpouch.sh/packages/api/.env`), the same class of leak as
 * the root `.env`. An EXACT member path is matched identically by every tar, so
 * emitting one per file makes the secret exclusion implementation-independent.
 * Bounded: never descends into the heavy dirs we already drop.
 */
export async function collectDotenvExcludes(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      return; // unreadable dir — nothing to exclude from here
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!DOTENV_WALK_SKIP.has(e.name)) await walk(rel);
      } else if ((e.isFile() || e.isSymbolicLink()) && isDotenvName(e.name)) {
        out.push(`./${rel}`);
      }
    }
  };
  await walk("");
  return out;
}

/**
 * Gzip the project directory into a buffer (excludes build/vcs/secret files).
 * `extraExcludes` are additional `./`-relative paths to drop — used to exclude
 * the file passed to `--env-file` even when it isn't a standard `.env*` name.
 */
function buildTarball(cwd: string, extraExcludes: string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const excludes = [...TAR_EXCLUDES, ...extraExcludes];
    const args = ["-czf", "-", ...excludes.flatMap((e) => ["--exclude", e]), "-C", cwd, "."];
    const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    tar.stdout.on("data", (c: Buffer) => chunks.push(c));
    tar.stderr.on("data", (c) => (stderr += String(c)));
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/** Run `git <args>` in `cwd`, resolving stdout (trimmed) or undefined on any failure. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (c: Buffer) => (out += String(c)));
    p.on("error", () => resolve(undefined)); // git not installed
    p.on("close", (code) => resolve(code === 0 ? out.trim() : undefined));
  });
}

/**
 * The git commit that honestly describes what we're deploying — or undefined.
 *
 * A bare `git rev-parse HEAD` returns the *nearest ancestor repo's* HEAD even
 * when `cwd` is an UNTRACKED subfolder of that repo. OpenClaw (2026-06-29) hit
 * exactly this: a throwaway test app sitting untracked inside a workspace repo
 * got the workspace's commit written into DEPLOYMENT.md — false audit assurance
 * (the commit has nothing to do with the deployed files). So we only trust HEAD
 * when `cwd` actually contains at least one *tracked* file. An untracked tree
 * returns undefined → DEPLOYMENT.md shows "—", which is the honest answer.
 *
 * A genuinely tracked project still records its commit even without a remote
 * (Hermes P2). Best effort throughout — missing git / non-repo → undefined.
 */
async function gitCommitForDeploy(cwd: string): Promise<string | undefined> {
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) return undefined;
  // HEAD exists — but is THIS directory part of the repo, or an untracked
  // subfolder of an ancestor repo? Require ≥1 tracked file under cwd.
  const tracked = await git(cwd, ["ls-files", "--", "."]);
  return tracked !== undefined && tracked.length > 0 ? sha : undefined;
}

async function projectHint(cwd: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { name?: string };
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
  } catch {
    // no package.json — fall back to the directory name
  }
  return basename(cwd) || "joey";
}

/**
 * Heuristic for the detect-and-surface guard: does `dir` look like an UNBUILT
 * frontend source tree (deploying it as-is serves a dead page)? Signals: an
 * index.html that references a source module (Vite/CRA dev entry), or no
 * index.html but a build script + a src/ dir. Also reports build-output dirs
 * (`dist`/`build`/`out`) sitting alongside, to suggest the right target.
 */
async function unbuiltFrontendHint(dir: string): Promise<{ buildDirs: string[]; isUnbuilt: boolean }> {
  const buildDirs: string[] = [];
  for (const c of ["dist", "build", "out"]) {
    try {
      if ((await stat(join(dir, c))).isDirectory()) buildDirs.push(c);
    } catch {
      // not present
    }
  }
  let pkg: { scripts?: Record<string, string>; main?: string } | undefined;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as typeof pkg;
  } catch {
    pkg = undefined;
  }
  // A SERVER ENTRY (a `start` script, an existing `main`, or a conventional entry
  // file) means this is a dynamic / full-stack app — NOT a dead static tree. run-d
  // runs the server and builds the frontend on deploy, so `openpouch deploy` ships
  // the whole app. Do NOT steer it to `deploy dist`, which would drop the backend
  // (the Express+Vite case OpenClaw hit). Mirror run-d's server-entry precedence so
  // the CLI and the box agree on what "dynamic" means.
  let hasServerEntry = typeof pkg?.scripts?.["start"] === "string";
  if (!hasServerEntry && typeof pkg?.main === "string" && pkg.main.trim() !== "") {
    try {
      hasServerEntry = (await stat(join(dir, pkg.main))).isFile();
    } catch {
      hasServerEntry = false;
    }
  }
  if (!hasServerEntry) {
    for (const f of ["server.js", "app.js", "index.js", "main.js", "server.mjs", "index.mjs", "app.mjs"]) {
      try {
        if ((await stat(join(dir, f))).isFile()) {
          hasServerEntry = true;
          break;
        }
      } catch {
        // not present
      }
    }
  }
  if (hasServerEntry) return { buildDirs, isUnbuilt: false };

  let html: string | undefined;
  try {
    html = await readFile(join(dir, "index.html"), "utf8");
  } catch {
    html = undefined;
  }
  // Signal A: a dev index.html pointing at source modules (e.g. <script src="/src/main.jsx">).
  const devEntry = html !== undefined && (/src=["']\/?src\//.test(html) || /\.(jsx|tsx|ts|vue|svelte)["']/.test(html));
  // Signal B: no index.html at all, but a build script + a src/ directory (unbuilt SPA).
  let noEntrySpa = false;
  if (html === undefined && pkg?.scripts?.["build"]) {
    try {
      noEntrySpa = (await stat(join(dir, "src"))).isDirectory();
    } catch {
      noEntrySpa = false;
    }
  }
  return { buildDirs, isUnbuilt: devEntry || noEntrySpa };
}

/**
 * `openpouch deploy` — the instant lane (D11): zero-config anonymous ephemeral
 * preview on openpouch's own infra. No account, no provider key, no manifest
 * required. The agent deploys (preview-class, autonomous); the human claims via
 * the returned link. Writes the deployment truth back into the repo like any
 * other openpouch deploy.
 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 50;
const MAX_ENV_BYTES = 4096;

/** Parse a dotenv `KEY=value` line — ignores blanks + `#` comments, strips one
 *  layer of surrounding quotes. Returns `[key, value]` or null. */
function parseDotenvLine(line: string): [string, string] | null {
  const t = line.trim();
  if (t === "" || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq <= 0) return null;
  let val = t.slice(eq + 1).trim();
  if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
    val = val.slice(1, -1);
  }
  return [t.slice(0, eq).trim(), val];
}

/**
 * Collect the deployed app's env vars from `--env-file` (dotenv) then `--var K=V`
 * (which override the file). Validates key syntax and a small size cap (DoS guard).
 * Returns the map or an error result. The VALUES are secrets (D7): error messages
 * here name only keys (never values), and the caller keeps values out of
 * output/logs/evidence.
 */
async function collectEnv(
  cwd: string,
  opts: { envFile?: string; vars?: string[] },
): Promise<{ env: Record<string, string> } | { error: CommandResult }> {
  const env: Record<string, string> = {};
  if (opts.envFile !== undefined) {
    let text: string;
    try {
      text = await readFile(resolve(cwd, opts.envFile), "utf8");
    } catch {
      return { error: errorResult(EXIT.USAGE, "usage", `env file not found: ${opts.envFile}`, "Pass an existing dotenv file, e.g. `--env-file .env`.") };
    }
    for (const line of text.split("\n")) {
      const kv = parseDotenvLine(line);
      if (kv) env[kv[0]] = kv[1];
    }
  }
  for (const v of opts.vars ?? []) {
    const eq = v.indexOf("=");
    if (eq <= 0) {
      // Show only the key part (before `=`) — never the value (it may be a secret).
      return { error: errorResult(EXIT.USAGE, "usage", `invalid --var (expected KEY=value): ${eq < 0 ? v : v.slice(0, eq)}`, "Use `--var KEY=value` (the value may be empty).", "openpouch deploy --var KEY=value") };
    }
    env[v.slice(0, eq)] = v.slice(eq + 1);
  }
  const keys = Object.keys(env);
  for (const k of keys) {
    if (!ENV_KEY_RE.test(k)) {
      return { error: errorResult(EXIT.USAGE, "usage", `invalid env var name: ${k}`, "Env var names must be letters/digits/underscore and not start with a digit ([A-Za-z_][A-Za-z0-9_]*).") };
    }
    // PORT/HOME are set by the platform and the runtime DROPS any user value for
    // them (packages/run engine). Accepting them silently would report them as
    // "set" while the app never sees them — reject up front so the agent isn't
    // misled (R9). The app must listen on the injected PORT.
    if (k === "PORT" || k === "HOME") {
      return {
        error: errorResult(
          EXIT.USAGE,
          "usage",
          `reserved env var name: ${k}`,
          "PORT and HOME are set by the platform and can't be overridden — the app must listen on the injected PORT. Remove it from --var/--env-file.",
        ),
      };
    }
  }
  if (keys.length > MAX_ENV_VARS) {
    return { error: errorResult(EXIT.USAGE, "usage", `too many env vars (${keys.length}); the limit is ${MAX_ENV_VARS}`, "Reduce the number of variables.") };
  }
  const bytes = keys.reduce((n, k) => n + k.length + (env[k]?.length ?? 0) + 2, 0);
  if (bytes > MAX_ENV_BYTES) {
    return { error: errorResult(EXIT.USAGE, "usage", `env vars too large (${bytes} bytes; the limit is ${MAX_ENV_BYTES})`, "Env vars are for config/secrets, not data — keep them small.") };
  }
  return { env };
}

/**
 * The claim link carries a save TOKEN — a secret (like a password). It must not
 * land in committed truth (deploy.evidence.json) or relayable text (the summary),
 * where a naive agent could paste it into a public report (Balerion/Claude
 * 2026-07-01). So the token lives only here: .openpouch/claim.json — 0600,
 * gitignored, local runtime state. The evidence just notes it's stored privately.
 */
async function writePrivateClaim(
  cwd: string,
  claim: { slug: string; url: string; claimUrl: string; claimToken: string; expiresAt: string },
): Promise<void> {
  const dir = join(cwd, ".openpouch");
  await mkdir(dir, { recursive: true });
  await ensureGitignored(cwd);
  const body = {
    ...claim,
    note: "Private save link — works like a password. Do not commit it or post it publicly.",
  };
  await writeFile(join(dir, "claim.json"), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

export async function instantCommand(
  ctx: CliContext,
  dir?: string,
  envOpts?: { envFile?: string; vars?: string[]; redactSecrets?: boolean; healthPath?: string },
): Promise<CommandResult> {
  // --health-path (OpenClaw 2026-07-04): a full-stack app can serve `/` while
  // its API is dead. The path is checked after the `/` gate, recorded in the
  // manifest healthcheck (so `openpouch verify` re-checks it) and in evidence.
  const healthPath = envOpts?.healthPath;
  // `--redact-secrets`: leave the claim token OUT of the machine result entirely
  // so an agent can embed the whole JSON in a public report/chat safely (Codex +
  // OpenClaw 2026-07-02). The link is still saved privately to .openpouch/claim.json,
  // so nothing is lost — the human/agent re-reads it there. Default off (the token
  // is already flagged `claimUrlIsPrivate`, but redaction is belt-and-suspenders).
  const redactSecrets = envOpts?.redactSecrets === true;
  // Env vars / secrets for the deployed app (`--var K=V`, `--env-file`). Collected
  // and validated up front; the VALUES are secrets (D7) — from here on only their
  // NAMES ever surface in output/evidence, never the values.
  const collected = await collectEnv(ctx.cwd, envOpts ?? {});
  if ("error" in collected) return collected.error;
  const appEnv = collected.env;
  const envNames = Object.keys(appEnv);

  // Optional target folder: `openpouch deploy dist` ships the built output, so an
  // agent can do `npm run build && npx openpouch deploy dist` in one flow (no cd).
  // An explicit path means the user chose deliberately — it skips the unbuilt
  // guard below (incl. `openpouch deploy .` to force the current folder).
  const explicitDir = dir !== undefined && dir !== "";
  const targetDir = explicitDir ? resolve(ctx.cwd, dir) : ctx.cwd;
  if (explicitDir) {
    try {
      if (!(await stat(targetDir)).isDirectory()) {
        return errorResult(EXIT.USAGE, "usage", `not a directory: ${dir}`, "Pass a folder to deploy, e.g. `openpouch deploy dist`.");
      }
    } catch {
      return errorResult(EXIT.USAGE, "usage", `folder not found: ${dir}`, "Pass an existing folder, e.g. `openpouch deploy dist`.");
    }
  }

  // Guard: only the *governed* lanes (Render/Vercel) own a configured manifest.
  // A manifest that openpouch itself wrote for the instant lane (every env has
  // provider "openpouch-run") must NOT block: agents iterate deploy -> fix ->
  // deploy, and the instant lane has no separate redeploy primitive. So an
  // instant-lane manifest just falls through and redeploys.
  const loaded = await loadManifest(ctx.cwd);
  if (loaded.status === "ok") {
    const envs = Object.values(loaded.manifest.environments ?? {});
    const hasGovernedEnv = envs.some((e) => e.provider !== "openpouch-run");
    if (hasGovernedEnv) {
      return errorResult(
        EXIT.USAGE,
        "usage",
        "this project already has deploy.manifest.json",
        "Use `openpouch preview` / `openpouch prod` for a configured project. `openpouch deploy` is the zero-config instant lane.",
      );
    }
    // else: instant-lane manifest — fall through and redeploy.
  }

  // Detect-and-surface: deploying the current folder (no explicit path) should not
  // silently ship an unbuilt frontend source tree — that yields exit 0 but a dead
  // page (index.html references /src/…, assets 404/410). Point at the build output.
  if (!explicitDir) {
    const { buildDirs, isUnbuilt } = await unbuiltFrontendHint(targetDir);
    if (isUnbuilt) {
      const hasBuild = buildDirs.length > 0;
      const fix = hasBuild
        ? `This looks like an unbuilt frontend. Deploy the build output instead: \`openpouch deploy ${buildDirs[0]}\` — or \`openpouch deploy .\` to ship this folder as-is.`
        : "This looks like an unbuilt frontend (index.html references source modules). Build first, then deploy the build folder: `npm run build`, then `openpouch deploy dist` — or `openpouch deploy .` to ship this folder as-is.";
      // R9: one unambiguous next command — the build output if we found one, else
      // `deploy .` (server-side build-on-deploy ships the source in one command).
      const suggestedCommand = hasBuild ? `openpouch deploy ${buildDirs[0]}` : "openpouch deploy .";
      return errorResult(EXIT.USAGE, "usage", "refusing to deploy what looks like unbuilt frontend source", fix, suggestedCommand);
    }
  }

  // Never ship the file the user pointed `--env-file` at (its VALUES are the
  // secret channel; the file itself must not land in the served tree), even when
  // it has a non-standard name the dotenv excludes wouldn't catch.
  const extraExcludes: string[] = [];
  if (envOpts?.envFile) {
    const rel = relative(targetDir, resolve(ctx.cwd, envOpts.envFile));
    if (rel && !rel.startsWith("..")) extraExcludes.push(`./${rel}`);
  }
  // Exclude dotenv secrets at ANY depth with exact-path excludes — the `./.env*`
  // globs above only anchor at the root on some tar builds (GNU tar leaks a
  // nested `packages/api/.env`), which would be served publicly for a static
  // deploy. See collectDotenvExcludes.
  extraExcludes.push(...(await collectDotenvExcludes(targetDir)));

  // Preflight (OpenClaw suite run 2026-07-05): stop LOCALLY, as a usage error,
  // before spending an upload + a quota slot on input that can never deploy.
  // (1) A present-but-unparseable package.json would otherwise be classified
  //     fail-safe as "static" and shipped as a degraded preview.
  let pkgRaw: string | undefined;
  try {
    pkgRaw = await readFile(join(targetDir, "package.json"), "utf8");
  } catch {
    // absent is fine — plain static site
  }
  if (pkgRaw !== undefined) {
    try {
      JSON.parse(pkgRaw);
    } catch (e) {
      return errorResult(
        EXIT.USAGE,
        "usage",
        `package.json is not valid JSON: ${(e as Error).message}`,
        "Fix the JSON syntax in package.json (or remove the file if this is a plain static site), then rerun the deploy.",
      );
    }
  }
  // (2) An empty folder would otherwise travel to the server just to bounce
  //     with a 400 that used to read like a provider outage. Coarse mirror of
  //     the exclude set — the server 400 (now with a usage-grade fix) stays
  //     the precise backstop.
  if (!(await hasDeployableFile(targetDir))) {
    return errorResult(
      EXIT.USAGE,
      "usage",
      "the directory contains no files to deploy",
      "Point the deploy at a folder with content — an index.html (static site) or a package.json project — e.g. `openpouch deploy dist` or `openpouch deploy .`.",
    );
  }

  let tarball: Buffer;
  try {
    tarball = await buildTarball(targetDir, extraExcludes);
  } catch (e) {
    return errorResult(EXIT.UNEXPECTED, "provider", `could not package the project: ${(e as Error).message}`, "Ensure `tar` is available and the directory is readable.");
  }
  if (tarball.length === 0) {
    return errorResult(EXIT.USAGE, "usage", "nothing to deploy", "The directory appears empty after excludes.");
  }

  const hint = await projectHint(ctx.cwd);
  // Detect the framework + build/start commands from the project root so the
  // recorded truth (and `openpouch inspect`) isn't `framework: null` for a Vite/
  // Next/Express app (Hermes P1). Reuses the same detector as `init`; runs on the
  // project root (ctx.cwd) where package.json lives, even when deploying a subdir.
  const detected = await detectProject(ctx.cwd);
  // Optional: an account key (env/file) lifts the deploy into your tier (B3); no
  // key stays anonymous (PRD R5 — deploying needs no setup). Whether a key
  // resolved is surfaced as `authenticated` in the result (Codex 2026-07-01) so
  // the agent knows it deployed under an account vs. anonymously.
  const resolvedKey = await resolveProviderApiKey(ctx.env, "openpouch-run");
  const authenticated = resolvedKey !== undefined && resolvedKey !== "anonymous";
  const runKey = resolvedKey ?? "anonymous";
  const adapter = makeAdapter(ctx, "openpouch-run", runKey) as Partial<RunAdapter>;
  if (typeof adapter.instantDeploy !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "instant lane adapter unavailable", "This is an internal wiring error.");
  }

  try {
    const result = await adapter.instantDeploy(tarball, {
      projectHint: hint,
      ...(envNames.length > 0 ? { env: appEnv } : {}),
    });

    const hasBuild = detected.buildCommand !== undefined || detected.startCommand !== undefined;
    // Write the deployment truth back into the repo (manifest + policy + evidence).
    const manifest: Manifest = {
      version: 0,
      project: { name: hint, ...(detected.framework !== undefined ? { framework: detected.framework } : {}) },
      ...(hasBuild
        ? {
            build: {
              ...(detected.buildCommand !== undefined ? { buildCommand: detected.buildCommand } : {}),
              ...(detected.startCommand !== undefined ? { startCommand: detected.startCommand } : {}),
            },
          }
        : {}),
      env: [],
      // A custom health path becomes part of the recorded truth so a later
      // `openpouch verify` re-checks it (and any agent reading the manifest
      // knows what "healthy" means for this app).
      ...(healthPath !== undefined ? { healthcheck: { path: healthPath, expectStatus: 200, timeoutMs: 10_000 } } : {}),
      environments: {
        preview: { provider: "openpouch-run", serviceId: result.slug, url: result.url },
      },
    };
    await writeJsonFile(join(ctx.cwd, MANIFEST_FILENAME), manifest);
    await writeJsonFile(join(ctx.cwd, POLICY_FILENAME), defaultPolicy());
    // Record the source commit ONLY when the deploy dir is genuinely tracked in
    // git — captured for a real repo even without a remote (Hermes P2), but NOT
    // for an untracked subfolder of an ancestor repo, where HEAD would be a
    // foreign commit (OpenClaw 2026-06-29: false audit assurance). See gitCommitForDeploy.
    const commit = await gitCommitForDeploy(ctx.cwd);
    // Persist the claim token where it won't be committed or relayed (Fix B).
    await writePrivateClaim(ctx.cwd, {
      slug: result.slug,
      url: result.url,
      claimUrl: result.claimUrl,
      claimToken: result.claimToken,
      expiresAt: result.expiresAt,
    });

    const kind = result.kind ?? "static";
    // Deploy-health gate (P0: "deploy ok ≠ app healthy"). Two distinct failure
    // shapes the agent must not confuse with success:
    //   1. R9.10 — instantDeploy is a single POST; a dynamic app can come back
    //      still `building`/`queued` (container starting) → not reachable yet →
    //      `pending`. We don't probe; it isn't up to probe.
    //   2. P0 — a container reporting `live` only means it started, NOT that
    //      GET / returns 200 (e.g. an Express server handing back an unbuilt
    //      React `dist/` answers 404). So when it's live we probe the URL before
    //      telling the human it's shareable — otherwise an agent relays a dead
    //      link. (Continues the A2/A6 "be honest about health" line.)
    const live = result.status === "live";
    let healthStatus: "pending" | "healthy" | "degraded";
    let nextStep: string | undefined;
    let httpStatus: number | undefined;
    // Result of the extra --health-path probe (only when the flag was given,
    // the app is live, and the `/` gate ran + passed).
    let pathProbe: { path: string; passed: boolean; httpStatus?: number } | undefined;
    if (!live) {
      healthStatus = "pending";
      nextStep = `The app is still starting (${result.status}). Give it a few seconds, then confirm it's reachable with \`openpouch verify\` before sharing the URL.`;
    } else {
      const probe = ctx.probeUrl ?? defaultProbe;
      const health = await probeInstantHealth(probe, result.url, instantSmokeBudgetMs(ctx.env));
      if (!health.checked || health.healthy) {
        // Healthy, or the check was explicitly disabled (budget 0) — don't
        // fabricate a problem we didn't observe.
        healthStatus = "healthy";
        // The shell answers — now hold the app to its own API bar (--health-path).
        // Same probe seam as the `/` gate (tests inject it; no network). Skipped
        // when the post-deploy check is disabled (budget 0): we probe nothing in
        // that mode, so we also claim nothing.
        if (healthPath !== undefined && healthPath !== "/" && health.checked) {
          const pathResult = await probe(new URL(healthPath, result.url).toString());
          pathProbe = {
            path: healthPath,
            passed: pathResult.healthy,
            ...(pathResult.status !== undefined ? { httpStatus: pathResult.status } : {}),
          };
          if (!pathProbe.passed) {
            healthStatus = "degraded";
            httpStatus = pathProbe.httpStatus;
            const what = pathProbe.httpStatus !== undefined ? `returned ${pathProbe.httpStatus}` : "did not respond";
            nextStep = `\`/\` answers, but the health path \`${healthPath}\` ${what} — the app shell is up while its API isn't. Inspect \`openpouch logs\`, fix the backend, redeploy with \`openpouch deploy\`, then \`openpouch verify --health-path ${healthPath}\`. Don't share the URL until it's healthy.`;
          }
        }
      } else {
        healthStatus = "degraded";
        httpStatus = health.status;
        const what = health.status !== undefined ? `returned ${health.status}` : "did not respond";
        nextStep = `The container is live but \`/\` ${what}. Inspect \`openpouch logs\`, fix the app (e.g. build the frontend before \`start\`), redeploy with \`openpouch deploy\`, then \`openpouch verify\`. Don't share the URL until it's healthy.`;
      }
    }

    // Deployment truth → evidence, recorded AFTER the health gate so the record
    // carries the observed health (OpenClaw 2026-07-04: deploy context in one
    // place — CLI version, kind, framework, build/start, health, expiry, env
    // var NAMES; values are secrets and never land here).
    await appendDeployment(ctx.cwd, {
      id: result.slug,
      environment: "preview",
      provider: "openpouch-run",
      status: "live",
      url: result.url,
      deployedAt: new Date().toISOString(),
      ...(commit !== undefined ? { commit } : {}),
      cliVersion: VERSION,
      kind,
      ...(detected.framework !== undefined ? { framework: detected.framework } : {}),
      ...(detected.buildCommand !== undefined ? { buildCommand: detected.buildCommand } : {}),
      ...(detected.startCommand !== undefined ? { startCommand: detected.startCommand } : {}),
      healthStatus,
      expiresAt: result.expiresAt,
      ...(envNames.length > 0 ? { envVarNames: envNames } : {}),
      ...(healthPath !== undefined ? { healthPath } : {}),
      // The claim link is a secret — kept out of committed evidence (Fix B). It's
      // stored privately in .openpouch/claim.json instead.
      notes: `instant preview — expires ${result.expiresAt}; private save link stored in .openpouch/claim.json`,
    });

    // Which path failed the gate — the extra --health-path when it was the culprit, else `/`.
    const failedPath = pathProbe !== undefined && !pathProbe.passed ? pathProbe.path : "/";
    const statusLine =
      healthStatus === "pending"
        ? `  url:     ${result.url}  (status: ${result.status} — still starting)`
        : healthStatus === "degraded"
          ? `  url:     ${result.url}  (container live but ${failedPath} ${httpStatus !== undefined ? `returned ${httpStatus}` : "did not respond"} — verify before sharing)`
          : `  url:     ${result.url}`;
    const noteLines =
      healthStatus === "pending"
        ? [`  note:    still starting — the URL may error for a few seconds; re-check with \`openpouch verify\` before sharing it.`]
        : healthStatus === "degraded"
          ? [`  note:    started but \`${failedPath}\` isn't healthy — check \`openpouch logs\`, fix, redeploy, then \`openpouch verify\`. Don't share the URL yet.`]
          : pathProbe !== undefined
            ? [`  health:  GET ${pathProbe.path} → ${pathProbe.httpStatus ?? "?"} ✓ (extra --health-path check)`]
            : [];

    // Detect-and-surface (L10): an app that writes data locally loses it on this
    // ephemeral preview — say so plainly so nobody is surprised (Render lesson).
    const storesData = detected.dataPersistence.storesData;
    const baseSummary = instantDeploySummary({
      name: hint,
      url: result.url,
      expiresAt: result.expiresAt,
      health: healthStatus,
      ...(httpStatus !== undefined ? { statusCode: httpStatus } : {}),
      ...(redactSecrets ? { claimRedacted: true } : {}),
    });

    return summarized(
      EXIT.OK,
      {
        ok: true,
        // R5: the live link is the primary, immediately shareable result — top-level.
        url: result.url,
        // Did this deploy run under an openpouch account, or anonymously? Mirrors
        // whoami's `authenticated` so the agent can tell from the deploy result
        // alone (Codex 2026-07-01). Derived from key resolution — no secret shown.
        authenticated,
        // The claim link carries a save TOKEN — it's a secret (like a password).
        // Flagged machine-readably so agents don't paste it into public reports/chats
        // (OpenClaw 2026-06-29). The shareable address is `url`, never `claimUrl`.
        // With --redact-secrets it's omitted entirely (still saved to .openpouch/claim.json).
        ...(redactSecrets ? { claimUrlRedacted: true } : { claimUrl: result.claimUrl }),
        claimUrlIsPrivate: true,
        // Env vars set on the app — NAMES ONLY. The values are secrets (D7): they
        // live only in the running container, never in this output/logs/evidence.
        ...(envNames.length > 0 ? { envVars: envNames } : {}),
        // Agent signals: `pending` = not up yet; `healthStatus` = up-but-checked.
        pending: healthStatus === "pending",
        healthStatus,
        // The extra --health-path probe (full-stack API bar), when it ran.
        ...(pathProbe !== undefined ? { healthPathCheck: pathProbe } : {}),
        ...(nextStep !== undefined ? { nextStep } : {}),
        // Copy-paste follow-up commands, health-path aware — agent loops stay
        // mechanical instead of reconstructing flags (OpenClaw 2026-07-05 #4).
        nextCommands: {
          verify: `openpouch verify --json${healthPath !== undefined && healthPath !== "/" ? ` --health-path ${healthPath}` : ""}`,
          logs: "openpouch logs --json --limit 120",
          inspect: "openpouch inspect --json",
        },
        ...(storesData
          ? { dataDurability: { storesData: true, ephemeral: true, signals: detected.dataPersistence.signals } }
          : {}),
        deployment: {
          id: result.slug,
          url: result.url,
          ...(redactSecrets ? {} : { claimUrl: result.claimUrl }),
          expiresAt: result.expiresAt,
          status: result.status,
          kind,
          // Detected project shape (Hermes P1: no more silent `framework: null`).
          framework: detected.framework ?? null,
          ...(detected.buildCommand !== undefined ? { buildCommand: detected.buildCommand } : {}),
          ...(detected.startCommand !== undefined ? { startCommand: detected.startCommand } : {}),
          ...(httpStatus !== undefined ? { httpStatus } : {}),
        },
        evidence: ["deploy.manifest.json", "deploy.policy.json", "deploy.evidence.json", "DEPLOYMENT.md"],
      },
      storesData ? `${baseSummary} ${dataDurabilityNote()}` : baseSummary,
      [
        `openpouch deploy ✓ ${hint} → instant preview${kind === "dynamic" ? " (dynamic app — running in a container)" : ""}`,
        statusLine,
        ...noteLines,
        ...(storesData ? [`  data:    saves data locally (${humanList(detected.dataPersistence.signals)}) — NOT kept on a temporary preview`] : []),
        ...(envNames.length > 0 ? [`  env:     ${envNames.length} variable(s) set — ${humanList(envNames)} (values hidden)`] : []),
        `  expires: ${result.expiresAt} (unclaimed previews vanish after 72h)`,
        redactSecrets
          ? `  claim:   [redacted] — saved privately to .openpouch/claim.json (a save token; treat like a password)`
          : `  claim:   ${result.claimUrl}`,
        `  wrote:   deploy.manifest.json, deploy.policy.json, deploy.evidence.json, DEPLOYMENT.md`,
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      // A bounced empty upload is the caller's input, not a platform outage —
      // usage-grade backstop behind the local preflight above.
      const isNoFiles = (e as { status?: number }).status === 400 && /no files/i.test(e.message);
      const base = errorResult(isNoFiles ? EXIT.USAGE : EXIT.PROVIDER, isNoFiles ? "usage" : e.category, e.message, e.fix);
      // Self-repair needs the CAUSE in hand: a failed dynamic/static-build
      // deploy is removed server-side, so `logs` cannot fetch it afterwards —
      // surface the captured build/startup output right on the error
      // (OpenClaw suite run 2026-07-05, P1).
      const serverLogs = (e as { serverLogs?: string }).serverLogs;
      if (serverLogs === undefined) return base;
      const failureLogs = serverLogs.split("\n").filter((l) => l.trim() !== "").slice(-40);
      const baseJson = base.json as { error: Record<string, unknown> } & Record<string, unknown>;
      return {
        ...base,
        json: { ...baseJson, error: { ...baseJson.error, failureLogs } },
        human: [...base.human, "", "server build/startup output (last lines):", ...failureLogs.map((l) => `  ${l}`)],
      };
    }
    throw e;
  }
}

/** Preflight: does the tree contain at least one file that would actually
 *  travel in the tarball? Coarsely mirrors the exclude set (own artifacts,
 *  dotenv, VCS/tool dirs); depth-capped and stops at the first hit. */
async function hasDeployableFile(root: string): Promise<boolean> {
  const SKIP_DIRS = new Set([".git", ".openpouch", "node_modules"]);
  const SKIP_FILES = new Set([MANIFEST_FILENAME, POLICY_FILENAME, "deploy.evidence.json", "DEPLOYMENT.md", ".DS_Store"]);
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 8) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (await walk(join(dir, entry.name), depth + 1)) return true;
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        if (entry.name === ".env" || entry.name.startsWith(".env.")) continue;
        return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}
