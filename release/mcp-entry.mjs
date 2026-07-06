// Bundle entry for the standalone published `@openpouch/mcp` server.
// esbuild bundles this + the whole @openpouch/mcp graph (cli, core, the MCP SDK,
// zod) into one dependency-free ESM file, so `npx @openpouch/mcp` — or a harness
// MCP config pointing at it — works with zero installs. The internal @openpouch/*
// packages are `private`, so they MUST be inlined here (npm can't resolve them).
import { startStdioServer } from "@openpouch/mcp";

await startStdioServer();
