import {
  evaluateAction,
  type ActionClass,
  type EnvironmentName,
  type Manifest,
  type PolicyDecision,
  type ProviderAdapter,
  type ProviderId,
} from "@openpouch/core";
import { computeEnvVarReport } from "../envcheck.js";
import {
  EXIT,
  errorResult,
  isProviderApiError,
  loadManifest,
  loadPolicy,
  makeAdapter,
  resolveProviderApiKey,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { planSummary } from "../summary.js";

interface EnvironmentPlan {
  action: ActionClass;
  decision: PolicyDecision;
  mapped: boolean;
  missingRequired: string[];
  ready: boolean;
  blockers: string[];
  nextSteps: string[];
  /** True for the instant lane (openpouch-run): no "go live" gate — deploy = live. */
  instant: boolean;
}

export async function planCommand(ctx: CliContext): Promise<CommandResult> {
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

  const adapters = new Map<ProviderId, ProviderAdapter | undefined>();
  const adapterFor = async (provider: ProviderId): Promise<ProviderAdapter | undefined> => {
    if (!adapters.has(provider)) {
      const apiKey = await resolveProviderApiKey(ctx.env, provider);
      adapters.set(provider, apiKey === undefined ? undefined : makeAdapter(ctx, provider, apiKey));
    }
    return adapters.get(provider);
  };

  const plans: Record<string, EnvironmentPlan> = {};
  const hints: string[] = [];
  let sawInstant = false;
  if (policyLoad.usedDefault) hints.push("no deploy.policy.json found — using safe defaults (previews autonomous, production gated)");

  try {
    for (const [name, cfg] of Object.entries(manifest.environments) as Array<
      [EnvironmentName, Manifest["environments"][EnvironmentName]]
    >) {
      if (cfg === undefined) continue;
      const action: ActionClass = name === "preview" ? "deploy-preview" : "deploy-production";

      // Instant lane (openpouch-run): no plan/approval/env-var gate — it ships
      // straight to an ephemeral preview URL. `plan`/`preview`/`prod` target
      // bring-your-own Render/Vercel, so point the agent at the right verbs
      // instead of suggesting `openpouch preview` (OpenClaw 2026-06-29, R9).
      if (cfg.provider === "openpouch-run") {
        sawInstant = true;
        plans[name] = {
          action,
          decision: evaluateAction(policy, name, action),
          mapped: cfg.serviceId !== undefined,
          missingRequired: [],
          ready: true,
          blockers: [],
          nextSteps: [
            "publish with `openpouch deploy` (instant lane — autonomous, no approval)",
            "confirm it's reachable with `openpouch verify`",
          ],
          instant: true,
        };
        continue;
      }

      const decision = evaluateAction(policy, name, action);
      const mapped = cfg.serviceId !== undefined;
      const blockers: string[] = [];
      let missingRequired: string[] = [];

      if (!mapped) blockers.push("no serviceId mapped");
      if (decision === "denied") blockers.push(`policy denies ${action}`);
      const adapter = mapped ? await adapterFor(cfg.provider) : undefined;
      if (mapped && adapter !== undefined && cfg.serviceId !== undefined) {
        missingRequired = (await computeEnvVarReport(adapter, manifest, name, cfg.serviceId)).missingRequired;
        if (missingRequired.length > 0) blockers.push(`missing required env vars: ${missingRequired.join(", ")}`);
      } else if (mapped && adapter === undefined) {
        blockers.push(`no ${cfg.provider} API key — env vars unchecked`);
      }

      const deployCmd = name === "preview" ? "openpouch preview" : "openpouch prod";
      const nextSteps =
        blockers.length > 0
          ? blockers.map((b) => `resolve: ${b}`)
          : decision === "requires-approval"
            ? [`run \`${deployCmd}\` (creates an approval request)`, "human approves via `openpouch approve <id>`", `re-run \`${deployCmd}\``]
            : [`run \`${deployCmd}\``];

      plans[name] = { action, decision, mapped, missingRequired, ready: blockers.length === 0, blockers, nextSteps, instant: false };
    }
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }

  if (sawInstant) {
    hints.push(
      "this project deploys via the instant lane (openpouch-run) — use `openpouch deploy` to publish and `openpouch verify` to check it; `plan`/`preview`/`prod` are for bring-your-own Render/Vercel projects",
    );
  }

  const human: string[] = [`openpouch plan — ${manifest.project.name}`];
  for (const [name, p] of Object.entries(plans)) {
    human.push(`  ${name}: ${p.ready ? "READY" : "BLOCKED"} | action ${p.action} → ${p.decision}`);
    for (const b of p.blockers) human.push(`    blocker: ${b}`);
    for (const s of p.nextSteps) human.push(`    next: ${s}`);
  }
  if (Object.keys(plans).length === 0) human.push("  no environments mapped — run `openpouch init --force` or edit the manifest");
  human.push(...hints.map((h) => `  hint: ${h}`));

  return summarized(
    EXIT.OK,
    { ok: true, project: manifest.project.name, environments: plans, hints },
    planSummary(manifest.project.name, plans),
    human,
  );
}
