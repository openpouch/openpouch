// Builds the standalone publishable packages:
//  - `openpouch`       — the CLI            → release/openpouch/openpouch.js
//  - `@openpouch/mcp`  — the MCP server     → release/openpouch-mcp/openpouch-mcp.js
// esbuild bundles each entry + its whole graph (core, cli, adapters, the MCP SDK,
// zod) into one dependency-free ESM file, then copies LICENSE/NOTICE alongside.
// The internal @openpouch/* packages are `private`, so they MUST be inlined — npm
// could not resolve them otherwise. Prereq: `npm run build` (per-package dist/ must
// exist — esbuild resolves @openpouch/* via the workspace package exports → dist).
import { build } from "esbuild";
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function buildBundle({ label, entry, outDir, outfile }) {
  // Inject the published version (from the package the user installs) so a bundled
  // `openpouch --version` reports it. Single source of truth = that package.json.
  const { version } = JSON.parse(await readFile(join(outDir, "package.json"), "utf8"));
  const result = await build({
    entryPoints: [join(root, "release", entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: join(outDir, outfile),
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "none",
    define: { __OPENPOUCH_VERSION__: JSON.stringify(version) },
    metafile: true,
  });
  await copyFile(join(root, "LICENSE"), join(outDir, "LICENSE"));
  await copyFile(join(root, "NOTICE"), join(outDir, "NOTICE"));
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`release bundle ready: ${label} → ${outfile} (${(bytes / 1024).toFixed(0)} KB, 0 runtime deps)`);
}

// The CLI — `npx openpouch deploy`.
await buildBundle({
  label: "openpouch (CLI)",
  entry: "entry.mjs",
  outDir: join(root, "release", "openpouch"),
  outfile: "openpouch.js",
});

// The MCP server — `npx @openpouch/mcp`, same graph exposed as stdio MCP tools.
await buildBundle({
  label: "@openpouch/mcp",
  entry: "mcp-entry.mjs",
  outDir: join(root, "release", "openpouch-mcp"),
  outfile: "openpouch-mcp.js",
});
