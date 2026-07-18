import type { ActionClass, EnvironmentName } from "@openpouch/core";
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
import { deploySummary } from "../summary.js";

export async function deployCommand(
  ctx: CliContext,
  environment: EnvironmentName,
): Promise<CommandResult> {
  const action: ActionClass = environment === "preview" ? "deploy-preview" : "deploy-production";

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
  const policy = policyLoad.policy;

  const cfg = manifest.environments[environment];
  if (cfg === undefined || cfg.serviceId === undefined) {
    return errorResult(
      EXIT.MANIFEST,
      "env",
      `environment "${environment}" is not mapped to a service`,
      `Add environments.${environment}.serviceId to deploy.manifest.json (or re-run \`openpouch init --force\`).`,
    );
  }

  const gate = await passPolicyGate(
    ctx,
    policy,
    environment,
    action,
    cfg.serviceId,
    `openpouch ${environment === "preview" ? "preview" : "prod"}`,
  );
  if (!gate.ok) return gate.result;
  const approvedBy = gate.approvedBy;
  const approvalId = gate.approvalId;

  const apiKey = await resolveProviderApiKey(ctx.env, cfg.provider);
  if (apiKey === undefined) return missingKeyError(cfg.provider);
  const adapter = makeAdapter(ctx, cfg.provider, apiKey);

  try {
    const result = await runDeploy(ctx.cwd, adapter, manifest, environment, { ...cfg, serviceId: cfg.serviceId }, {
      ...(approvedBy !== undefined ? { approvedBy } : {}),
      ...(approvalId !== undefined ? { approvalId } : {}),
      pollIntervalMs: positiveNumberEnv(ctx.env, "OPENPOUCH_POLL_MS", 5000),
      timeoutMs: positiveNumberEnv(ctx.env, "OPENPOUCH_DEPLOY_TIMEOUT_MS", 600_000),
    });

    const exitCode = !result.deployLive
      ? EXIT.DEPLOY_FAILED
      : result.smokePassed === false
        ? EXIT.VERIFY_FAILED
        : EXIT.OK;

    // R9.5: a live deploy whose env has no url skips the smoke check silently —
    // smokePassed stays null, which an agent can't tell apart from "healthy".
    // Flag it explicitly so "live but unchecked" is distinguishable from "live + healthy".
    const smokeSkipped = result.deployLive && cfg.url === undefined;

    const d = result.record;
    return summarized(
      exitCode,
      {
        ok: exitCode === EXIT.OK,
        // R5: live link prominent at the top level when the deploy went live.
        ...(d.url !== undefined && result.deployLive ? { url: d.url } : {}),
        deployment: d,
        smokePassed: result.smokePassed ?? null,
        ...(smokeSkipped
          ? {
              smokeSkipped: true,
              note: `Deployed live, but health was not checked — this environment has no url in deploy.manifest.json to test against. Add environments.${environment}.url, then run \`openpouch verify\`.`,
            }
          : {}),
        evidence: ["deploy.evidence.json", "DEPLOYMENT.md"],
      },
      deploySummary({
        environment,
        live: result.deployLive,
        url: d.url,
        smokePassed: result.smokePassed,
        approvedBy: d.approvedBy,
      }),
      [
        `openpouch ${environment === "preview" ? "preview" : "prod"} ${exitCode === EXIT.OK ? "✓" : "✗"} ${manifest.project.name} → ${environment}`,
        `  deploy: ${d.id} [${d.status}]${d.commit !== undefined ? ` commit ${d.commit.slice(0, 10)}` : ""}`,
        ...(d.url !== undefined ? [`  url: ${d.url}`] : []),
        ...(result.smokePassed !== undefined ? [`  smoke: ${result.smokePassed ? "passed" : "FAILED"}`] : []),
        ...(smokeSkipped ? [`  smoke: skipped (no url for ${environment}) — add environments.${environment}.url, then \`openpouch verify\``] : []),
        ...(d.approvedBy !== undefined ? [`  approved by: ${d.approvedBy} (request ${approvalId})`] : []),
        ...(d.rollbackAnchor !== undefined ? [`  rollback anchor: ${d.rollbackAnchor}`] : []),
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
