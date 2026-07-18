import { parseArgs } from "node:util";
import { environmentNameSchema, type EnvironmentName } from "@openpouch/core";
import { activateCommand } from "./commands/activate.js";
import { approveCommand } from "./commands/approve.js";
import { deleteCommand } from "./commands/delete.js";
import { deployCommand } from "./commands/deploy.js";
import { feedbackCommand } from "./commands/feedback.js";
import { initCommand } from "./commands/init.js";
import { instantCommand } from "./commands/instant.js";
import { inspectCommand } from "./commands/inspect.js";
import { dataCommand } from "./commands/data.js";
import { listCommand } from "./commands/list.js";
import { logsCommand } from "./commands/logs.js";
import { planCommand } from "./commands/plan.js";
import { rollbackCommand } from "./commands/rollback.js";
import { signupCommand } from "./commands/signup.js";
import { verifyCommand } from "./commands/verify.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { whoamiCommand } from "./commands/whoami.js";
import { feedbackHint } from "./feedback.js";
import { EXIT, errorResult, isProviderApiError, targetEnvironment, type CliContext, type CommandResult } from "./shared.js";

export type { CliContext, CommandResult } from "./shared.js";
export { targetEnvironment, EXIT, errorResult, isProviderApiError } from "./shared.js";

// Command functions are exported for programmatic embedding (MCP server,
// future SDKs) — same logic, no shell round-trip.
export { activateCommand } from "./commands/activate.js";
export { approveCommand } from "./commands/approve.js";
export { deleteCommand } from "./commands/delete.js";
export { deployCommand } from "./commands/deploy.js";
export { initCommand } from "./commands/init.js";
export { instantCommand } from "./commands/instant.js";
export { inspectCommand } from "./commands/inspect.js";
export { dataCommand } from "./commands/data.js";
export { listCommand } from "./commands/list.js";
export { logsCommand } from "./commands/logs.js";
export { planCommand } from "./commands/plan.js";
export { rollbackCommand } from "./commands/rollback.js";
export { signupCommand } from "./commands/signup.js";
export { verifyCommand } from "./commands/verify.js";
export { upgradeCommand } from "./commands/upgrade.js";
export { whoamiCommand } from "./commands/whoami.js";

export interface CliResult {
  exitCode: number;
  output: string;
}

const USAGE = [
  "openpouch 🦘 — agent-native deployment control plane",
  "",
  "usage: openpouch <command> [--json]",
  "",
  "commands:",
  "  deploy [dir]   zero-config instant preview on openpouch's own infra — deploys ./<dir> (e.g. `deploy dist`) or the current folder (anonymous, or under your account if a key is set)",
  "  list           list your instant-lane apps (name, kind, status, live URL, expiry) — needs your API key",
  "  delete <name>  delete one of your own apps → frees a quota slot (needs your API key)",
  "  data           push/pull/ls a named app's persistent /data: `data push <app> <dir>` replaces it (app restarts), `data pull <app> [dest]` downloads a backup, `data ls <app>` lists files (needs your API key)",
  "  signup         create an openpouch account: --email <addr> or --github (gives you an API key)",
  "  activate       finish an email signup: --account <id> --token <token> (saves your API key)",
  "  whoami         show the account behind your API key: tier + current usage",
  "  upgrade        get a checkout link for a paid tier (--plan <name>) — a human completes payment in the browser",
  "  init           detect the project, write deploy.manifest.json + deploy.policy.json (idempotent; --force regenerates)",
  "  inspect        answer: what is deployed, where, on which commit, which env vars are missing",
  "  plan           per environment: policy decision, blockers, readiness, next steps",
  "  preview        deploy the preview environment (autonomous if policy allows)",
  "  prod           deploy production — creates an approval request if policy requires one",
  "  approve [id]   list pending requests, or approve one (interactive terminal required — agents cannot approve)",
  "  verify         run the healthcheck/smoke against the live URL, append results to evidence",
  "  logs           structured runtime logs of the mapped service",
  "  rollback       redeploy the recorded rollback anchor commit (approval-gated like any write)",
  "  feedback       optional: tell us what tripped you up — `openpouch feedback \"<text>\"` (opt-out: DO_NOT_TRACK=1; sends only your note)",
  "",
  "flags:",
  "  --version, -v  print the openpouch version and exit (also: `openpouch version`)",
  "  --json         machine-readable output (single JSON object on stdout)",
  "  --force        (init) overwrite existing manifest/policy",
  "  --env <name>   (verify/logs/rollback) target environment, default: the deploy's environment (production, or the single one — e.g. an instant preview)",
  "  --limit <n>    (logs) number of log lines, default: 50",
  "  --var K=V      (deploy) set an env var in the deployed app (repeatable); the value never appears in output/logs/evidence",
  "  --env-file <f> (deploy) load env vars from a dotenv file (KEY=value per line)",
  "  --health-path <p> (deploy/verify) also require GET <p> → 200 (e.g. /api/health) — catches a live shell with a dead API",
  "  --redact-secrets (deploy) omit the private claim link from the result so the JSON is safe to paste into a report (still saved to .openpouch/claim.json)",
  "  --email <addr> (signup) create an account anchored to this email",
  "  --github       (signup) create an account via GitHub (prints the authorize URL)",
  "  --account <id> (activate) the account id from signup",
  "  --token <tok>  (activate) the verification token from the signup email",
  "  --key-file <p> (activate) where to save the issued key (default ~/.openpouch/openpouch-run.key; never overwrites a non-openpouch file)",
  "",
  "account key: deploys send Authorization: Bearer from OPENPOUCH_API_KEY or ~/.openpouch/openpouch-run.key (override the path with OPENPOUCH_KEY_FILE; optional — no key = anonymous)",
  "exit codes: 0 ok · 1 unexpected · 2 usage · 3 manifest/policy missing or invalid · 4 auth · 5 provider · 6 policy gate (approval required/denied/human required) · 7 deploy failed · 8 verify failed",
].join("\n");

