import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_FILENAME,
  evidenceSchema,
  type DeploymentRecord,
  type Evidence,
} from "./evidence.js";

export const DEPLOYMENT_MD_FILENAME = "DEPLOYMENT.md";

/** Missing file → empty evidence; invalid file → throws (never silently overwrite history). */
export async function readEvidence(dir: string): Promise<Evidence> {
  let raw: string;
  try {
    raw = await readFile(join(dir, EVIDENCE_FILENAME), "utf8");
  } catch {
    return { version: 0, deployments: [] };
  }
  return evidenceSchema.parse(JSON.parse(raw));
}

export async function writeEvidence(dir: string, evidence: Evidence): Promise<void> {
  const validated = evidenceSchema.parse(evidence);
  await writeFile(join(dir, EVIDENCE_FILENAME), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await writeFile(join(dir, DEPLOYMENT_MD_FILENAME), renderDeploymentMd(validated), "utf8");
}

/** Append-only by convention: existing records are never mutated, newest first. */
export async function appendDeployment(dir: string, record: DeploymentRecord): Promise<Evidence> {
  const evidence = await readEvidence(dir);
  const next: Evidence = { version: 0, deployments: [record, ...evidence.deployments] };
  await writeEvidence(dir, next);
  return next;
}

/** Human-readable mirror of the evidence file — written on every update. */
export function renderDeploymentMd(evidence: Evidence): string {
  const lines: string[] = [
    "# DEPLOYMENT — written by openpouch 🦘",
    "",
    "Machine-readable source of truth: `deploy.evidence.json`. Do not edit by hand.",
    "",
  ];

  const latestByEnv = new Map<string, DeploymentRecord>();
  for (const d of evidence.deployments) {
    if (!latestByEnv.has(d.environment)) latestByEnv.set(d.environment, d);
  }

  if (latestByEnv.size === 0) {
    lines.push("_No deployments recorded yet._", "");
  } else {
    lines.push("## Currently live", "");
    lines.push("| Environment | Status | URL | Commit | Deployed at | Expires | Approved by | Rollback anchor |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const [env, d] of latestByEnv) {
      lines.push(
        `| ${env} | ${d.status} | ${d.url ?? "—"} | ${d.commit?.slice(0, 10) ?? "—"} | ${d.deployedAt} | ${d.expiresAt ?? "—"} | ${d.approvedBy ?? "—"} | ${d.rollbackAnchor ?? "—"} |`,
      );
    }
    lines.push("");
    // Deploy context in one place (OpenClaw 2026-07-04): what produced the live
    // state, without digging through manifest + evidence JSON. Only lines whose
    // data exists are emitted — governed-lane records without these fields stay
    // as compact as before.
    const detailLines: string[] = [];
    for (const [env, d] of latestByEnv) {
      const parts: string[] = [];
      if (d.cliVersion !== undefined) parts.push(`- CLI: openpouch ${d.cliVersion}`);
      if (d.kind !== undefined || d.framework !== undefined) {
        parts.push(`- Kind: ${d.kind ?? "—"}${d.framework !== undefined ? ` · Framework: ${d.framework}` : ""}`);
      }
      if (d.buildCommand !== undefined || d.startCommand !== undefined) {
        parts.push(
          `- ${[
            d.buildCommand !== undefined ? `Build: \`${d.buildCommand}\`` : undefined,
            d.startCommand !== undefined ? `Start: \`${d.startCommand}\`` : undefined,
          ]
            .filter((p) => p !== undefined)
            .join(" · ")}`,
        );
      }
      if (d.healthStatus !== undefined || d.healthPath !== undefined) {
        parts.push(
          `- Health at deploy: ${d.healthStatus ?? "—"}${d.healthPath !== undefined ? ` · Health path: ${d.healthPath}` : ""}`,
        );
      }
      if (d.envVarNames !== undefined && d.envVarNames.length > 0) {
        parts.push(`- Env vars (names only — values never recorded): ${d.envVarNames.join(", ")}`);
      }
      if (d.expiresAt !== undefined) parts.push(`- Expires: ${d.expiresAt}`);
      if (parts.length > 0) detailLines.push(`### ${env}`, "", ...parts, "");
    }
    if (detailLines.length > 0) {
      lines.push("## Deploy details (latest per environment)", "", ...detailLines);
    }
    lines.push("## History (newest first)", "");
    for (const d of evidence.deployments) {
      const smoke =
        d.smoke === undefined
          ? ""
          : ` | smoke: ${d.smoke.every((s) => s.passed) ? "passed" : "FAILED"} (${d.smoke.length} checks)`;
      lines.push(
        `- ${d.deployedAt} · **${d.environment}** · ${d.status} · ${d.commit?.slice(0, 10) ?? d.id}${d.approvedBy !== undefined ? ` · approved by ${d.approvedBy}` : ""}${smoke}`,
      );
    }
    lines.push("");
    // Resume-after-context-loss checklist (Hermes 2026-07-02): the re-check
    // commands an agent needs live in the file itself, so it can resume without
    // re-reading external docs. Universal across lanes (instant + governed).
    // When the latest deploy carried a non-root health path, write the EXACT
    // verify command — a fresh agent otherwise checks only `/` and can miss API
    // breakage (OpenClaw 2026-07-05 #3).
    const resumeHealthPath = evidence.deployments.find(
      (d) => d.healthPath !== undefined && d.healthPath !== "/",
    )?.healthPath;
    const verifyCmd = resumeHealthPath !== undefined ? `openpouch verify --json --health-path ${resumeHealthPath}` : "openpouch verify --json";
    lines.push("## Resume after context loss", "");
    lines.push("An agent returning to this project re-establishes state with:", "");
    lines.push("- `openpouch inspect --json` — current deployment status (environment, URL, provider)");
    lines.push(
      resumeHealthPath !== undefined
        ? `- \`${verifyCmd}\` — health-check the live URL (GET / AND GET ${resumeHealthPath}; omitting the flag also works — the manifest healthcheck is applied automatically)`
        : "- `openpouch verify --json` — health-check the live URL (GET / expects 200)",
    );
    lines.push("- `openpouch logs --json` — recent install/build/app output (shows why a deploy is unhealthy)");
    lines.push("");
    lines.push(
      "If this was an instant preview, the private claim link (a save token — treat it like a password) is saved to `.openpouch/claim.json` (mode 0600, gitignored) — never in this file.",
    );
    lines.push("");
    // Self-repair runbook (Hermes 2026-07-04): resume tells an agent where it
    // IS; this tells it what to do when the app is broken — in the file itself.
    lines.push("## If the app is unhealthy (self-repair)", "");
    lines.push("1. `openpouch logs --limit 200 --json` — find the failing phase (lines are tagged `[install]` / `[build]` / `[app]`).");
    lines.push("2. Fix the source or config the logs point at.");
    // Neutral about the path arg: the first deploy may have been `deploy`,
    // `deploy .` or `deploy dist` — a hard-coded `deploy .` here contradicted a
    // bare-`deploy` first run (Codex 2026-07-05).
    lines.push(
      "3. Redeploy — instant lane: rerun the same deploy command you used first (`openpouch deploy [dir] --json`; each redeploy gets a NEW preview URL); governed lane: `openpouch preview`.",
    );
    lines.push(
      resumeHealthPath !== undefined
        ? `4. \`${verifyCmd}\` — proves \`/\` AND the API path, not just the shell.`
        : "4. `openpouch verify --json` — for a full-stack app add `--health-path /api/...` so the API is proven too, not just `/`.",
    );
    lines.push("5. Repeat until it passes. Never share a URL that isn't healthy.");
    lines.push("");
  }
  return lines.join("\n");
}
