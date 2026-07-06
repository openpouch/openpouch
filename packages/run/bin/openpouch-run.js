#!/usr/bin/env node
// Runs the compiled build (dist/). In the monorepo, build first: npm run build
let mod;
try {
  mod = await import("../dist/index.js");
} catch (err) {
  if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message).includes("dist/index.js")) {
    process.stderr.write("openpouch-run: compiled build not found — run `npm run build` first.\n");
    process.exit(1);
  }
  throw err;
}
await mod.startServer();
