import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * AGENTS.md writer (design rule D13): `openpouch init` upserts a clearly
 * marked section into the project's AGENTS.md — the cross-harness standard
 * file — so EVERY agent harness discovers the deploy workflow, whether or
 * not it integrates the CLI or MCP. Existing content is never touched;
 * the section is idempotently replaced between its markers.
 */

export const AGENTS_MD_FILENAME = "AGENTS.md";
const START = "<!-- openpouch:start -->";
const END = "<!-- openpouch:end -->";

export function renderAgentsSection(projectName: string): string {
  return [
    START,
    "",
    "## Deploying this project (openpouch 🦘)",
    "",
    `${projectName} deploys via openpouch — an agent-native deployment control plane. This works the same from any agent harness.`,
    "",
    "- **Framework frontends (React/Vite/Next/Svelte…): deploy the _built output_, not the source folder.** Build first, then point deploy at the build directory: `npm run build`, then `openpouch deploy dist` (Vite→`dist/`, CRA→`build/`, Next static export→`out/`). Running `openpouch deploy` in an unbuilt frontend root is refused with the right folder to use; or run `openpouch deploy .` to ship the source and let openpouch build it on deploy (server-side build-on-deploy is live for full-stack + unbuilt SPAs).",
    "- **Deployment truth** (what is live, where, which commit, rollback anchor): read `DEPLOYMENT.md` or `deploy.evidence.json`. Config lives in `deploy.manifest.json`, agent permissions in `deploy.policy.json`.",
    "- **CLI:** `openpouch inspect` · `plan` · `preview` (autonomous if policy allows) · `prod` · `verify` · `logs` · `rollback`. Add `--json` for a single machine-readable JSON object; errors come as `{category, message, fix}` — act on the fix. Exit codes are documented API.",
    "- **Relay the `summary` to your human:** every result (CLI `--json` and MCP) carries a top-level `summary` — plain-language, jargon-free text written for a non-technical operator. Pass it on verbatim: it says what happened, whether the app is live and healthy, the live link, and what (if anything) the human needs to do. The **live URL is the primary result** — on a successful deploy it's the top-level `url` field, ready to share.",
    "- **MCP alternative:** the `openpouch-mcp` stdio server exposes the same capabilities as typed tools (the `summary` is also surfaced as a leading text block to relay).",
    "- **Production rule:** `prod` and `rollback` may return `approvalRequest{id}`. **You cannot approve it — no agent can.** Ask your human to run `openpouch approve <id>` in their own terminal, then re-run the command.",
    "- Never write secret values into any of these files; env vars are tracked by name only.",
    "",
    "### Workflows (run these as sequences, not one-off commands)",
    "",
    "- **Ship a preview (happy path):** for a quick shareable preview, `openpouch deploy` — zero-config, no account or setup, returns a live URL at top-level `url`. For a configured project: `openpouch init` → `openpouch inspect` / `openpouch plan` (see what's deployed and what's ready) → `openpouch preview` → relay the returned `url`.",
    "- **Self-repair loop (the signature move):** after deploying, check the top-level `healthStatus` — `openpouch deploy` probes `GET /` for you, so exit `0` alone isn't \"ready to share\". If it's not `healthy` — `degraded` (container live but the page didn't load, e.g. an unbuilt frontend), `pending` (still starting), or a deploy/`verify` failure — run `openpouch logs` to see why, fix the code or config, then deploy again and `openpouch verify`. For a full-stack app, deploy/verify with `--health-path /api/health` (or your API's health route) so a live shell can't hide a dead backend. Repeat until `healthy`/`verify` passes. Never hand a `degraded`, still-`pending`, or otherwise broken URL to your human.",
    "- **Keep a preview (claim-to-keep):** instant previews are temporary — they vanish after ~72h. To make one permanent, hand your human the `claimUrl` **privately** — it carries a save token that works like a password, so pass it directly (never paste it into a shared report, PR, or chat). It's kept locally in `.openpouch/claim.json` (gitignored), never in `deploy.evidence.json` or the `summary`. The shareable public address is `url`.",
    "- **Deploy to production (human-approved):** `openpouch prod` → if it returns `approvalRequest{id}`, ask your human to run `openpouch approve <id>` in their terminal → re-run `openpouch prod`. Agents cannot approve; there is intentionally no approve path for you.",
    "",
    END,
  ].join("\n");
}

export type AgentsMdResult = "created" | "updated" | "unchanged";

export async function upsertAgentsSection(cwd: string, projectName: string): Promise<AgentsMdResult> {
  const path = join(cwd, AGENTS_MD_FILENAME);
  const section = renderAgentsSection(projectName);

  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    await writeFile(path, `# AGENTS.md\n\n${section}\n`, "utf8");
    return "created";
  }

  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next = existing.slice(0, startIdx) + section + existing.slice(endIdx + END.length);
  } else {
    next = `${existing}${existing.endsWith("\n") ? "" : "\n"}\n${section}\n`;
  }

  if (next === existing) return "unchanged";
  await writeFile(path, next, "utf8");
  return "updated";
}
