import { readEvidence, writeEvidence, type EnvironmentName, type Healthcheck } from "@openpouch/core";
import { runSmokeChecks } from "../deploy-engine.js";
import { EXIT, errorResult, loadManifest, summarized, type CliContext, type CommandResult } from "../shared.js";
import { verifySummary } from "../summary.js";

/**
 * Standalone live verification. Appends smoke results to the latest evidence
 * record of the environment (the one documented exception to append-only:
 * smoke results aggregate on the latest record, history is never rewritten).
 *
 * `healthPathOverride` (--health-path) is a one-off extra check; a non-"/" path
 * — from the flag or the manifest healthcheck — is checked IN ADDITION to
 * `GET /`: a full-stack app can serve the shell fine while its API is dead
 * (OpenClaw 2026-07-04), so proving one never silently skips the other.
 */
export async function verifyCommand(ctx: CliContext, environment: EnvironmentName, healthPathOverride?: string): Promise<CommandResult> {
  const loaded = await loadManifest(ctx.cwd);
  if (loaded.status === "missing") {
    return errorResult(EXIT.MANIFEST, "env", "no deploy.manifest.json", "Run `openpouch init` first.", "openpouch init");
  }
  if (loaded.status === "invalid") {
    return errorResult(EXIT.MANIFEST, "env", `manifest invalid: ${loaded.errors.join("; ")}`, "Fix deploy.manifest.json.");
  }
  const manifest = loaded.manifest;

  const cfg = manifest.environments[environment];
  if (cfg === undefined || cfg.url === undefined) {
    return errorResult(
      EXIT.MANIFEST,
      "env",
      `environment "${environment}" has no url in the manifest`,
      `Set environments.${environment}.url in deploy.manifest.json to the live web address to check. Run \`openpouch inspect\` to see the provider's current URL for a mapped service, or deploy first (\`openpouch preview\`/\`prod\`) — a successful deploy records the url.`,
    );
  }

  // Which paths to prove: always `/`; plus the flag's path (wins) or the
  // manifest healthcheck's path when it isn't `/` itself.
  const extra: Healthcheck | undefined =
    healthPathOverride !== undefined
      ? { path: healthPathOverride, expectStatus: 200, timeoutMs: 10_000 }
      : manifest.healthcheck !== undefined && manifest.healthcheck.path !== "/"
        ? manifest.healthcheck
        : undefined;
  const rootCheck: Healthcheck | undefined = extra !== undefined ? undefined : manifest.healthcheck;
  const smoke = [
    ...(await runSmokeChecks(cfg.url, rootCheck)),
    ...(extra !== undefined && extra.path !== "/" ? await runSmokeChecks(cfg.url, extra) : []),
  ];
  const passed = smoke.every((s) => s.passed);

  const evidence = await readEvidence(ctx.cwd);
  const latestIndex = evidence.deployments.findIndex((d) => d.environment === environment);
  let evidenceUpdated = false;
  if (latestIndex >= 0) {
    const latest = evidence.deployments[latestIndex];
    if (latest !== undefined) {
      evidence.deployments[latestIndex] = { ...latest, smoke: [...(latest.smoke ?? []), ...smoke] };
      await writeEvidence(ctx.cwd, evidence);
      evidenceUpdated = true;
    }
  }

  return summarized(
    passed ? EXIT.OK : EXIT.VERIFY_FAILED,
    { ok: passed, environment, url: cfg.url, checks: smoke, evidenceUpdated },
    verifySummary({ environment, url: cfg.url, passed, checks: smoke }),
    [
      `openpouch verify ${passed ? "✓" : "✗"} ${environment} (${cfg.url})`,
      ...smoke.map((s) => `  ${s.passed ? "✓" : "✗"} ${s.name} — ${s.detail ?? ""}`),
      evidenceUpdated ? "  evidence: smoke results appended to latest record" : "  evidence: no deployment record for this environment yet",
    ],
  );
}