// Re-exported from shared.ts (it moved there so commands can record the version
// without an import cycle); the MCP server imports it from here.
export { VERSION } from "./shared.js";
import { VERSION } from "./shared.js";

/**
 * Command-specific help (OpenClaw 2026-07-04: `<cmd> --help` printed the global
 * page for every command — an agent probing for exact syntax had to infer).
 * Shown for `openpouch <cmd> --help` and `openpouch help <cmd>`; each entry:
 * usage line, what it does, flags that apply, one example, and the most common
 * failure with the next command to run.
 */
const COMMAND_HELP: Record<string, string[]> = {
  deploy: [
    "usage: openpouch deploy [dir] [--json] [--app <name>] [--var K=V]... [--env-file <f>] [--health-path <p>] [--redact-secrets]",
    "",
    "Zero-config instant preview on openpouch's own infra. Deploys ./<dir> (e.g.",
    "`deploy dist`) or the current folder. Anonymous by default; a saved API key",
    "deploys under your account. Source trees build on deploy (server-side).",
    "",
    "flags:",
    "  --app <name>     named app (account required): the FIRST deploy mints its URL, every later `deploy --app <name>` UPDATES the app behind that SAME URL (health-checked before the swap — a failed update leaves the live version untouched)",
    "  --var K=V        set an env var in the deployed app (repeatable; value never surfaces)",
    "  --env-file <f>   load env vars from a dotenv file (KEY=value per line)",
    "  --health-path <p> extra health check: after `/` answers, GET <p> must return 200 too (e.g. /api/health); recorded in the manifest so `verify` re-checks it",
    "  --redact-secrets omit the private claim link from the result (still saved to .openpouch/claim.json)",
    "  --json           machine-readable result (top-level url, summary, healthStatus, pending)",
    "",
    "example: openpouch deploy . --json --var API_KEY=secret --health-path /api/health",
    "common failure: \"refusing to deploy what looks like unbuilt frontend source\"",
    "  → deploy the build output (`openpouch deploy dist`) or force with `openpouch deploy .`",
  ],
  data: [
    "usage: openpouch data <push|pull|ls> <app> [dir|dest] [--json]",
    "",
    "The data channel for a named app's persistent /data volume (account key",
    "required). This is what makes migrations and backups agent-autonomous.",
    "",
    "  push <app> <dir>   REPLACE the app's /data with the folder's contents —",
    "                     the app is stopped for the write and restarted health-gated",
    "  pull <app> [dest]  download /data as a gzipped tar (default: <app>-data.tgz)",
    "  ls <app>           list stored files (names/sizes only, never contents)",
    "",
    "example: openpouch data push my-shop ./data-export",
    "common failure: 400 'has no /data volume' → redeploy with `openpouch deploy . --app <name> --volume` (paid tiers)",
  ],
  list: [
    "usage: openpouch list [--json]",
    "",
    "List your instant-lane apps (name, kind, status, live URL, expiry).",
    "Needs your API key (OPENPOUCH_API_KEY or ~/.openpouch/openpouch-run.key).",
    "",
    "example: openpouch list --json",
    "common failure: 401 unauthorized → no key found; `openpouch signup` first, or export OPENPOUCH_API_KEY",
  ],
  delete: [
    "usage: openpouch delete <name> [--json]",
    "",
    "Delete one of your own apps and free a quota slot. Needs your API key;",
    "only deletes deployments owned by your account.",
    "",
    "example: openpouch delete my-app-x7k2p --json",
    "common failure: 404 not found → the name isn't one of your apps; `openpouch list` shows what you own",
  ],
  signup: [
    "usage: openpouch signup --email <addr> | --github",
    "",
    "Create an openpouch account (gives you an API key). Email: you get a",
    "verification mail, then finish with `openpouch activate`. GitHub: prints an",
    "authorize URL a HUMAN opens in a browser (agents: hand it to your human).",
    "",
    "example: openpouch signup --email you@example.com",
    "common failure: 409 already registered → the address has an account; use its key or `openpouch activate`",
  ],
  activate: [
    "usage: openpouch activate --account <id> --token <token> [--key-file <p>]",
    "",
    "Finish an email signup: exchanges the mailed token for your API key and",
    "saves it (default ~/.openpouch/openpouch-run.key; never overwrites a",
    "non-openpouch file).",
    "",
    "example: openpouch activate --account acct_123 --token tok_456",
    "common failure: token expired/used → run `openpouch signup` again for a fresh mail",
  ],
  whoami: [
    "usage: openpouch whoami [--json]",
    "",
    "Show the account behind your API key: tier, quotas, current usage —",
    "or `authenticated: false` when no key is set (anonymous mode).",
    "",
    "example: openpouch whoami --json",
  ],
  init: [
    "usage: openpouch init [--force] [--json]",
    "",
    "Detect the project and write deploy.manifest.json + deploy.policy.json",
    "(idempotent; --force regenerates). This is the entry to the GOVERNED lanes",
    "(Render/Vercel with your own provider key) — the instant lane (`openpouch",
    "deploy`) needs no init.",
    "",
    "example: openpouch init --json",
  ],
  inspect: [
    "usage: openpouch inspect [--json]",
    "",
    "Answer: what is deployed, where, on which commit, which env vars are",
    "missing. Reads deploy.manifest.json + the provider APIs. Env vars passed at",
    "deploy time via --var/--env-file appear as `deployProvided` (names only,",
    "from local evidence) — the instant lane never exposes them via the API.",
    "",
    "example: openpouch inspect --json",
    "common failure: \"no deploy.manifest.json\" → run `openpouch init` (governed) or deploy first (instant)",
  ],
  plan: [
    "usage: openpouch plan [--json]",
    "",
    "Per environment: policy decision, blockers, readiness, next steps —",
    "without deploying anything.",
    "",
    "example: openpouch plan --json",
  ],
  preview: [
    "usage: openpouch preview [--json]",
    "",
    "Deploy the preview environment of a CONFIGURED project (governed lane,",
    "autonomous if policy allows). For the zero-config instant preview use",
    "`openpouch deploy`.",
    "",
    "example: openpouch preview --json",
  ],
  prod: [
    "usage: openpouch prod [--json]",
    "",
    "Deploy production (governed lane) — creates an approval request when policy",
    "requires one; a HUMAN approves in an interactive terminal (`openpouch",
    "approve`). Agents cannot approve (by design).",
    "",
    "example: openpouch prod --json",
    "common failure: exit 6 (approval required) → ask your human to run `openpouch approve`",
  ],
  approve: [
    "usage: openpouch approve [id]",
    "",
    "List pending approval requests, or approve one. Interactive terminal",
    "required — this is the human gate; agents cannot run it (by design).",
  ],
  verify: [
    "usage: openpouch verify [--env <name>] [--health-path <p>] [--json]",
    "",
    "Run the healthcheck against the live URL and append the results to the",
    "evidence. Default check: the manifest's healthcheck (or GET / expects 200).",
    "With --health-path (or a non-/ manifest healthcheck) it checks BOTH `/` and",
    "the given path — a full-stack app can serve `/` while its API is broken.",
    "",
    "flags:",
    "  --env <name>      target environment (default: the deploy's environment)",
    "  --health-path <p> one-off extra path to check, e.g. /api/health",
    "",
    "example: openpouch verify --health-path /api/health --json",
    "common failure: exit 8 (check failed) → `openpouch logs --json` shows why; fix, redeploy, re-verify",
  ],
  logs: [
    "usage: openpouch logs [--env <name>] [--limit <n>] [--json]",
    "",
    "Structured runtime logs ({timestamp, message}) of the deployed app —",
    "install/build/app phases are tagged [install]/[build]/[app]. First step of",
    "the self-repair loop when a deploy is unhealthy.",
    "",
    "flags:",
    "  --env <name>   target environment (default: the deploy's environment)",
    "  --limit <n>    number of log lines (default 50)",
    "",
    "example: openpouch logs --json --limit 120",
  ],
  rollback: [
    "usage: openpouch rollback [--env <name>] [--json]",
    "",
    "Redeploy the recorded rollback anchor commit (approval-gated like any",
    "write). Instant previews have no anchor — redeploy with `openpouch deploy`",
    "instead.",
    "",
    "example: openpouch rollback --env production --json",
  ],
  feedback: [
    "usage: openpouch feedback \"<text>\"",
    "",
    "Optional: tell us what tripped you up (sends only your note; opt out with",
    "DO_NOT_TRACK=1).",
    "",
    "example: openpouch feedback \"verify should support retries\"",
  ],
};
COMMAND_HELP["help"] = ["usage: openpouch help [command]", "", "Show the global help, or a command's specific help."];

