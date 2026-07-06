import { join } from "node:path";
import {
  MANIFEST_FILENAME,
  POLICY_FILENAME,
  defaultPolicy,
  parseManifest,
  type Manifest,
  type ServiceSummary,
} from "@openpouch/core";
import { AGENTS_MD_FILENAME, upsertAgentsSection } from "../agentsmd.js";
import { detectProject } from "../detect.js";
import {
  EXIT,
  errorResult,
  loadManifest,
  makeAdapter,
  resolveRenderApiKey,
  summarized,
  writeJsonFile,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { initSummary } from "../summary.js";

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function matchService(projectName: string, services: ServiceSummary[]): ServiceSummary | undefined {
  const target = normalize(projectName);
  if (target.length === 0) return undefined;
  const exact = services.filter((s) => normalize(s.name) === target);
  if (exact.length === 1) return exact[0];
  const partial = services.filter((s) => {
    const n = normalize(s.name);
    return n.includes(target) || target.includes(n);
  });
  return partial.length === 1 ? partial[0] : undefined;
}

export async function initCommand(
  ctx: CliContext,
  flags: { force: boolean },
): Promise<CommandResult> {
  const existing = await loadManifest(ctx.cwd);
  if (existing.status !== "missing" && !flags.force) {
    // Still refresh the cross-harness discovery section (idempotent).
    const existingName = existing.status === "ok" ? existing.manifest.project.name : "this project";
    const agentsMd =
      existing.status === "ok" ? await upsertAgentsSection(ctx.cwd, existing.manifest.project.name) : "unchanged";
    return summarized(
      EXIT.OK,
      {
        ok: true,
        alreadyInitialized: true,
        agentsMd,
        hints: [`${MANIFEST_FILENAME} exists — use --force to regenerate, or run \`openpouch inspect\``],
      },
      initSummary({ name: existingName, alreadyInitialized: true }),
      [
        `openpouch init: already initialized (${MANIFEST_FILENAME} exists)`,
        ...(agentsMd !== "unchanged" ? [`  ${AGENTS_MD_FILENAME}: openpouch section ${agentsMd}`] : []),
        "hint: use --force to regenerate, or run `openpouch inspect`",
      ],
    );
  }

  const detected = await detectProject(ctx.cwd);
  const hints: string[] = [];

  const manifest: Manifest = {
    version: 0,
    project: {
      name: detected.name,
      ...(detected.framework !== undefined ? { framework: detected.framework } : {}),
    },
    ...(detected.buildCommand !== undefined || detected.startCommand !== undefined
      ? {
          build: {
            ...(detected.buildCommand !== undefined ? { buildCommand: detected.buildCommand } : {}),
            ...(detected.startCommand !== undefined ? { startCommand: detected.startCommand } : {}),
          },
        }
      : {}),
    env: detected.env,
    environments: {},
  };

  // Best-effort provider match: failures must never block local init.
  let matched: ServiceSummary | undefined;
  const apiKey = await resolveRenderApiKey(ctx.env);
  if (apiKey === undefined) {
    hints.push(
      "no Render API key found (RENDER_API_KEY or ~/.openpouch/render.key) — environments left unmapped",
    );
  } else {
    try {
      // Auto-match is Render-only today (the dogfood provider); Vercel matching lands with task #9 follow-ups.
      const adapter = makeAdapter(ctx, "render", apiKey);
      matched = matchService(detected.name, await adapter.listServices());
      if (matched !== undefined) {
        manifest.environments["production"] = {
          provider: "render",
          serviceId: matched.id,
          ...(matched.url !== undefined ? { url: matched.url } : {}),
          ...(matched.branch !== undefined ? { branch: matched.branch } : {}),
        };
      } else {
        hints.push("no unique Render service matched the project name — map environments manually in the manifest");
      }
    } catch (e) {
      hints.push(`provider match skipped (${(e as Error).message})`);
    }
  }

  // Self-check with our own schema before touching disk.
  const validated = parseManifest(JSON.parse(JSON.stringify(manifest)));
  if (!validated.ok) {
    return errorResult(
      EXIT.UNEXPECTED,
      "internal",
      `generated manifest failed self-validation: ${validated.errors.join("; ")}`,
      "This is an openpouch bug — please report it.",
    );
  }

  await writeJsonFile(join(ctx.cwd, MANIFEST_FILENAME), validated.value);
  await writeJsonFile(join(ctx.cwd, POLICY_FILENAME), defaultPolicy());
  const agentsMd = await upsertAgentsSection(ctx.cwd, detected.name);
  hints.push("policy default: previews autonomous, production requires approval — edit deploy.policy.json to change");
  // Detect-and-surface (L10): flag local data writes so an agent knows previews don't keep them.
  if (detected.dataPersistence.storesData) {
    hints.push(
      `this app appears to store data locally (${detected.dataPersistence.signals.join("; ")}); that data is not kept on an ephemeral preview — it's cleared on redeploy/expiry`,
    );
  }

  return summarized(
    EXIT.OK,
    {
      ok: true,
      created: [MANIFEST_FILENAME, POLICY_FILENAME],
      detected: {
        name: detected.name,
        framework: detected.framework ?? null,
        buildCommand: detected.buildCommand ?? null,
        startCommand: detected.startCommand ?? null,
        envVars: detected.env.map((e) => e.name),
        dataPersistence: detected.dataPersistence,
      },
      production: matched !== undefined ? { serviceId: matched.id, url: matched.url ?? null } : null,
      agentsMd,
      hints,
    },
    initSummary({
      name: detected.name,
      framework: detected.framework,
      ...(matched !== undefined ? { matchedProvider: "render" } : {}),
    }),
    [
      `openpouch init ✓ ${detected.name}${detected.framework !== undefined ? ` (${detected.framework})` : ""}`,
      `  created: ${MANIFEST_FILENAME}, ${POLICY_FILENAME}`,
      `  ${AGENTS_MD_FILENAME}: openpouch section ${agentsMd} (cross-harness discovery)`,
      ...(detected.buildCommand !== undefined ? [`  build: ${detected.buildCommand}`] : []),
      ...(detected.startCommand !== undefined ? [`  start: ${detected.startCommand}`] : []),
      `  env vars detected: ${detected.env.length}${detected.env.length > 0 ? ` (${detected.env.map((e) => e.name).join(", ")})` : ""}`,
      ...(matched !== undefined ? [`  production → render service ${matched.name} (${matched.id})`] : []),
      ...hints.map((h) => `  hint: ${h}`),
      "  next: openpouch inspect",
    ],
  );
}
