import { readEvidence, type EnvironmentName, type Manifest, type ProviderAdapter, type ProviderId } from "@openpouch/core";
import { computeEnvVarReport, requiredVarNames } from "../envcheck.js";
import {
  EXIT,
  errorResult,
  isProviderApiError,
  loadManifest,
  makeAdapter,
  missingKeyError,
  resolveProviderApiKey,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { inspectSummary } from "../summary.js";

interface EnvironmentReport {
  provider: string;
  status: "ok" | "unmapped";
  service?: { id: string; name: string; url?: string; branch?: string; runtime?: string; suspended: boolean };
  liveDeploy?: { id: string; status: string; commit?: string; commitMessage?: string; at?: string };
  /**
   * `present`/`missingRequired`/`extraOnProvider` come from manifest × provider
   * API — only when `runtimeIntrospection` is "available". On the instant lane
   * it is "unavailable": `present`/`extraOnProvider` are omitted (an empty list
   * would read as "no env vars" — OpenClaw 2026-07-04 + 2026-07-05 #2) and
   * `missingRequired` is computed from local deploy evidence instead.
   * `deployProvided` are the NAMES passed at deploy time via --var/--env-file.
   */
  envVars?: {
    runtimeIntrospection: "available" | "unavailable";
    present?: string[];
    missingRequired: string[];
    extraOnProvider?: string[];
    deployProvided?: string[];
  };
}

async function reportEnvironment(
  adapter: ProviderAdapter,
  manifest: Manifest,
  environment: EnvironmentName,
  serviceId: string,
): Promise<EnvironmentReport> {
  const service = await adapter.getService(serviceId);
  const deploys = await adapter.getRecentDeploys(serviceId, 5);
  const live = deploys.find((d) => d.status === "live") ?? deploys[0];
  const envReport = await computeEnvVarReport(adapter, manifest, environment, serviceId);

  return {
    provider: adapter.id,
    status: "ok",
    service: {
      id: service.id,
      name: service.name,
      ...(service.url !== undefined ? { url: service.url } : {}),
      ...(service.branch !== undefined ? { branch: service.branch } : {}),
      ...(service.runtime !== undefined ? { runtime: service.runtime } : {}),
      suspended: service.suspended ?? false,
    },
    ...(live !== undefined
      ? {
          liveDeploy: {
            id: live.id,
            status: live.status,
            ...(live.commit !== undefined ? { commit: live.commit } : {}),
            ...(live.commitMessage !== undefined ? { commitMessage: live.commitMessage.split("\n")[0] } : {}),
            ...(live.finishedAt ?? live.createdAt ? { at: live.finishedAt ?? live.createdAt } : {}),
          },
        }
      : {}),
    envVars: envReport,
  };
}

export async function inspectCommand(ctx: CliContext): Promise<CommandResult> {
  const loaded = await loadManifest(ctx.cwd);
  if (loaded.status === "missing") {
    return errorResult(
      EXIT.MANIFEST,
      "env",
      "no deploy.manifest.json in this directory",
      "Run `openpouch init` first.",
      "openpouch init",
    );
  }
  if (loaded.status === "invalid") {
    return errorResult(
      EXIT.MANIFEST,
      "env",
      `manifest invalid: ${loaded.errors.join("; ")}`,
      "Fix the listed fields in deploy.manifest.json (see docs/DATA-MODEL.md).",
    );
  }
  const manifest = loaded.manifest;

  const mapped = (Object.entries(manifest.environments) as Array<
    [EnvironmentName, Manifest["environments"][EnvironmentName]]
  >).filter((entry): entry is [EnvironmentName, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined);

  const environments: Record<string, EnvironmentReport> = {};
  const hints: string[] = [];

  const adapters = new Map<ProviderId, ProviderAdapter>();
  // Local deployment truth: carries the deploy-provided env var NAMES.
  const evidence = await readEvidence(ctx.cwd);

  try {
    for (const [name, cfg] of mapped) {
      if (cfg.serviceId !== undefined) {
        let adapter = adapters.get(cfg.provider);
        if (adapter === undefined) {
          const apiKey = await resolveProviderApiKey(ctx.env, cfg.provider);
          if (apiKey === undefined) return missingKeyError(cfg.provider);
          adapter = makeAdapter(ctx, cfg.provider, apiKey);
          adapters.set(cfg.provider, adapter);
        }
        const report = await reportEnvironment(adapter, manifest, name, cfg.serviceId);
        // Latest evidence record of this environment (newest first): surface the
        // env var names that were provided at deploy time (--var/--env-file).
        const latest = evidence.deployments.find((d) => d.environment === name);
        if (report.envVars !== undefined && latest?.envVarNames !== undefined && latest.envVarNames.length > 0) {
          report.envVars.deployProvided = latest.envVarNames;
        }
        if (report.envVars !== undefined && report.envVars.runtimeIntrospection === "unavailable") {
          // No provider introspection — local deploy evidence is the source of
          // truth: required manifest vars minus the names provided at deploy.
          const provided = latest?.envVarNames ?? [];
          report.envVars.missingRequired = requiredVarNames(manifest, name).filter((n) => !provided.includes(n));
          if (provided.length > 0) {
            hints.push(
              `environment "${name}": ${provided.length} env var(s) were provided at deploy time — the instant lane doesn't expose runtime env vars via the provider API, so "deployProvided" (from deploy.evidence.json) is the source of truth here`,
            );
          }
        }
        environments[name] = report;
      } else {
        environments[name] = { provider: cfg.provider, status: "unmapped" };
        hints.push(`environment "${name}" has no serviceId — add it to deploy.manifest.json`);
      }
    }
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
  if (mapped.length === 0) {
    hints.push("no environments mapped yet — add environments to deploy.manifest.json or re-run `openpouch init --force`");
  }

  const human: string[] = [
    `openpouch inspect — ${manifest.project.name}${manifest.project.framework !== undefined ? ` (${manifest.project.framework})` : ""}`,
  ];
  for (const [name, report] of Object.entries(environments)) {
    if (report.status === "unmapped") {
      human.push(`  ${name} (${report.provider}): unmapped — no serviceId`);
      continue;
    }
    const s = report.service;
    if (s !== undefined) {
      human.push(
        `  ${name} (${report.provider}): ${s.name} ${s.id} | ${s.suspended ? "SUSPENDED" : "active"}${s.url !== undefined ? ` | ${s.url}` : ""}`,
      );
    }
    if (report.liveDeploy !== undefined) {
      const d = report.liveDeploy;
      human.push(
        `    live: ${d.commit?.slice(0, 10) ?? d.id} ${d.commitMessage !== undefined ? `"${d.commitMessage}"` : ""} [${d.status}]${d.at !== undefined ? ` ${d.at}` : ""}`,
      );
    }
    if (report.envVars !== undefined) {
      const ev = report.envVars;
      const missing = ev.missingRequired.length > 0 ? ` | MISSING required: ${ev.missingRequired.join(", ")}` : " | no required vars missing";
      const provided = ev.deployProvided !== undefined ? ` | deploy-provided (--var/--env-file): ${ev.deployProvided.join(", ")}` : "";
      human.push(
        ev.runtimeIntrospection === "unavailable"
          ? `    env: runtime introspection n/a on the instant lane${provided}${missing}`
          : `    env: ${(ev.present ?? []).length} present${missing}${(ev.extraOnProvider ?? []).length > 0 ? ` | not in manifest: ${(ev.extraOnProvider ?? []).join(", ")}` : ""}${provided}`,
      );
    }
  }
  human.push(...hints.map((h) => `  hint: ${h}`));

  // deploy and verify carry the live URL top-level; inspect only had it nested
  // under environments.<env>.service.url — harnesses look top-level first
  // (Hermes 2026-07-05). Primary = production when it has an active service
  // URL, else preview, else any other mapped environment with one.
  const urlOrder = ["production", "preview", ...Object.keys(environments).filter((n) => n !== "production" && n !== "preview")];
  const primaryUrl = urlOrder
    .map((n) => environments[n])
    .find((r) => r !== undefined && r.status === "ok" && r.service?.suspended !== true && r.service?.url !== undefined)
    ?.service?.url;

  return summarized(
    EXIT.OK,
    {
      ok: true,
      ...(primaryUrl !== undefined ? { url: primaryUrl } : {}),
      project: { name: manifest.project.name, framework: manifest.project.framework ?? null },
      environments,
      hints,
    },
    inspectSummary(manifest.project.name, environments),
    human,
  );
}
