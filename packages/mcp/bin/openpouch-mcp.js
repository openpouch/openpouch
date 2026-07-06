#!/usr/bin/env node
// Runs the compiled build (dist/). In the monorepo, build first: npm run build
// stdio transport: works with every MCP client — Claude Code, OpenClaw,
// Codex, Cursor, Hermes, … (harness neutrality is a design rule, D13).
let server;
try {
  server = await import("../dist/server.js");
} catch (err) {
  if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message).includes("dist/server.js")) {
    process.stderr.write("openpouch-mcp: compiled build not found — run `npm run build` in the openpouch repo first.\n");
    process.exit(1);
  }
  throw err;
}
await server.startStdioServer();
