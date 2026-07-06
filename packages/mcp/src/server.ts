import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  approveCommand,
  deleteCommand,
  deployCommand,
  initCommand,
  inspectCommand,
  instantCommand,
  isProviderApiError,
  listCommand,
  logsCommand,
  planCommand,
  rollbackCommand,
  targetEnvironment,
  verifyCommand,
  whoamiCommand,
  VERSION,
  EXIT,
  errorResult,
  type CliContext,
  type CommandResult,
} from "@openpouch/cli";

/**
 * openpouch MCP server — the same governed capabilities as the CLI, as
 * standard MCP tools over stdio. Works with ANY MCP client (harness
 * neutrality, SSOT D13).
 *
 * Deliberately absent: an approve tool. Approving production actions is
 * human-only (interactive terminal / hosted approval later) — an agent must
 * never be able to approve its own deploys, in no harness.
 */

// The two environments openpouch actually creates and governs: preview
// (autonomous) and production (approval-gated). We deliberately don't offer
// other names an agent could pick but nothing here produces (e.g. "staging") —
// R9.9, no tempting non-existent doors. The core model still permits manually
// authored env names for governed lanes; the MCP enum just doesn't advertise them.
const ENV_VALUES = ["preview", "production"] as const;

/**
 * Every command's JSON carries a top-level `summary` (PRD R3) — plain-language
 * text meant for a non-technical human. We surface it as a leading text block
 * (in addition to keeping it inside the JSON, so the CLI/MCP contract stays
 * identical, D13) so the agent sees the relay-ready text first and passes it on.
 */
function toolResult(cmd: CommandResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const summary = typeof cmd.json.summary === "string" ? cmd.json.summary : undefined;
  return {
    content: [
      ...(summary !== undefined ? [{ type: "text" as const, text: `Relay this to your human:\n${summary}` }] : []),
      { type: "text" as const, text: JSON.stringify(cmd.json, null, 2) },
    ],
    ...(cmd.exitCode === 0 ? {} : { isError: true }),
  };
}

/**
 * Run a command and shape it for MCP. A command may THROW a non-provider error
 * (e.g. `fetch failed` on a network drop) instead of returning a structured
 * result — the CLI catches that at its top level and still emits
 * `{ok:false, summary, error{category,message,fix}}`. Mirror that here so an MCP
 * client never gets a bare SDK error string: the CLI/MCP contract stays identical
 * (docs/MCP.md — "byte-identical to CLI --json"), just wrapped as a tool result.
 */
async function runTool(run: () => Promise<CommandResult>): Promise<ReturnType<typeof toolResult>> {
  try {
    return toolResult(await run());
  } catch (e) {
    // Keep a classified adapter error's category + targeted fix (network/auth/
    // quota/provider) — same contract as the CLI's top-level catch.
    if (isProviderApiError(e)) {
      return toolResult(errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix));
    }
    return toolResult(
      errorResult(
        EXIT.UNEXPECTED,
        "internal",
        (e as Error).message,
        "Unexpected failure — retry; if it persists, check network/credentials and report it.",
      ),
    );
  }
}

export interface ServerOptions {
  /** Base context; tool calls may override cwd per call. Test seam included. */
  baseCtx?: Partial<CliContext>;
}

