import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { EnvVarRequirement } from "@openpouch/core";

export interface DataPersistence {
  /** True when the app appears to write data to local disk (embedded DB or files). */
  storesData: boolean;
  /** Human-readable signals, e.g. "SQLite database (better-sqlite3)". */
  signals: string[];
}

export interface DetectedProject {
  name: string;
  framework?: string;
  buildCommand?: string;
  startCommand?: string;
  env: EnvVarRequirement[];
  /** Detect-and-surface (PRD L10/D20): local data the app writes is ephemeral on the instant lane. */
  dataPersistence: DataPersistence;
}

/**
 * Dependencies that persist data to LOCAL disk (so it vanishes on an ephemeral
 * redeploy/expiry). Deliberately excludes external-DB clients (pg/mysql/mongoose/
 * redis) — those store data elsewhere and are durable; the L10 concern is *silent
 * local loss*, so flagging them would cry wolf.
 */
const LOCAL_DATA_DEPS: ReadonlyArray<readonly [dep: string, label: string]> = [
  ["better-sqlite3", "SQLite database (better-sqlite3)"],
  ["sqlite3", "SQLite database (sqlite3)"],
  ["sqlite", "SQLite database"],
  ["@databases/sqlite", "SQLite database (@databases/sqlite)"],
  ["lowdb", "lowdb file database"],
  ["nedb", "NeDB file database"],
  ["@seald-io/nedb", "NeDB file database"],
  ["diskdb", "diskDB file database"],
  ["lokijs", "LokiJS (file persistence)"],
  ["node-persist", "node-persist disk store"],
  ["level", "LevelDB store"],
  ["classic-level", "LevelDB store"],
  ["leveldown", "LevelDB store"],
  ["pouchdb", "PouchDB local store"],
  ["pouchdb-node", "PouchDB local store"],
  ["multer", "uploaded files saved to disk (multer)"],
];

/** Source-code signals of local disk writes (medium confidence; deps come first). */
const DATA_SOURCE_PATTERNS: ReadonlyArray<readonly [re: RegExp, label: string]> = [
  [/\bfs\.(?:promises\.)?(?:writeFile|appendFile|createWriteStream)\b/, "writes files to disk (fs)"],
  [/\b(?:writeFileSync|appendFileSync)\s*\(/, "writes files to disk (fs)"],
  [/["'`][^"'`\n]*\.(?:sqlite3?|db)["'`]/, "uses a local database file (.sqlite/.db)"],
  [/\bnew\s+Database\s*\(/, "opens an embedded database"],
];

/** Order matters: meta-frameworks before their building blocks. */
const FRAMEWORK_BY_DEP: ReadonlyArray<readonly [dep: string, framework: string]> = [
  ["next", "nextjs"],
  ["astro", "astro"],
  ["nuxt", "nuxt"],
  ["@sveltejs/kit", "sveltekit"],
  ["@remix-run/node", "remix"],
  ["vite", "vite"],
  ["express", "node"],
  ["fastify", "node"],
  ["hono", "node"],
  ["koa", "node"],
];

const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".vercel", ".turbo"]);

/**
 * Test-only sources are excluded from the scan: an env var only a test reads is
 * not a runtime requirement (field report 2026-07-16 — test-script vars were
 * demanded from the human as required), and a test writing files is no evidence
 * the app persists data. A var the app itself also reads still gets detected.
 */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__mocks__", "cypress"]);

function isTestFile(name: string): boolean {
  const base = name.toLowerCase();
  if (/\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(base)) return true; // server.test.ts, api.spec.js
  if (/^(?:vitest|jest|playwright|cypress)\.(?:config|setup|workspace)\./.test(base)) return true;
  if (/^test[-._]/.test(base) || /[-._]test\.[cm]?[jt]sx?$/.test(base)) return true; // test-webhook.js, api-test.js
  return false;
}
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 6;

/** Vars the platform injects at runtime — detected, but not demanded from the user. */
const PLATFORM_PROVIDED = new Set(["PORT"]);
const IGNORED_VARS = new Set(["NODE_ENV"]);

const ENV_PATTERNS = [/process\.env\.([A-Z][A-Z0-9_]+)/g, /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g];

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const full = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (
          !SKIP_DIRS.has(entry.name) &&
          !TEST_DIRS.has(entry.name.toLowerCase()) &&
          !entry.name.startsWith(".") &&
          current.depth < MAX_DEPTH
        ) {
          stack.push({ dir: full, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !isTestFile(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

/** One source walk feeds both env-var detection and local-data-write detection. */
async function scanSource(root: string): Promise<{ envVars: Set<string>; dataSignals: Set<string> }> {
  const envVars = new Set<string>();
  const dataSignals = new Set<string>();
  for (const file of await collectSourceFiles(root)) {
    let content: string;
    try {
      const buf = await readFile(file);
      if (buf.byteLength > MAX_FILE_BYTES) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    for (const pattern of ENV_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const name = match[1];
        if (name && !IGNORED_VARS.has(name)) envVars.add(name);
      }
    }
    for (const [re, label] of DATA_SOURCE_PATTERNS) {
      if (re.test(content)) dataSignals.add(label);
    }
  }
  return { envVars, dataSignals };
}

export async function detectProject(cwd: string): Promise<DetectedProject> {
  let pkg: {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as typeof pkg;
  } catch {
    // no package.json: still usable (static project)
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  let framework: string | undefined;
  for (const [dep, fw] of FRAMEWORK_BY_DEP) {
    if (deps[dep] !== undefined) {
      framework = fw;
      break;
    }
  }
  if (framework === undefined && pkg.name !== undefined) framework = "node";

  const { envVars, dataSignals } = await scanSource(cwd);

  // Local-data detection (L10): dependencies first (high confidence), then source signals.
  for (const [dep, label] of LOCAL_DATA_DEPS) {
    if (deps[dep] !== undefined) dataSignals.add(label);
  }

  // Prisma with a local SQLite datasource (a very common modern stack): the schema
  // names the provider explicitly → high confidence it's a local file, not a remote DB.
  for (const schemaPath of ["prisma/schema.prisma", "schema.prisma"]) {
    try {
      if (/provider\s*=\s*["']sqlite["']/.test(await readFile(join(cwd, schemaPath), "utf8"))) {
        dataSignals.add("Prisma with a local SQLite database");
        break;
      }
    } catch {
      // no prisma schema there
    }
  }

  // A database file bundled at the project root would be deployed and then lost on
  // the next redeploy — the strongest possible signal (the data is literally here).
  try {
    for (const entry of await readdir(cwd, { withFileTypes: true })) {
      if (entry.isFile() && /\.(sqlite3?|db)$/i.test(entry.name)) {
        dataSignals.add(`a local database file is bundled (${entry.name})`);
        break;
      }
    }
  } catch {
    // unreadable dir
  }

  const env: EnvVarRequirement[] = [...envVars].sort().map((name) => ({
    name,
    required: !PLATFORM_PROVIDED.has(name),
    ...(PLATFORM_PROVIDED.has(name) ? { description: "Injected by the platform at runtime" } : {}),
  }));

  return {
    name: pkg.name ?? basename(cwd),
    framework,
    buildCommand: pkg.scripts?.["build"],
    startCommand: pkg.scripts?.["start"],
    env,
    dataPersistence: { storesData: dataSignals.size > 0, signals: [...dataSignals].sort() },
  };
}
