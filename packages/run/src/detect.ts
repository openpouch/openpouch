import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

/**
 * Classify an extracted upload as a static site or a dynamic Node app (M2).
 *
 * Static (M1 behaviour): plain files, served by the edge. No code runs.
 * Dynamic: a Node app we build (`npm ci/install --ignore-scripts`) and run in a
 * hardened container. The signal is a `package.json` plus a way to start a
 * server — a `scripts.start`, a `main` entry, or a conventional entry file.
 *
 * Fail-safe: anything ambiguous (no package.json, malformed package.json, no
 * resolvable start) classifies as **static** — we never run foreign code on a
 * guess. The first M2 increment is npm-only and single-process (proposal §5).
 */

export interface DynamicPlan {
  kind: "dynamic";
  /** Shell command run via `sh -c` inside the container to start the app. */
  startCmd: string;
  /**
   * App build command to run after install, before start (build-on-deploy,
   * PRD L9) — set iff package.json has a non-empty `build` script. Absent → no
   * build step (e.g. a plain Node server with nothing to build).
   */
  buildCmd?: string;
  /** package-lock.json / npm-shrinkwrap.json present → `npm ci` is usable. */
  hasLockfile: boolean;
  /** Why this was classified dynamic (surfaced in deploy logs). */
  reason: string;
}

/**
 * An unbuilt **static** SPA (no server): build it, then serve the build output
 * as files (build-on-deploy, PRD L9). Distinct from DynamicPlan — there is no
 * long-lived container; after the build the output dir becomes the served root.
 */
export interface StaticBuildPlan {
  kind: "static-build";
  /** App build command (run under sh -c), e.g. "npm run build". */
  buildCmd: string;
  /** package-lock.json / npm-shrinkwrap.json present → `npm ci` is usable. */
  hasLockfile: boolean;
  /** Build output directories to serve from, first that holds an index.html wins. */
  outputDirs: string[];
}

export type UploadClassification = { kind: "static" } | StaticBuildPlan | DynamicPlan;

/** Conventional server entry files, in precedence order. */
const ENTRY_CANDIDATES = ["server.js", "app.js", "index.js", "main.js", "server.mjs", "index.mjs", "app.mjs"];
/** Conventional build-output directories, in precedence order. */
const OUTPUT_DIR_CANDIDATES = ["dist", "build", "out"];

interface PackageJson {
  scripts?: Record<string, unknown>;
  main?: unknown;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve a package.json `main`-style path, but only if it stays inside dir. */
async function resolveEntry(dir: string, rel: string): Promise<string | undefined> {
  const cleaned = rel.trim();
  if (cleaned.length === 0 || isAbsolute(cleaned)) return undefined;
  const norm = normalize(cleaned);
  if (norm === ".." || norm.startsWith(`..${"/"}`) || norm.startsWith(`..${"\\"}`)) return undefined;
  return (await isFile(join(dir, norm))) ? norm : undefined;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

export async function classifyUpload(dir: string): Promise<UploadClassification> {
  const pkg = await readPackageJson(dir);
  if (!pkg) return { kind: "static" };

  const hasLockfile = (await isFile(join(dir, "package-lock.json"))) || (await isFile(join(dir, "npm-shrinkwrap.json")));

  // A `build` script → run `npm run build` after install (build-on-deploy, L9),
  // so a Vite/Next/etc. server-side app's assets exist before the app starts.
  const buildScript = pkg.scripts?.["build"];
  const build: { buildCmd?: string } =
    typeof buildScript === "string" && buildScript.trim().length > 0 ? { buildCmd: "npm run build" } : {};

  // 1. An explicit start script is the clearest "this is a server" signal.
  const start = pkg.scripts?.["start"];
  if (typeof start === "string" && start.trim().length > 0) {
    return { kind: "dynamic", startCmd: "npm start", ...build, hasLockfile, reason: "scripts.start" };
  }

  // 2. A `main` entry that actually exists in the upload.
  if (typeof pkg.main === "string") {
    const entry = await resolveEntry(dir, pkg.main);
    if (entry) return { kind: "dynamic", startCmd: `node ${entry}`, ...build, hasLockfile, reason: `package.json main → ${entry}` };
  }

  // 3. A conventional entry file at the root.
  for (const candidate of ENTRY_CANDIDATES) {
    if (await isFile(join(dir, candidate))) {
      return { kind: "dynamic", startCmd: `node ${candidate}`, ...build, hasLockfile, reason: `entry file ${candidate}` };
    }
  }

  // 4. No server, but a `build` script + unbuilt-SPA markers → build then serve
  //    the output as files (static build-on-deploy, L9). Vite/CRA/Svelte source.
  if (build.buildCmd !== undefined && (await looksLikeUnbuiltSpa(dir))) {
    return { kind: "static-build", buildCmd: build.buildCmd, hasLockfile, outputDirs: OUTPUT_DIR_CANDIDATES };
  }

  // package.json present but no resolvable server / nothing to build → static files.
  return { kind: "static" };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Heuristic for an unbuilt single-page app (mirrors the CLI's client-side guard):
 * a root `index.html` that references source modules (the Vite/CRA dev entry,
 * e.g. `<script src="/src/main.jsx">`), or — failing that — a `src/` directory.
 * Deploying such a tree as-is serves a dead page; with a build script we build it.
 */
async function looksLikeUnbuiltSpa(dir: string): Promise<boolean> {
  try {
    const html = await readFile(join(dir, "index.html"), "utf8");
    if (/src=["']\/?src\//.test(html) || /\.(jsx|tsx|ts|vue|svelte)["']/.test(html)) return true;
  } catch {
    // no index.html — fall through to the src/ check
  }
  return isDir(join(dir, "src"));
}
