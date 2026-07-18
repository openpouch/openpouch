import type { EnvironmentName } from "@openpouch/core";
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
import { logsSummary, sanitizeLogMessage } from "../summary.js";

export async function logsCommand(
  ctx: CliContext,
  environment: EnvironmentName,
  limit: number,
): Promise<CommandResult> {
  const loaded = await loadManifest(ctx.cwd);
  if (loaded.status === "missing") {
    return errorResult(EXIT.MANIFEST, "env", "no deploy.manifest.json", "Run `openpouch init` first.", "openpouch init");
  }
  if (loaded.status === "invalid") {
    return errorResult(EXIT.MANIFEST, "env", `manifest invalid: ${loaded.errors.join("; ")}`, "Fix deploy.manifest.json.");
  }

  const cfg = loaded.manifest.environments[environment];
  if (cfg === undefined || cfg.serviceId === undefined) {
    return errorResult(
      EXIT.MANIFEST,
      "env",
      `environment "${environment}" is not mapped to a service`,
      `Add environments.${environment}.serviceId to deploy.manifest.json.`,
    );
  }

  const apiKey = await resolveProviderApiKey(ctx.env, cfg.provider);
  if (apiKey === undefined) return missingKeyError(cfg.provider);
  const adapter = makeAdapter(ctx, cfg.provider, apiKey);

  try {
    // Sanitize log messages (ANSI + stray control chars) — build/runtime tools
    // emit them, and they're noise in `--json` output and in relayed text
    // (OpenClaw 2026-06-29; Codex OP-005, 2026-07-13).
    const lines = (await adapter.getLogs(cfg.serviceId, { limit })).map((l) => ({
      ...l,
      message: sanitizeLogMessage(l.message),
    }));
    return summarized(
      EXIT.OK,
      // `requestedLimit` rides along so an agent can tell "short tail = that's all
      // there is" from "my --limit was ignored" (Codex field test 2026-07-06:
      // --limit 120 returning count 25 read as a dropped flag).
      { ok: true, environment, serviceId: cfg.serviceId, count: lines.length, requestedLimit: limit, logs: lines },
      logsSummary(environment, lines.length),
      [
        `openpouch logs — ${environment} (${cfg.serviceId}), ${lines.length} lines:`,
        ...lines.map((l) => `  ${l.timestamp ?? ""} ${l.message}`.trimEnd()),
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
