import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests always run against the TypeScript sources (no build required for
// gate 2). Package exports point at dist/ for the compiled runtime; these
// aliases mirror tsconfig.json "paths".
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@openpouch/core": src("packages/core/src/index.ts"),
      "@openpouch/adapter-render": src("packages/adapter-render/src/index.ts"),
      "@openpouch/adapter-vercel": src("packages/adapter-vercel/src/index.ts"),
      "@openpouch/adapter-run": src("packages/adapter-run/src/index.ts"),
      "@openpouch/cli": src("packages/cli/src/main.ts"),
    },
  },
});