export function createOpenpouchServer(options: ServerOptions = {}): McpServer {
  // Report the published package version (injected into the release bundle by
  // esbuild `define`, same source as `openpouch --version`). Dev/test builds
  // resolve to "0.0.0-dev". A hard-coded "0.0.0" would tell every MCP client the
  // wrong version for a 0.2.x release.
  const server = new McpServer({ name: "openpouch", version: VERSION });

  const makeCtx = (cwd?: string): CliContext => ({
    cwd: cwd ?? options.baseCtx?.cwd ?? process.cwd(),
    env: options.baseCtx?.env ?? (process.env as Record<string, string | undefined>),
    ...(options.baseCtx?.createAdapter !== undefined ? { createAdapter: options.baseCtx.createAdapter } : {}),
    ...(options.baseCtx?.probeUrl !== undefined ? { probeUrl: options.baseCtx.probeUrl } : {}),
  });

  // Hint to harnesses that a tool only reads — lets a client auto-approve it
  // without a write-permission prompt (R9 agent-legibility). Only the genuinely
  // side-effect-free tools carry it; init/deploy/rollback/delete are writes.
  const readOnly = { readOnlyHint: true } as const;

  const cwdField = {
    cwd: z.string().optional().describe("Project directory containing deploy.manifest.json (default: server cwd)"),
  };
  const envField = {
    environment: z
      .enum(ENV_VALUES)
      .optional()
      .describe(
        "Target environment. Omit to use the deploy's environment — production if the manifest has one, otherwise the single mapped env (e.g. an instant-lane preview). Same default as the CLI.",
      ),
  };

  server.registerTool(
    "openpouch_init",
    {
      description:
        "Initialize a project for openpouch: detects framework/build/env vars, writes deploy.manifest.json + deploy.policy.json (default policy: previews autonomous, production requires human approval), auto-matches an existing provider service by name. Idempotent.",
      inputSchema: { ...cwdField, force: z.boolean().optional().describe("Overwrite existing manifest/policy") },
    },
    async ({ cwd, force }) => runTool(() => initCommand(makeCtx(cwd), { force: force === true })),
  );

  server.registerTool(
    "openpouch_inspect",
    {
      description:
        "Answer: what is deployed, where, on which commit, which required env vars are missing (names only — never values), and what drift exists between manifest and provider. Env vars passed at deploy time (--var/--env-file) appear as `deployProvided` (names from local evidence — the instant lane never exposes them via the API). Read-only. The result carries a plain-language `summary` you can relay directly to a non-technical human.",
      inputSchema: cwdField,
      annotations: readOnly,
    },
    async ({ cwd }) => runTool(() => inspectCommand(makeCtx(cwd))),
  );

  server.registerTool(
    "openpouch_plan",
    {
      description:
        "Per environment: the policy decision (allowed / requires-approval / denied), blockers, readiness, and concrete next steps including the human-approval path. Read-only — reports, never acts.",
      inputSchema: cwdField,
      annotations: readOnly,
    },
    async ({ cwd }) => runTool(() => planCommand(makeCtx(cwd))),
  );

  server.registerTool(
    "openpouch_deploy",
    {
      description:
        "Zero-config INSTANT preview on openpouch's own infra — the `openpouch deploy` command (was CLI-only; Codex 2026-07-04). No account, no provider key, no manifest needed (a saved openpouch API key lifts the deploy into your tier; otherwise anonymous). Uploads the folder, builds on deploy (dynamic Node apps run in a container), probes health, and returns top-level `url`, `healthStatus` (+ `pending`), and a plain-language `summary` to relay to your human. The private claim link (a save token — like a password) is REDACTED from the result BY DEFAULT here, because tool results flow through chat context; it is saved locally to .openpouch/claim.json (0600, gitignored), so nothing is lost. Env var VALUES are secrets: injected into the container only, never in output or evidence (names only). For a full-stack app set healthPath (e.g. /api/health) so the deploy is held to its API too, not just `/`.",
      inputSchema: {
        ...cwdField,
        dir: z.string().optional().describe("Subfolder to deploy (e.g. `dist` for a built frontend) — default: the project folder itself (source trees build server-side)"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Env vars for the deployed app as NAME→value. Values are secrets (never surfaced; PORT/HOME are reserved and rejected)."),
        healthPath: z
          .string()
          .startsWith("/", "must be an origin-relative path like /api/health")
          .optional()
          .describe("Extra health check: after `/` answers, GET <path> must return 200 too (e.g. /api/health); recorded in the manifest so verify re-checks it"),
        redactSecrets: z
          .boolean()
          .optional()
          .describe("Default TRUE (unlike the CLI flag): the private claim link is omitted from the result and kept only in .openpouch/claim.json. Set false to include it — only in a private context, never in a shared report."),
      },
    },
    async ({ cwd, dir, env, healthPath, redactSecrets }) =>
      runTool(() =>
        instantCommand(makeCtx(cwd), dir, {
          ...(env !== undefined ? { vars: Object.entries(env).map(([k, v]) => `${k}=${v}`) } : {}),
          redactSecrets: redactSecrets !== false,
          ...(healthPath !== undefined ? { healthPath } : {}),
        }),
      ),
  );

  server.registerTool(
    "openpouch_deploy_preview",
    {
      description:
        "Deploy the preview environment through the governed pipeline (policy check → deploy → poll → smoke → evidence). Default policy allows previews autonomously. For the zero-config instant preview (no manifest/provider key) use openpouch_deploy instead. On success the live URL is returned at top-level `url`, plus a plain-language `summary` to relay to your human.",
      inputSchema: cwdField,
    },
    async ({ cwd }) => runTool(() => deployCommand(makeCtx(cwd), "preview")),
  );

  server.registerTool(
    "openpouch_deploy_production",
    {
      description:
        "Deploy production through the governed pipeline. If policy requires approval, this returns approvalRequest{id} with isError — ask your HUMAN to run `openpouch approve <id>` in their own terminal, then call this tool again. Agents cannot approve; there is intentionally no approve tool. Every result carries a plain-language `summary` to relay to your human; on a live deploy the URL is at top-level `url`.",
      inputSchema: cwdField,
    },
    async ({ cwd }) => runTool(() => deployCommand(makeCtx(cwd), "production")),
  );

  server.registerTool(
    "openpouch_verify",
    {
      description:
        "Run the healthcheck/smoke against the environment's live URL and append the results to the evidence (deploy.evidence.json + DEPLOYMENT.md). For a full-stack app pass healthPath (e.g. /api/health) — it is checked IN ADDITION to `/`, because a live shell can hide a dead API. The result carries a plain-language `summary` (healthy / has a problem) you can relay to your human.",
      inputSchema: {
        ...cwdField,
        ...envField,
        healthPath: z
          .string()
          .startsWith("/", "must be an origin-relative path like /api/health")
          .optional()
          .describe("Extra path that must ALSO return 200 (e.g. /api/health) — checked in addition to /"),
      },
    },
    async ({ cwd, environment, healthPath }) => {
      const ctx = makeCtx(cwd);
      return runTool(async () => verifyCommand(ctx, await targetEnvironment(ctx.cwd, environment), healthPath));
    },
  );

  server.registerTool(
    "openpouch_logs",
    {
      description:
        "Structured runtime logs ({timestamp, message}) of the mapped service. Read-only. This is the first step of the self-repair loop: when a deploy comes back unhealthy (a failed verify, a non-200 app, or a pending/not-yet-live URL), read the logs to find the cause, fix the code or config, redeploy, then verify — repeat until it passes.",
      inputSchema: {
        ...cwdField,
        ...envField,
        limit: z.number().int().positive().max(500).optional().describe("Max log lines (default 50)"),
      },
      annotations: readOnly,
    },
    async ({ cwd, environment, limit }) => {
      const ctx = makeCtx(cwd);
      return runTool(async () => logsCommand(ctx, await targetEnvironment(ctx.cwd, environment), limit ?? 50));
    },
  );

  server.registerTool(
    "openpouch_rollback",
    {
      description:
        "Redeploy the recorded rollback anchor commit (the deploy that was live before the latest one). Approval-gated like any write action — may return approvalRequest{id} for your human.",
      inputSchema: { ...cwdField, ...envField },
    },
    async ({ cwd, environment }) => {
      const ctx = makeCtx(cwd);
      return runTool(async () => rollbackCommand(ctx, await targetEnvironment(ctx.cwd, environment)));
    },
  );

  server.registerTool(
    "openpouch_whoami",
    {
      description:
        "Report the openpouch account behind the current API key: tier (plan) and current usage (live apps, deploys this hour/day), or that the caller is anonymous. Read-only. The key is read from OPENPOUCH_API_KEY / ~/.openpouch/openpouch-run.key and never echoed. Carries a plain-language `summary` you can relay to your human. (Signup/activation are CLI/web only — they involve a human email or browser step.)",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => runTool(() => whoamiCommand(makeCtx())),
  );

  server.registerTool(
    "openpouch_list",
    {
      description:
        "List the instant-lane apps owned by the current openpouch account key: name (slug), kind (static/dynamic), status, live URL, and expiry. Read-only; needs an account key (anonymous previews aren't grouped under an account → an empty list with a signup pointer). Carries a plain-language `summary` to relay to your human. Pair with openpouch_delete to free a quota slot when a deploy hits a 'limit reached' error.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => runTool(() => listCommand(makeCtx())),
  );

  server.registerTool(
    "openpouch_delete",
    {
      description:
        "Delete one of YOUR OWN instant-lane apps by name (slug) → frees a quota slot. This is the self-service fix for a 'limit reached' deploy error: list your apps, delete an unused one, redeploy. Owner-only — it uses your account key and the server verifies ownership, so you can never delete another account's app. Deleting an ephemeral preview is NOT a governed-production action, so it needs no approval (there is still no approve tool, D13). Returns the removed name + a plain-language `summary`.",
      inputSchema: {
        slug: z.string().describe("The app name (slug / subdomain) to delete — exactly as shown by openpouch_list"),
      },
    },
    async ({ slug }) => runTool(() => deleteCommand(makeCtx(), slug)),
  );

  server.registerTool(
    "openpouch_list_approvals",
    {
      description:
        "List pending approval requests (read-only). Approving itself is human-only via `openpouch approve <id>` in an interactive terminal — by design not available to agents.",
      inputSchema: cwdField,
      annotations: readOnly,
    },
    async ({ cwd }) => runTool(() => approveCommand(makeCtx(cwd), undefined)),
  );

  return server;
}

/**
 * `--version`/`--help` answers for the bin entrypoints. Without flags the
 * binary speaks MCP over stdio and is deliberately silent until a client
 * connects — but an agent probing `npx @openpouch/mcp --version` used to get
 * silent exit 0, which reads as broken (OpenClaw 2026-07-06). Returns
 * undefined when the process should start the actual server.
 */
export function mcpCliResponse(argv: readonly string[]): string | undefined {
  if (argv.includes("--version") || argv.includes("-v")) {
    return `@openpouch/mcp ${VERSION}`;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return [
      `@openpouch/mcp ${VERSION} — openpouch 🦘 MCP server (stdio).`,
      ``,
      `This is not an interactive CLI: run without flags it speaks the Model Context`,
      `Protocol on stdin/stdout and waits for an MCP client, so register it in your`,
      `harness instead of running it by hand, e.g.:`,
      `  claude mcp add openpouch -- npx -y @openpouch/mcp`,
      `13 tools (openpouch_deploy, _verify, _logs, _inspect, …) — and deliberately no`,
      `approve tool: production approval stays human-only in every harness.`,
      `Per-tool spec + one-command toolset probe from any shell: https://openpouch.dev/docs/MCP.md`,
      `Prefer a plain CLI? npx -y openpouch --help (same functions, --json output).`,
    ].join("\n");
  }
  return undefined;
}

export async function startStdioServer(): Promise<void> {
  const cliAnswer = mcpCliResponse(process.argv.slice(2));
  if (cliAnswer !== undefined) {
    process.stdout.write(cliAnswer + "\n");
    return;
  }
  const server = createOpenpouchServer();
  await server.connect(new StdioServerTransport());
}