/** Render a command's help (human lines + a machine shape for --json). */
function helpResult(command: string, json: boolean): CliResult {
  const lines = COMMAND_HELP[command];
  if (lines === undefined) {
    return {
      exitCode: EXIT.USAGE,
      output: json
        ? JSON.stringify({ ok: false, error: `unknown command: ${command}`, fix: "Run `openpouch --help` for the command list." }, null, 2)
        : `unknown command: ${command}\n\n${USAGE}`,
    };
  }
  return {
    exitCode: EXIT.OK,
    output: json ? JSON.stringify({ ok: true, command, help: lines }, null, 2) : lines.join("\n"),
  };
}

function render(result: CommandResult, json: boolean, env?: Record<string, string | undefined>): CliResult {
  // R10.3: at a friction moment (an error/dead-end, where the agent pauses anyway)
  // invite optional feedback — an agent-legible JSON field only, never on success
  // (R10.1), suppressed entirely when the user opted out (R10.5a).
  let out = result;
  if (env !== undefined && result.json.ok === false && result.json["feedbackHint"] === undefined) {
    const hint = feedbackHint(env);
    if (hint !== undefined) out = { ...result, json: { ...result.json, feedbackHint: hint } };
  }
  return {
    exitCode: out.exitCode,
    output: json ? JSON.stringify(out.json, null, 2) : out.human.join("\n"),
  };
}

