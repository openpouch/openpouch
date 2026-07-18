#!/usr/bin/env node
// Runs the compiled build (dist/). In the monorepo, build first: npm run build
let main;
try {
  main = await import("../dist/main.js");
} catch (err) {
  if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message).includes("dist/main.js")) {
    process.stderr.write("openpouch: compiled build not found — run `npm run build` in the openpouch repo first.\n");
    process.exit(1);
  }
  throw err;
}
const result = await main.run(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
if (result.output.length > 0) {
  process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
}
process.exit(result.exitCode);
