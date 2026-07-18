import {
  appendDeployment,
  type DeploymentRecord,
  type EnvironmentConfig,
  type EnvironmentName,
  type Healthcheck,
  type Manifest,
  type ProviderAdapter,
  type SmokeCheck,
} from "@openpouch/core";

export interface DeployRunOptions {
  approvedBy?: string;
  approvalId?: string;
  /** Deploy a specific commit (rollback primitive). */
  commitId?: string;
  noteExtra?: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface DeployRunResult {
  record: DeploymentRecord;
  deployLive: boolean;
  smokePassed: boolean | undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TERMINAL = new Set(["live", "failed", "canceled"]);

export async function runSmokeChecks(url: string, healthcheck?: Healthcheck): Promise<SmokeCheck[]> {
  const check: Healthcheck = healthcheck ?? { path: "/", expectStatus: 200, timeoutMs: 10_000 };
  const target = new URL(check.path, url).toString();
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(check.timeoutMs), redirect: "follow" });
    return [
      {
        name: `GET ${check.path} expects ${check.expectStatus}`,
        url: target,
        passed: response.status === check.expectStatus,
        detail: `received ${response.status}`,
      },
    ];
  } catch (e) {
    return [
      {
        name: `GET ${check.path} expects ${check.expectStatus}`,
        url: target,
        passed: false,
        detail: `request failed: ${(e as Error).message}`,
      },
    ];
  }
}

/**
 * The governed deploy pipeline: rollback anchor → trigger → poll to terminal
 * state → smoke → evidence writeback. Policy/approval checks happen BEFORE
 * this function is called (commands/deploy.ts) — the engine only executes.
 */
export async function runDeploy(
  cwd: string,
  adapter: ProviderAdapter,
  manifest: Manifest,
  environment: EnvironmentName,
  cfg: EnvironmentConfig & { serviceId: string },
  opts: DeployRunOptions,
): Promise<DeployRunResult> {
  const prior = await adapter.getRecentDeploys(cfg.serviceId, 5);
  const rollbackAnchor = prior.find((d) => d.status === "live")?.id;

  const triggered = await adapter.triggerDeploy(
    cfg.serviceId,
    opts.commitId !== undefined ? { commitId: opts.commitId } : undefined,
  );

  let current = triggered;
  const deadline = Date.now() + opts.timeoutMs;
  let timedOut = false;
  while (!TERMINAL.has(current.status)) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    await sleep(opts.pollIntervalMs);
    current = await adapter.getDeploy(cfg.serviceId, triggered.id);
  }

  const deployLive = current.status === "live";
  let smoke: SmokeCheck[] | undefined;
  if (deployLive && cfg.url !== undefined) {
    smoke = await runSmokeChecks(cfg.url, manifest.healthcheck);
  }
  const smokePassed = smoke?.every((s) => s.passed);

  const notes = [
    timedOut ? `poll timed out after ${opts.timeoutMs} ms (last status: ${current.status})` : undefined,
    opts.approvalId !== undefined ? `approval ${opts.approvalId}` : undefined,
    opts.noteExtra,
  ]
    .filter((n): n is string => n !== undefined)
    .join("; ");

  const record: DeploymentRecord = {
    id: current.id,
    environment,
    provider: adapter.id,
    status: deployLive ? "live" : "failed",
    ...(cfg.url !== undefined ? { url: cfg.url } : {}),
    ...(current.commit !== undefined ? { commit: current.commit } : {}),
    deployedAt: current.finishedAt ?? (current.createdAt !== "" ? current.createdAt : new Date().toISOString()),
    ...(opts.approvedBy !== undefined ? { approvedBy: opts.approvedBy } : {}),
    ...(smoke !== undefined ? { smoke } : {}),
    ...(rollbackAnchor !== undefined ? { rollbackAnchor } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };

  await appendDeployment(cwd, record);
  return { record, deployLive, smokePassed };
}
