// Bundle entry for the standalone published `openpouch` CLI.
// esbuild bundles this + the whole @openpouch/cli graph (core, adapters, zod)
// into one dependency-free file, so `npx openpouch` works with zero installs.
import { run } from "@openpouch/cli";

const result = await run(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
if (result.output.length > 0) {
  process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
}
process.exit(result.exitCode);
