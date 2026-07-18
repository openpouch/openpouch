import { readEvidence, type EnvironmentName } from "@openpouch/core";
import { runDeploy } from "../deploy-engine.js";
import { passPolicyGate } from "../gate.js";
import {
  EXIT,
  errorResult,
  isProviderApiError,
  loadManifest,
  loadPolicy,
  makeAdapter,
  missingKeyError,
  positiveNumberEnv,
  resolveProviderApiKey,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { rollbackSummary } from "../summary.js";

/**
 * Rollback = redeploy the commit of the recorded rollback anchor (the deploy
 * that was live before the latest one). Approval-gated like any write action.
 */
export async function rollbackCommand(ctx: CliContext, environment: EnvironmentName): Promise<CommandResult> {
  const loaded = await loadManifest(ctx.cwd);
  if (loaded.status === "missing") {
    return errorResult(EXIT.MANIFEST, "env", "no deploy.manifest.json", "Run `openpouch init` first.", "openpouch init");
  }
  if (loaded.status === "invalid") {
    return errorResult(EXIT.MANIFEST, "env", `manifest invalid: ${loaded.errors.join("; ")}`, "Fix deploy.manifest.json.");
  }
  const manifest = loaded.manifest;

  const policyLoad = await loadPolicy(ctx.cwd);
  if (policyLoad.status === "invalid") {
    return errorResult(EXIT.MANIFEST, "env", `policy invalid: ${policyLoad.errors.join("; ")}`, "Fix deploy.policy.json.");
  }

  const cfg = manifest.environments[environment];
  if (cfg === undefined || cfg.serviceId === undefined) {
    return errorResult(
      EXIT.MANIFEST,
      "env",
      `environment "${environment}" is not mapped to a service`,
      `Add environments.${environment}.serviceId to deploy.manifest.json.`,
    );
  }

  const evidence = await readEvidence(ctx.cwd);
  const latest = evidence.deployments.find((d) => d.environment === environment);
  if (latest === undefined || latest.rollbackAnchor === undefined) {
    // R9.2: the instant lane (openpouch-run) never records a rollback anchor —
    // each `openpouch deploy` ships a fresh ephemeral preview, not a versioned
    // release, so there is no prior version to restore. The generic "no anchor"
    // fix implies a reachable state that doesn't exist for instant; tell the
    // truth and point at the move that actually works (redeploy).
    if (cfg.provider === "openpouch-run") {
      return errorResult(
        EXIT.MANIFEST,
        "env",
        "instant-lane previews can't be rolled back",
        "The instant lane ships fresh ephemeral previews, not versioned releases — there's no earlier version to restore. Fix the issue, then ship a new one with `openpouch deploy`.",
      );
    }
    return errorResult(
      EXIT.MANIFEST,
      "env",
      `no rollback anchor recorded for ${environment}`,
      "Rollback needs a prior openpouch deploy with a recorded anchor (deploy.evidence.json).",
    );
  }

  const gate = await passPolicyGate(ctx, policyLoad.policy, environment, "rollback", cfg.serviceId, "openpouch rollback");
  if (!gate.ok) return gate.result;

  const apiKey = await resolveProviderApiKey(ctx.env, cfg.provider);
  if (apiKey === undefined) return missingKeyError(cfg.provider);
  const adapter = makeAdapter(ctx, cfg.provider, apiKey);

  try {
    const anchorDeploy = await adapter.getDeploy(cfg.serviceId, latest.rollbackAnchor);
    if (anchorDeploy.commit === undefined) {
      return errorResult(
        EXIT.PROVIDER,
        "provider",
        `rollback anchor ${latest.rollbackAnchor} has no commit on the provider`,
        "Roll back via the provider dashboard; openpouch can only redeploy commit-based anchors.",
      );
    }

    const result = await runDeploy(ctx.cwd, adapter, manifest, environment, { ...cfg, serviceId: cfg.serviceId }, {
      ...(gate.approvedBy !== undefined ? { approvedBy: gate.approvedBy } : {}),
      ...(gate.approvalId !== undefined ? { approvalId: gate.approvalId } : {}),
      commitId: anchorDeploy.commit,
      noteExtra: `rollback to ${anchorDeploy.commit.slice(0, 10)} (anchor ${latest.rollbackAnchor}, superseding ${latest.id})`,
      pollIntervalMs: positiveNumberEnv(ctx.env, "OPENPOUCH_POLL_MS", 5000),
      timeoutMs: positiveNumberEnv(ctx.env, "OPENPOUCH_DEPLOY_TIMEOUT_MS", 600_000),
    });

    const exitCode = !result.deployLive ? EXIT.DEPLOY_FAILED : result.smokePassed === false ? EXIT.VERIFY_FAILED : EXIT.OK;
    const d = result.record;
    return summarized(
      exitCode,
      {
        ok: exitCode === EXIT.OK,
        ...(d.url !== undefined && result.deployLive ? { url: d.url } : {}),
        rolledBackTo: { commit: anchorDeploy.commit, anchorDeploy: latest.rollbackAnchor },
        deployment: d,
        smokePassed: result.smokePassed ?? null,
      },
      rollbackSummary({ environment, live: result.deployLive, url: d.url, smokePassed: result.smokePassed }),
      [
        `openpouch rollback ${exitCode === EXIT.OK ? "✓" : "✗"} ${environment} → commit ${anchorDeploy.commit.slice(0, 10)}`,
        `  deploy: ${d.id} [${d.status}]`,
        ...(result.smokePassed !== undefined ? [`  smoke: ${result.smokePassed ? "passed" : "FAILED"}`] : []),
        ...(d.approvedBy !== undefined ? [`  approved by: ${d.approvedBy}`] : []),
        `  evidence: deploy.evidence.json + DEPLOYMENT.md updated`,
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
