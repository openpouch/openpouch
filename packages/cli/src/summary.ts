/**
 * Plain-language summaries (PRD R3) — the human-readable `summary` field every
 * command output carries next to its structured JSON.
 *
 * Audience: the *non-technical operator* who runs an agent. The agent relays
 * this text to the human (verbatim if it likes). So every line here is written
 * in the second person, jargon-free: no "manifest", "env var", "commit",
 * "container", "smoke test" — the structured JSON keeps those for the agent.
 *
 * These functions are pure (data in → string out) so they are unit-tested
 * directly and the wording stays consistent across CLI and MCP.
 */

/** Join names like a person would: "A", "A and B", "A, B and C". */
export function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** ISO timestamp → "2026-06-16 14:30 UTC" (deterministic, no locale surprises). */
export function friendlyUtc(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/**
 * Sanitize a captured log line for structured output: strip ANSI escape
 * sequences (color/style CSI codes) AND all other C0 control chars except tab.
 * Build and runtime tools (npm, vite, node) emit colored output and \r
 * progress frames; both are noise in structured JSON and in text an agent
 * relays (OpenClaw 2026-06-29; Codex OP-005, 2026-07-13). Pure.
 */
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// C0 controls minus \t (0x09) and \n (0x0a); includes \r, \b, lone ESC, DEL.
// eslint-disable-next-line no-control-regex
const C0_EXCEPT_TAB_NL = /[\x00-\x08\x0b-\x1f\x7f]/g;
export function sanitizeLogMessage(s: string): string {
  return s.replace(ANSI_CSI, "").replace(C0_EXCEPT_TAB_NL, "");
}

// ── instant lane (`openpouch deploy`) ────────────────────────────────────────

export interface InstantDeploySummaryInput {
  name: string;
  url: string;
  expiresAt: string;
  /**
   * Result of the post-deploy GET / health check:
   *  - "pending":  still starting (dynamic apps boot a container) — the URL may
   *                briefly error until it finishes (R9.10).
   *  - "healthy":  GET / returned 200 — safe to share.
   *  - "degraded": the app started but its main page didn't return 200 — the
   *                agent should fix it before sharing (P0: deploy-ok ≠ app-healthy).
   * Static deploys are healthy immediately. Defaults to "healthy" when omitted.
   */
  health?: "pending" | "healthy" | "degraded";
  /** HTTP status the health check saw — used in the "degraded" wording. */
  statusCode?: number;
  /** True when --redact-secrets removed the claim link from THIS output — the
   *  summary then says so explicitly and points at .openpouch/claim.json
   *  (Codex 2026-07-04: "ask me for the link" read oddly in a redacted report;
   *  OpenClaw 2026-07-06: "I'll use it" implied an agent claim path — the agent
   *  hands the link over privately, claiming stays the human's action). */
  claimRedacted?: boolean;
  /** "account" = deployed under an openpouch account: already saved, expiry
   *  rolls while the app is used — the summary must NOT tell the anonymous
   *  72h/claim story (Codex F-01, 2026-07-12). Defaults to "anonymous". */
  ownership?: "anonymous" | "account";
  /** L12: named app — the URL is STABLE across redeploys; `updated` = this
   *  deploy replaced the content behind the existing URL. */
  app?: { name: string; updated: boolean };
}

// The claim link carries a save TOKEN — a secret (like a password). This summary
// is written to be relayed verbatim to (or by) a human, so it must NOT contain
// the token: a naive agent would paste the whole summary into a public report or
// customer chat and leak it (Balerion/Claude 2026-07-01). We describe how to keep
// the app in plain words; the actual private link travels only in the structured
// `claimUrl` field (flagged `claimUrlIsPrivate`) and .openpouch/claim.json.
export function instantDeploySummary(i: InstantDeploySummaryInput): string {
  const health = i.health ?? "healthy";
  // User feedback #1 (2026-07-15, "the price hint is still missing"): the keep
  // story names ALL three ways incl. what paid costs — the human never sees any
  // openpouch surface, so if the price isn't here, it doesn't exist for them.
  // One honest sentence, no push: doing nothing stays a fine outcome.
  const plans =
    `And if the app should stay awake around the clock or keep the data it saves, ` +
    `paid plans start at $15/month — current plans and prices: openpouch.dev/pricing.`;
  const keep =
    i.claimRedacted === true
      ? `To keep it there is a private save link (one click extends it to 7 days, or save ` +
        `it with a free account and it stays live as long as it's being used) — the link was ` +
        `deliberately left out of this report (it works like a password) and is stored on ` +
        `this computer in .openpouch/claim.json — just ask me and I'll hand it to you privately. ` +
        plans
      : `To keep it, just ask me — I'll give you the private save link directly (one click ` +
        `extends it to 7 days, or save it with a free account and it stays live as long as ` +
        `it's being used); it works like a password, so I won't post it in any shared report. ` +
        plans;
  // Account-owned deploys are already saved — no claim link, no 72h deadline.
  // Their expiry ROLLS with use (D25); saying "temporary preview / 72 hours"
  // here contradicted whoami and the docs (Codex F-01, 2026-07-12).
  const tail =
    i.app !== undefined
      ? `It's saved to your openpouch account as the app "${i.app.name}", and this address ` +
        `stays the same every time it's updated — no new links to hand out. It stays live ` +
        `as long as it's being used and would only expire after about 90 days without a ` +
        `single visit (with a warning email first). Nothing technical is needed from you.`
      : i.ownership === "account"
        ? `It's saved to your openpouch account, so it stays live as long as it's being ` +
          `used — it only expires after about 90 days without a single visit, and you'd ` +
          `get a warning email about a week before that happens. Nothing technical is ` +
          `needed from you.`
        : `It's a free temporary preview and will disappear on ${friendlyUtc(i.expiresAt)} ` +
          `(about 72 hours) unless you save it. ${keep} Nothing technical is needed from you.`;
  if (health === "pending") {
    return (
      `Your app "${i.name}" is being deployed and will be live at ${i.url} in a few ` +
      `moments — if you open it right away it may briefly show an error while it ` +
      `finishes starting up. ${tail}`
    );
  }
  if (health === "degraded") {
    const code = i.statusCode !== undefined ? ` (it returned error ${i.statusCode})` : "";
    return (
      `Your app "${i.name}" started, but its main page isn't loading correctly yet${code}, ` +
      `so it's not ready to share — I should look into it and fix it first. The address ` +
      `will be ${i.url} once it's working. ${tail}`
    );
  }
  if (i.app?.updated === true) {
    return (
      `Your app "${i.app.name}" was just updated and is live at its usual address ${i.url} — ` +
      `the link you've already shared keeps working. ${tail}`
    );
  }
  return (
    `Your app "${i.name}" is now live on the internet at ${i.url} — anyone you share ` +
    `that link with can open it right away. ${tail}`
  );
}

/**
 * Ready-to-relay hand-off for the HUMAN under an imperative field name —
 * user feedback #1 (2026-07-15/16): the expiry/keep info existed in `summary`,
 * but a free-running agent trimmed it and the user's app expired unnoticed
 * (he redeployed instead of keeping it). `tellYourUser` makes the hand-off a
 * field an agent can't misread. Same secret rule as the summary: NEVER the
 * claim link/token. Only set on a healthy deploy — a broken URL isn't handed
 * over (R9); anonymous names all three keep ways incl. price, account-owned
 * tells the rolling story without a sales pitch.
 */
export function tellYourUser(i: {
  url: string;
  expiresAt: string;
  ownership?: "anonymous" | "account";
  /** L12: named app — same URL on every update. */
  app?: { name: string; updated: boolean };
}): string {
  if (i.app !== undefined) {
    const lifecycle =
      `It stays live as long as it's being used — it only expires after about 90 days ` +
      `without a single visit, and you'd get a warning email first.`;
    return i.app.updated
      ? `Your app "${i.app.name}" was updated and is live at its usual address ${i.url} — ` +
        `the link stays the same on every update, so nothing you've shared breaks. ${lifecycle}`
      : `Your app "${i.app.name}" is live at ${i.url} — and this address now stays the same ` +
        `on every future update, so you can share it once. ${lifecycle}`;
  }
  if (i.ownership === "account") {
    return (
      `Your app is live at ${i.url}. It's saved to your openpouch account and stays live ` +
      `as long as it's being used — it only expires after about 90 days without a single ` +
      `visit, and you'd get a warning email first.`
    );
  }
  return (
    `Your app is live at ${i.url}. It's a free preview and expires on ${friendlyUtc(i.expiresAt)} ` +
    `unless you keep it. Keeping it is optional and easy: a free save link extends it to 7 days · ` +
    `a free account keeps it live as long as it's being used · paid plans (from $15/month, ` +
    `openpouch.dev/pricing) can keep an app awake around the clock and keep its data. Doing ` +
    `nothing is fine too — the preview simply expires, and it can be republished any time ` +
    `with one command.`
  );
}

/**
 * Detect-and-surface (PRD L10/D20): when an app writes data locally, warn — in
 * plain words — that an ephemeral preview does not keep it, so nobody loses data
 * silently (the Render lesson). Honest: persistent storage isn't a feature yet,
 * so this promises nothing. Jargon-free (no "SQLite"/"volume"/"container").
 */
export function dataDurabilityNote(): string {
  return (
    `One heads-up: this app saves data (like a database or files it writes). On a free ` +
    `temporary preview that data is NOT kept — it's cleared when the app is redeployed or the ` +
    `preview expires. Permanent storage isn't part of these previews yet, so don't rely on this ` +
    `for anything you need to keep.`
  );
}

// ── governed deploy (`preview` / `prod`) ─────────────────────────────────────

export interface DeploySummaryInput {
  environment: string;
  live: boolean;
  url?: string | undefined;
  smokePassed?: boolean | undefined;
  approvedBy?: string | undefined;
}

export function deploySummary(i: DeploySummaryInput): string {
  const at = i.url !== undefined ? ` at ${i.url}` : "";
  const approved = i.approvedBy !== undefined ? `With your approval, ` : "";
  if (!i.live) {
    return (
      `The ${i.environment} update did not go live — something failed while ` +
      `deploying. Your previous version is unaffected. I can check the logs to ` +
      `find out why.`
    );
  }
  if (i.smokePassed === false) {
    return (
      `${approved}your ${i.environment} app deployed and is online${at}, but my ` +
      `automatic health check found a problem — it may not be working correctly ` +
      `for visitors right now. You may want me to look into it.`
    );
  }
  const lead = approved !== "" ? approved : "Your ";
  const subject = approved !== "" ? `your ${i.environment} app` : `${i.environment} app`;
  // smokePassed === undefined on a live deploy means the health check was skipped
  // (no web address is set for this environment to test against) — say so honestly
  // rather than implying it was checked (R9.5).
  if (i.smokePassed === undefined) {
    return (
      `${lead}${subject} is live${at}, but I couldn't automatically check that it's ` +
      `working — there's no web address set for this environment to test against. You ` +
      `may want me to confirm it's responding.`
    );
  }
  const checked = i.smokePassed === true ? ` and I checked that it's responding correctly` : "";
  return `${lead}${subject} is live${at}${checked}. Nothing else is needed from you.`;
}

// ── inspect ──────────────────────────────────────────────────────────────────

export interface InspectEnvInput {
  status: "ok" | "unmapped";
  provider: string;
  service?: { name: string; url?: string | undefined; suspended: boolean } | undefined;
  envVars?: { missingRequired: string[] } | undefined;
}

export function inspectSummary(projectName: string, environments: Record<string, InspectEnvInput>): string {
  const names = Object.keys(environments);
  if (names.length === 0) {
    return `"${projectName}" isn't connected to any live service yet, so there's nothing deployed.`;
  }
  const lines: string[] = [`Here's the current status of "${projectName}":`];
  for (const [name, env] of Object.entries(environments)) {
    if (env.status === "unmapped" || env.service === undefined) {
      lines.push(`• ${name}: not connected to a live service yet.`);
      continue;
    }
    const where = env.service.url !== undefined ? `live at ${env.service.url}` : `set up (no public address yet)`;
    const paused = env.service.suspended ? " It's currently paused." : "";
    const missing = env.envVars?.missingRequired ?? [];
    const needs =
      missing.length > 0
        ? ` It still needs ${missing.length === 1 ? "this setting" : "these settings"} before it can fully work: ${humanList(missing)}.`
        : "";
    lines.push(`• ${name}: ${where}.${paused}${needs}`);
  }
  return lines.join("\n");
}

// ── verify ───────────────────────────────────────────────────────────────────

export interface VerifySummaryInput {
  environment: string;
  url: string;
  passed: boolean;
  checks: Array<{ passed: boolean; detail?: string | undefined }>;
}

export function verifySummary(i: VerifySummaryInput): string {
  const total = i.checks.length;
  const passedCount = i.checks.filter((c) => c.passed).length;
  if (i.passed) {
    return (
      `Good news — your ${i.environment} app at ${i.url} is healthy and responding ` +
      `correctly. ${total === 1 ? "The check" : `All ${total} checks`} passed.`
    );
  }
  const firstFail = i.checks.find((c) => !c.passed);
  const reason = firstFail?.detail !== undefined ? ` (${firstFail.detail})` : "";
  return (
    `Heads up — your ${i.environment} app at ${i.url} has a problem${reason}. ` +
    `${passedCount} of ${total} checks passed. It may not be working correctly for ` +
    `visitors right now, so you may want me to look into it.`
  );
}

// ── plan ─────────────────────────────────────────────────────────────────────

export interface PlanEnvInput {
  ready: boolean;
  blockers: string[];
  decision: "allowed" | "requires-approval" | "denied";
  /** Instant lane (openpouch-run): deploy IS the go-live, so the wording differs. */
  instant?: boolean;
}

export function planSummary(projectName: string, plans: Record<string, PlanEnvInput>): string {
  const names = Object.keys(plans);
  if (names.length === 0) {
    return `"${projectName}" has no environments set up to deploy yet.`;
  }
  const lines: string[] = [`Here's what can be published for "${projectName}":`];
  for (const [name, p] of Object.entries(plans)) {
    if (p.instant) {
      // Instant lane has no separate "go live"/approval step — deploy is live.
      // Saying "ready to go live" here misled an agent whose preview was already
      // live (OpenClaw 2026-07-02); state the instant semantics instead.
      lines.push(
        `• ${name}: publishes instantly — running \`openpouch deploy\` puts it live right away on a fresh temporary preview link (any earlier preview stays up until it expires). There's no separate go-live or approval step.`,
      );
    } else if (!p.ready) {
      lines.push(`• ${name}: not ready yet — ${humanList(p.blockers)}.`);
    } else if (p.decision === "requires-approval") {
      lines.push(`• ${name}: ready, but it will need your approval before it goes live.`);
    } else {
      lines.push(`• ${name}: ready to go live.`);
    }
  }
  return lines.join("\n");
}

// ── init ─────────────────────────────────────────────────────────────────────

export interface InitSummaryInput {
  name: string;
  framework?: string | undefined;
  matchedProvider?: string | undefined;
  alreadyInitialized?: boolean;
  /** What happened to AGENTS.md on this run — the summary must mention a real
   *  local change instead of implying nothing happened (Codex F-04, 2026-07-13). */
  agentsMd?: "created" | "updated" | "unchanged";
}

export function initSummary(i: InitSummaryInput): string {
  if (i.alreadyInitialized === true) {
    const agents =
      i.agentsMd === "created"
        ? " I also added an AGENTS.md file with deployment guidance for coding agents."
        : i.agentsMd === "updated"
          ? " I also refreshed the deployment guidance in AGENTS.md."
          : "";
    return `"${i.name}" is already set up for deployment.${agents} You can deploy it whenever you'd like.`;
  }
  const kind = i.framework !== undefined ? ` (a ${i.framework} app)` : "";
  // Lane truth (field report 2026-07-16): "connected to your existing service"
  // alone read as "openpouch is a layer over the old host" — an agent relayed
  // exactly that as the product's nature. Name both lanes in one breath.
  const connected =
    i.matchedProvider !== undefined
      ? ` I connected it to your existing ${i.matchedProvider} service — the app keeps running there, ` +
        `and openpouch manages its deploys (previews are free to run; going live needs your approval). ` +
        `If you'd rather have the app run on openpouch's own hosting instead, that's one command away.`
      : "";
  return `I've set up "${i.name}"${kind} for deployment.${connected} You're ready to deploy it whenever you'd like — just say the word.`;
}

// ── logs ─────────────────────────────────────────────────────────────────────

export function logsSummary(environment: string, count: number): string {
  if (count === 0) {
    return `There are no recent log entries for your ${environment} app.`;
  }
  return `Here are the ${count} most recent log entries from your ${environment} app — these are mainly useful for spotting errors.`;
}

// ── rollback ─────────────────────────────────────────────────────────────────

export interface RollbackSummaryInput {
  environment: string;
  live: boolean;
  url?: string | undefined;
  smokePassed?: boolean | undefined;
}

export function rollbackSummary(i: RollbackSummaryInput): string {
  if (!i.live) {
    return (
      `The rollback did not complete — the previous version of your ${i.environment} ` +
      `app could not be brought back online. I can investigate.`
    );
  }
  const at = i.url !== undefined ? ` at ${i.url}` : "";
  const health =
    i.smokePassed === false
      ? ` My health check still flags a problem, so you may want me to look closer.`
      : i.smokePassed === true
        ? ` I checked that it's responding correctly.`
        : "";
  return `I restored your ${i.environment} app to the previous working version. It's live again${at}.${health}`;
}

// ── approvals ────────────────────────────────────────────────────────────────

export function approveListSummary(pending: Array<{ id: string }>): string {
  if (pending.length === 0) {
    return `Nothing is waiting for your approval right now.`;
  }
  const ids = pending.map((p) => p.id);
  return (
    `There ${pending.length === 1 ? "is 1 change" : `are ${pending.length} changes`} waiting for ` +
    `your approval before going live. To approve, run this in your own terminal: ` +
    `${ids.map((id) => `openpouch approve ${id}`).join(" ; ")}`
  );
}

export function approveResultSummary(approved: boolean): string {
  return approved
    ? `Approved. The change can now be published.`
    : `Not approved — nothing was published.`;
}

/** Used by the policy gate when a write needs human approval. */
export function approvalRequiredSummary(environment: string, requestId: string): string {
  return (
    `Publishing to ${environment} needs your go-ahead first — for safety, an agent ` +
    `can't approve production changes by itself. To approve, open your own terminal ` +
    `and run: openpouch approve ${requestId}. Then I'll continue.`
  );
}

// ── accounts (signup / activate / whoami) ────────────────────────────────────

export function signupEmailSummary(email: string): string {
  return (
    `I've started creating your openpouch account for ${email}. Check that inbox ` +
    `for a message from openpouch and open the link inside to finish — that gives ` +
    `you a private key I use to publish apps under your account.`
  );
}

export function signupGithubSummary(url: string): string {
  return (
    `To create your openpouch account with GitHub, open this link in your browser ` +
    `and approve it: ${url}. When you're done you'll get a private key I use to ` +
    `publish apps under your account.`
  );
}

export function activateSummary(saved: boolean): string {
  return saved
    ? `Your openpouch account is ready, and I've saved your private key on this ` +
      `computer — so from now on I publish apps under your account. Nothing else is ` +
      `needed from you.`
    : `Your openpouch account is ready. Keep the private key somewhere safe — it's ` +
      `what lets me publish apps under your account.`;
}

export interface WhoamiSummaryInput {
  authenticated: boolean;
  tier?: string | undefined;
  liveDeployments?: number | undefined;
  maxLive?: number | undefined;
}

export function whoamiSummary(i: WhoamiSummaryInput): string {
  if (!i.authenticated) {
    return (
      `You don't have an openpouch account set up here yet, so your apps publish ` +
      `anonymously on the free temporary tier. To get your own account — higher ` +
      `limits, and your apps grouped together — run \`openpouch signup --email ` +
      `you@example.com\` (or \`--github\`) in a terminal and open the link it sends you.`
    );
  }
  const using =
    i.liveDeployments !== undefined && i.maxLive !== undefined
      ? ` You're using ${i.liveDeployments} of your ${i.maxLive} live apps.`
      : "";
  return `You're signed in to openpouch on the ${i.tier} plan.${using} Everything looks fine.`;
}

export interface ListDeploymentsSummaryInput {
  authenticated: boolean;
  count?: number | undefined;
  /** ISO timestamp of the soonest `expiresAt` in the list (T4, user feedback #1). */
  nextExpiry?: string | undefined;
}

export function listDeploymentsSummary(i: ListDeploymentsSummaryInput): string {
  if (!i.authenticated) {
    return (
      `You don't have an openpouch account set up here, so there are no apps ` +
      `grouped under you to show. To keep your apps in one place and manage them, ` +
      `run \`openpouch signup --email you@example.com\` (or \`--github\`) in a terminal.`
    );
  }
  const n = i.count ?? 0;
  if (n === 0) return `You don't have any apps running on openpouch right now.`;
  // T4 (user feedback #1): surface the soonest expiry so a later `list` still
  // carries the keep-story — honest about the rolling window, no sales pitch
  // (this is an account surface; the owner already knows `openpouch upgrade`).
  const expiry =
    i.nextExpiry !== undefined
      ? ` The soonest expiry is ${friendlyUtc(i.nextExpiry)} — apps stay live while they're being used (the expiry rolls forward with every visit).`
      : ``;
  return `You have ${n} app${n === 1 ? "" : "s"} running on openpouch right now.${expiry}`;
}

export function deleteDeploymentSummary(slug: string): string {
  return `I removed the app "${slug}" from openpouch. That frees up one of your app slots, so you can publish another.`;
}

// ── errors ───────────────────────────────────────────────────────────────────

const ERROR_LEADS: Record<string, string> = {
  auth: "I couldn't sign in to the hosting provider — an access key is missing or invalid.",
  "policy-denied": "This action isn't allowed by your current safety settings.",
  "human-required": "This needs a person to approve it — an agent can't do it.",
  env: "This project isn't fully set up for deployment yet.",
  quota: "The hosting provider reported that a limit was reached.",
  provider: "The hosting provider ran into a problem.",
  network: "I couldn't reach the deployment service at all — the network, DNS, or a firewall is in the way.",
  usage: "That command wasn't used correctly.",
  internal: "Something went wrong inside openpouch.",
};

export function errorSummary(category: string, message: string, fix: string): string {
  const lead = ERROR_LEADS[category] ?? `Something didn't work: ${message}.`;
  return `${lead} What to do next: ${fix}`;
}

// ── data channel (`openpouch data`, L13) ─────────────────────────────────────

/** Plain-language summary for `openpouch data push|pull|ls` (relay-ready, D7:
 *  counts and sizes only — file contents never appear anywhere). */
export function dataSummary(i: { verb: "push" | "pull" | "ls"; app: string; files?: number; bytes?: number; dest?: string; restarted?: boolean; warning?: boolean }): string {
  if (i.verb === "push") {
    const restart = i.warning === true
      ? `The app was paused for the write but hasn't come back healthy yet — it needs a look before sharing.`
      : i.restarted === true
        ? `The app restarted with the new data and is running again.`
        : `The app will use the new data the next time it runs.`;
    return `I moved your data into the app "${i.app}" — ${i.files ?? 0} file(s) are now in place, replacing what was there before. ${restart}`;
  }
  if (i.verb === "pull") {
    return `I saved a backup of the app "${i.app}"'s stored data to ${i.dest ?? "a local file"} (${i.bytes ?? 0} bytes, compressed). Keep it somewhere safe — it can be pushed back any time.`;
  }
  return `The app "${i.app}" currently stores ${i.files ?? 0} data file(s), ${i.bytes ?? 0} bytes in total.`;
}