export async function run(argv: string[], ctx: CliContext): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        github: { type: "boolean", default: false },
        env: { type: "string" },
        limit: { type: "string" },
        email: { type: "string" },
        account: { type: "string" },
        token: { type: "string" },
        "key-file": { type: "string" },
        "env-file": { type: "string" },
        var: { type: "string", multiple: true },
        "redact-secrets": { type: "boolean", default: false },
        "health-path": { type: "string" },
        plan: { type: "string" },
        volume: { type: "boolean", default: false },
        "always-on": { type: "boolean", default: false },
        app: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    return render(
      errorResult(EXIT.USAGE, "usage", (e as Error).message, "Run `openpouch --help` for usage."),
      argv.includes("--json"),
    );
  }

  const json = parsed.values.json === true;
  const command = parsed.positionals[0];

  if (parsed.values.version === true || command === "version") {
    return { exitCode: EXIT.OK, output: json ? JSON.stringify({ ok: true, version: VERSION }) : `openpouch ${VERSION}` };
  }

  if (parsed.values.help === true || command === undefined || command === "help") {
    // `<cmd> --help` and `help <cmd>` get the command's SPECIFIC help (OpenClaw
    // 2026-07-04) — bare `--help` / `help` keep the global page.
    const helpTarget = command === "help" ? parsed.positionals[1] : command;
    if (helpTarget !== undefined && helpTarget !== "help") return helpResult(helpTarget, json);
    return { exitCode: command === undefined && parsed.values.help !== true ? EXIT.USAGE : EXIT.OK, output: USAGE };
  }

  // --health-path (deploy/verify): an origin-relative path like /api/health.
  const healthPath = parsed.values["health-path"];
  if (healthPath !== undefined && !healthPath.startsWith("/")) {
    return render(
      errorResult(EXIT.USAGE, "usage", `invalid --health-path: ${healthPath}`, "Pass an origin-relative path starting with '/', e.g. `--health-path /api/health`."),
      json,
    );
  }

  // Target environment for verify/logs/rollback. An explicit --env is validated and
  // used verbatim; omitted → the manifest's smart default via targetEnvironment() —
  // the SAME helper the MCP server uses, so the CLI and MCP defaults can never
  // diverge again (R9.8). The instant lane (only a `preview` env) thus just works.
  let explicitEnv: EnvironmentName | undefined;
  if (parsed.values.env !== undefined) {
    const parsedEnv = environmentNameSchema.safeParse(parsed.values.env);
    if (!parsedEnv.success) {
      return render(
        errorResult(EXIT.USAGE, "usage", `invalid --env: ${parsed.values.env}`, "Valid values: preview, production."),
        json,
      );
    }
    explicitEnv = parsedEnv.data;
  }
  const targetEnv = await targetEnvironment(ctx.cwd, explicitEnv);

  try {
    switch (command) {
      case "deploy":
        return render(
          await instantCommand(ctx, parsed.positionals[1], {
            envFile: parsed.values["env-file"],
            vars: parsed.values.var,
            redactSecrets: parsed.values["redact-secrets"] === true,
            healthPath,
            volume: parsed.values.volume === true,
            alwaysOn: parsed.values["always-on"] === true,
            app: parsed.values.app,
          }),
          json,
          ctx.env,
        );
      case "signup":
        return render(await signupCommand(ctx, { email: parsed.values.email, github: parsed.values.github === true }), json, ctx.env);
      case "activate":
        return render(
          await activateCommand(ctx, {
            account: parsed.values.account,
            token: parsed.values.token,
            keyFile: parsed.values["key-file"],
          }),
          json,
          ctx.env,
        );
      case "whoami":
        return render(await whoamiCommand(ctx), json, ctx.env);
      case "upgrade":
        return render(await upgradeCommand(ctx, typeof parsed.values.plan === "string" ? parsed.values.plan : undefined), json, ctx.env);
      case "data":
        return render(await dataCommand(ctx, parsed.positionals[1], parsed.positionals[2], parsed.positionals[3]), json, ctx.env);
      case "list":
        return render(await listCommand(ctx), json, ctx.env);
      case "delete":
        return render(await deleteCommand(ctx, parsed.positionals[1]), json, ctx.env);
      case "init":
        return render(await initCommand(ctx, { force: parsed.values.force === true }), json, ctx.env);
      case "inspect":
        return render(await inspectCommand(ctx), json, ctx.env);
      case "plan":
        return render(await planCommand(ctx), json, ctx.env);
      case "preview":
        return render(await deployCommand(ctx, "preview"), json, ctx.env);
      case "prod":
        return render(await deployCommand(ctx, "production"), json, ctx.env);
      case "approve":
        return render(await approveCommand(ctx, parsed.positionals[1]), json, ctx.env);
      case "verify":
        return render(await verifyCommand(ctx, targetEnv, healthPath), json, ctx.env);
      case "feedback":
        return render(await feedbackCommand(ctx, parsed.positionals[1]), json, ctx.env);
      case "logs": {
        const limit = Number(parsed.values.limit ?? "50");
        if (!Number.isInteger(limit) || limit <= 0) {
          return render(errorResult(EXIT.USAGE, "usage", `invalid --limit: ${parsed.values.limit}`, "Use a positive integer."), json, ctx.env);
        }
        return render(await logsCommand(ctx, targetEnv, limit), json, ctx.env);
      }
      case "rollback":
        return render(await rollbackCommand(ctx, targetEnv), json, ctx.env);
      default:
        return render(
          errorResult(EXIT.USAGE, "usage", `unknown command: ${command}`, "Run `openpouch --help` for usage."),
          json,
          ctx.env,
        );
    }
  } catch (e) {
    // A classified adapter error (auth/quota/provider/network) that a command
    // didn't catch itself keeps its category + targeted fix — a network drop
    // must not degrade into a generic "re-run and report" (Codex 2026-07-04).
    if (isProviderApiError(e)) {
      return render(
        errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix),
        json,
        ctx.env,
      );
    }
    return render(
      errorResult(
        EXIT.UNEXPECTED,
        "provider",
        (e as Error).message,
        "Unexpected failure — re-run with --json and report the output.",
      ),
      json,
      ctx.env,
    );
  }
}
