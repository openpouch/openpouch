import { describe, expect, it } from "vitest";
import {
  activateSummary,
  approvalRequiredSummary,
  approveListSummary,
  approveResultSummary,
  dataDurabilityNote,
  deleteDeploymentSummary,
  deploySummary,
  errorSummary,
  friendlyUtc,
  humanList,
  initSummary,
  inspectSummary,
  instantDeploySummary,
  listDeploymentsSummary,
  logsSummary,
  planSummary,
  rollbackSummary,
  signupEmailSummary,
  signupGithubSummary,
  sanitizeLogMessage,
  tellYourUser,
  verifySummary,
  whoamiSummary,
} from "../src/summary.js";

/** Words a non-technical operator shouldn't have to parse (PRD R3). */
const JARGON = ["manifest", "env var", "serviceId", "commit", "container", "smoke", "policy.json", "stdio"];
function assertPlain(text: string): void {
  for (const word of JARGON) expect(text.toLowerCase()).not.toContain(word.toLowerCase());
}

describe("list/delete summaries", () => {
  it("listDeploymentsSummary: anonymous vs counts, all jargon-free", () => {
    const anon = listDeploymentsSummary({ authenticated: false });
    expect(anon.toLowerCase()).toContain("account");
    assertPlain(anon);
    const none = listDeploymentsSummary({ authenticated: true, count: 0 });
    expect(none.toLowerCase()).toContain("any");
    assertPlain(none);
    const some = listDeploymentsSummary({ authenticated: true, count: 3 });
    expect(some).toContain("3 apps");
    assertPlain(some);
    const one = listDeploymentsSummary({ authenticated: true, count: 1 });
    expect(one).toContain("1 app ");
    assertPlain(one);
    // T4 (user feedback #1): a later `list` still carries the keep story —
    // soonest expiry as a real date + the honest rolling explanation.
    const soon = listDeploymentsSummary({ authenticated: true, count: 3, nextExpiry: "2026-06-16T14:30:00Z" });
    expect(soon).toContain("2026-06-16 14:30 UTC");
    expect(soon.toLowerCase()).toContain("rolls forward");
    assertPlain(soon);
  });

  it("deleteDeploymentSummary names the app, mentions the freed slot, jargon-free", () => {
    const s = deleteDeploymentSummary("joey-ab12cd");
    expect(s).toContain("joey-ab12cd");
    expect(s.toLowerCase()).toContain("slot");
    assertPlain(s);
  });
});

describe("summary helpers", () => {
  it("humanList joins like a person", () => {
    expect(humanList([])).toBe("");
    expect(humanList(["A"])).toBe("A");
    expect(humanList(["A", "B"])).toBe("A and B");
    expect(humanList(["A", "B", "C"])).toBe("A, B and C");
  });

  it("friendlyUtc renders a readable UTC stamp, falls back on junk", () => {
    expect(friendlyUtc("2026-06-16T14:30:00Z")).toBe("2026-06-16 14:30 UTC");
    expect(friendlyUtc("not-a-date")).toBe("not-a-date");
  });

  it("sanitizeLogMessage removes color/style codes, leaves plain text (OpenClaw: clean JSON logs)", () => {
    expect(sanitizeLogMessage("[32m✓ built[0m")).toBe("✓ built");
    expect(sanitizeLogMessage("[1m[31merror[0m here")).toBe("error here");
    expect(sanitizeLogMessage("no codes")).toBe("no codes");
  });

  it("initSummary on an already-initialized project mentions a freshly created/updated AGENTS.md (Codex F-04, 2026-07-13)", () => {
    const created = initSummary({ name: "shop", alreadyInitialized: true, agentsMd: "created" });
    expect(created).toContain("AGENTS.md");
    expect(created.toLowerCase()).toContain("added");
    const updated = initSummary({ name: "shop", alreadyInitialized: true, agentsMd: "updated" });
    expect(updated).toContain("AGENTS.md");
    const unchanged = initSummary({ name: "shop", alreadyInitialized: true, agentsMd: "unchanged" });
    expect(unchanged).not.toContain("AGENTS.md");
    assertPlain(unchanged);
  });

  it("sanitizeLogMessage drops \\r progress frames and other C0 controls, keeps tabs (Codex OP-005, 2026-07-13)", () => {
    expect(sanitizeLogMessage("[build] \rtransforming...")).toBe("[build] transforming...");
    expect(sanitizeLogMessage("a\rb\bc\u0000d")).toBe("abcd");
    expect(sanitizeLogMessage("keep\ttabs")).toBe("keep\ttabs");
  });
});

describe("instantDeploySummary — redacted claim wording (Codex 2026-07-04)", () => {
  it("says the link was deliberately left out and points at .openpouch/claim.json", () => {
    const s = instantDeploySummary({
      name: "shop",
      url: "https://shop-x1.openpouch.sh",
      expiresAt: "2026-07-07T00:00:00.000Z",
      health: "healthy",
      claimRedacted: true,
    });
    expect(s).toContain("deliberately left out");
    expect(s).toContain(".openpouch/claim.json");
    // the non-redacted offer ("I'll give you the private save link") must be gone
    expect(s).not.toContain("I'll give");
    // still no token/link material anywhere
    expect(s).not.toContain("token");
  });

  it("offers to hand the link over privately — not to use it itself (OpenClaw 2026-07-06)", () => {
    const s = instantDeploySummary({
      name: "shop",
      url: "https://shop-x1.openpouch.sh",
      expiresAt: "2026-07-07T00:00:00.000Z",
      health: "healthy",
      claimRedacted: true,
    });
    expect(s).toContain("hand it to you privately");
    // claiming is the human's action; the agent must not promise to redeem the link
    expect(s).not.toContain("I'll use it");
  });

  it("without redaction the offer wording stays", () => {
    const s = instantDeploySummary({
      name: "shop",
      url: "https://shop-x1.openpouch.sh",
      expiresAt: "2026-07-07T00:00:00.000Z",
      health: "healthy",
    });
    expect(s).toContain("I'll give");
    expect(s).not.toContain(".openpouch/claim.json");
  });
});

describe("instantDeploySummary — account-owned wording (Codex F-01, 2026-07-12)", () => {
  const s = instantDeploySummary({
    name: "joey",
    url: "https://joey-x.openpouch.sh",
    expiresAt: "2026-10-10T00:00:00Z",
    ownership: "account",
  });
  it("tells the rolling account story (K11: saved, lives while used, warning mail first)", () => {
    expect(s).toContain("saved to your openpouch account");
    expect(s).toContain("as long as it's being used");
    expect(s.toLowerCase()).toContain("warning email");
  });
  it("never tells the anonymous 72h/claim story on an owned deploy", () => {
    expect(s).not.toContain("72 hours");
    expect(s).not.toContain("temporary preview");
    expect(s.toLowerCase()).not.toContain("save link");
    expect(s.toLowerCase()).not.toContain("claim");
    expect(s).not.toContain("disappear");
  });
  it("is jargon-free", () => assertPlain(s));
});

describe("keep-story pricing + tellYourUser hand-off (user feedback #1, 2026-07-15/16)", () => {
  // The human never sees any openpouch surface — the agent is their only
  // channel. Field report: the info existed in `summary`, a free-running agent
  // trimmed it, the app expired unnoticed. The price was the user's explicit
  // ask ("the hint what it costs is still missing").
  it("anonymous keep story names the paid plans with a price and the pricing page", () => {
    const s = instantDeploySummary({ name: "joey", url: "https://joey-x.openpouch.sh", expiresAt: "2026-06-16T14:30:00Z" });
    expect(s).toContain("$15/month");
    expect(s).toContain("openpouch.dev/pricing");
    assertPlain(s);
  });
  it("account-owned story stays pitch-free (no price, no pricing link)", () => {
    const s = instantDeploySummary({ name: "joey", url: "https://joey-x.openpouch.sh", expiresAt: "2026-10-10T00:00:00Z", ownership: "account" });
    expect(s).not.toContain("$15");
    expect(s).not.toContain("pricing");
  });
  it("tellYourUser (anonymous): URL, exact date, all three keep ways incl. price, doing-nothing-is-fine — never the claim link/token", () => {
    const t = tellYourUser({ url: "https://joey-x.openpouch.sh", expiresAt: "2026-06-16T14:30:00Z" });
    expect(t).toContain("https://joey-x.openpouch.sh");
    expect(t).toContain("2026-06-16 14:30 UTC");
    expect(t.toLowerCase()).toContain("free save link");
    expect(t.toLowerCase()).toContain("free account");
    expect(t).toContain("$15/month");
    expect(t).toContain("openpouch.dev/pricing");
    expect(t.toLowerCase()).toContain("doing nothing is fine");
    expect(t).not.toContain("openpouch.sh/claim");
    expect(t).not.toContain("token");
    assertPlain(t);
  });
  it("tellYourUser (account-owned): rolling story, no sales pitch", () => {
    const t = tellYourUser({ url: "https://joey-x.openpouch.sh", expiresAt: "2026-10-10T00:00:00Z", ownership: "account" });
    expect(t).toContain("saved to your openpouch account");
    expect(t).not.toContain("$15");
    expect(t).not.toContain("pricing");
    assertPlain(t);
  });
});

describe("instantDeploySummary (R3 + R5)", () => {
  const s = instantDeploySummary({
    name: "joey",
    url: "https://joey-x.openpouch.sh",
    expiresAt: "2026-06-16T14:30:00Z",
  });
  it("leads with the live link and the name", () => {
    expect(s).toContain("joey");
    expect(s).toContain("https://joey-x.openpouch.sh");
  });
  it("explains the temporary nature and how to keep it", () => {
    expect(s).toContain("72 hours");
    expect(s).toContain("2026-06-16 14:30 UTC");
  });
  it("keeps the claim token OUT of the relayable summary (Balerion/Claude 2026-07-01)", () => {
    // The summary is meant to be relayed to a human verbatim — a naive agent could
    // paste it into a public report. The private save link/token must therefore not
    // appear in it; the agent gets the link from the structured `claimUrl` field.
    expect(s).not.toContain("openpouch.sh/claim");
    expect(s).not.toContain("token");
    // …but it still tells the human, in plain words, that a private save link exists.
    expect(s.toLowerCase()).toContain("private save link");
    expect(s.toLowerCase()).toContain("like a password");
  });
  it("is jargon-free", () => assertPlain(s));
  it("a pending (still-building) deploy doesn't promise it's reachable yet (R9.10)", () => {
    const p = instantDeploySummary({
      name: "joey",
      url: "https://joey-x.openpouch.sh",
      expiresAt: "2026-06-16T14:30:00Z",
      health: "pending",
    });
    expect(p.toLowerCase()).toContain("being deployed");
    expect(p).not.toContain("now live");
    expect(p).toContain("https://joey-x.openpouch.sh");
    assertPlain(p);
  });
  it("a degraded (live-but-unhealthy) deploy says don't share it yet (P0)", () => {
    const d = instantDeploySummary({
      name: "joey",
      url: "https://joey-x.openpouch.sh",
      expiresAt: "2026-06-16T14:30:00Z",
      health: "degraded",
      statusCode: 404,
    });
    expect(d).not.toContain("anyone"); // must NOT invite sharing
    expect(d).not.toContain("now live");
    expect(d.toLowerCase()).toContain("isn't loading correctly");
    expect(d).toContain("404");
    expect(d).toContain("https://joey-x.openpouch.sh");
    assertPlain(d);
  });
});

describe("dataDurabilityNote (L10)", () => {
  const n = dataDurabilityNote();
  it("warns the data isn't kept and over-promises nothing", () => {
    expect(n.toLowerCase()).toContain("saves data");
    expect(n.toLowerCase()).toContain("not kept");
    expect(n.toLowerCase()).toContain("isn't part of these previews yet"); // honest: no persistent feature
  });
  it("is jargon-free", () => assertPlain(n));
});

describe("deploySummary", () => {
  it("live + healthy reads reassuring and jargon-free", () => {
    const s = deploySummary({ environment: "production", live: true, url: "https://x.test", smokePassed: true });
    expect(s).toContain("live");
    expect(s).toContain("https://x.test");
    expect(s).toContain("responding correctly");
    assertPlain(s);
  });
  it("live but unhealthy flags the problem", () => {
    const s = deploySummary({ environment: "production", live: true, url: "https://x.test", smokePassed: false });
    expect(s).toContain("problem");
    expect(s).toContain("https://x.test");
  });
  it("not live reassures the previous version is safe", () => {
    const s = deploySummary({ environment: "production", live: false });
    expect(s.toLowerCase()).toContain("did not go live");
    expect(s).toContain("previous version");
  });
  it("notes when it went out with human approval", () => {
    const s = deploySummary({ environment: "production", live: true, url: "https://x.test", smokePassed: true, approvedBy: "dino" });
    expect(s.toLowerCase()).toContain("with your approval");
  });
  it("live but unchecked (smoke skipped, no url) is honest, not reassuring (A6/R9.5)", () => {
    const s = deploySummary({ environment: "preview", live: true, smokePassed: undefined });
    expect(s.toLowerCase()).toContain("couldn't automatically check");
    expect(s).not.toContain("Nothing else is needed");
    assertPlain(s);
  });
});

describe("inspectSummary", () => {
  it("reports a live environment with its link", () => {
    const s = inspectSummary("demo", {
      production: { status: "ok", provider: "render", service: { name: "demo", url: "https://demo.test", suspended: false } },
    });
    expect(s).toContain("demo");
    expect(s).toContain("https://demo.test");
    assertPlain(s);
  });
  it("calls out missing settings in plain words", () => {
    const s = inspectSummary("demo", {
      production: {
        status: "ok",
        provider: "render",
        service: { name: "demo", url: "https://demo.test", suspended: false },
        envVars: { missingRequired: ["DATABASE_URL", "API_KEY"] },
      },
    });
    expect(s).toContain("still needs");
    expect(s).toContain("DATABASE_URL and API_KEY");
  });
  it("says when nothing is connected", () => {
    expect(inspectSummary("demo", {})).toContain("nothing deployed");
    const s = inspectSummary("demo", { preview: { status: "unmapped", provider: "render" } });
    expect(s).toContain("not connected");
  });
});

describe("verifySummary", () => {
  it("passing is good news", () => {
    const s = verifySummary({ environment: "production", url: "https://x.test", passed: true, checks: [{ passed: true }] });
    expect(s.toLowerCase()).toContain("good news");
    expect(s).toContain("healthy");
    assertPlain(s);
  });
  it("failing names the reason and the ratio", () => {
    const s = verifySummary({
      environment: "production",
      url: "https://x.test",
      passed: false,
      checks: [{ passed: true }, { passed: false, detail: "received 404" }],
    });
    expect(s).toContain("problem");
    expect(s).toContain("received 404");
    expect(s).toContain("1 of 2");
  });
});

describe("planSummary", () => {
  const plans = {
    preview: { ready: true, blockers: [], decision: "allowed" as const },
    production: { ready: false, blockers: ["missing required env vars: DATABASE_URL"], decision: "requires-approval" as const },
  };
  it("lists readiness per environment", () => {
    const s = planSummary("demo", plans);
    expect(s).toContain("ready to go live");
    expect(s).toContain("not ready");
  });
  it("notes approval need for a ready-but-gated environment", () => {
    const s = planSummary("demo", { production: { ready: true, blockers: [], decision: "requires-approval" } });
    expect(s).toContain("need your approval");
  });
  it("uses instant-lane wording (not 'go live') for an openpouch-run env (OpenClaw 2026-07-02)", () => {
    const s = planSummary("demo", { preview: { ready: true, blockers: [], decision: "allowed", instant: true } });
    expect(s).toContain("publishes instantly");
    expect(s).not.toContain("ready to go live"); // the misleading governed-lane phrasing
  });
  it("handles no environments", () => {
    expect(planSummary("demo", {})).toContain("no environments");
  });
});

describe("initSummary", () => {
  it("new project mentions framework and provider when known", () => {
    const s = initSummary({ name: "demo", framework: "next", matchedProvider: "render" });
    expect(s).toContain("demo");
    expect(s).toContain("next");
    expect(s).toContain("render");
    expect(s.toLowerCase()).toContain("ready to deploy");
  });
  it("a matched provider tells the LANE truth — app keeps running there, own hosting named (field report 2026-07-16)", () => {
    // An agent read "connected to your existing render service" as "openpouch
    // is a governance layer over the old host" and told its human a migration
    // had happened. The summary must say the app KEEPS RUNNING on the old host
    // and that openpouch's own hosting is a separate, one-command path.
    const s = initSummary({ name: "demo", matchedProvider: "render" });
    expect(s).toContain("keeps running there");
    expect(s.toLowerCase()).toContain("own hosting");
    // No provider matched → no lane sentence needed.
    const plain = initSummary({ name: "demo" });
    expect(plain).not.toContain("keeps running");
  });
  it("already-initialized is acknowledged", () => {
    expect(initSummary({ name: "demo", alreadyInitialized: true })).toContain("already set up");
  });
});

describe("logsSummary", () => {
  it("counts entries or says there are none", () => {
    expect(logsSummary("production", 0)).toContain("no recent log");
    expect(logsSummary("production", 12)).toContain("12 most recent");
  });
});

describe("rollbackSummary", () => {
  it("restored reads clearly", () => {
    const s = rollbackSummary({ environment: "production", live: true, url: "https://x.test", smokePassed: true });
    expect(s.toLowerCase()).toContain("restored");
    expect(s).toContain("https://x.test");
  });
  it("failed rollback is explicit", () => {
    expect(rollbackSummary({ environment: "production", live: false }).toLowerCase()).toContain("did not complete");
  });
});

describe("approvals", () => {
  it("lists pending or says nothing is waiting", () => {
    expect(approveListSummary([])).toContain("Nothing is waiting");
    const s = approveListSummary([{ id: "abc12345" }]);
    expect(s).toContain("openpouch approve abc12345");
  });
  it("approve result both ways", () => {
    expect(approveResultSummary(true)).toContain("can now be published");
    expect(approveResultSummary(false)).toContain("Not approved");
  });
  it("approval-required explains the human-only rule", () => {
    const s = approvalRequiredSummary("production", "abc12345");
    expect(s).toContain("openpouch approve abc12345");
    expect(s.toLowerCase()).toContain("can't approve production");
  });
});

describe("account summaries (B3)", () => {
  it("signup (email) names the address and is jargon-free", () => {
    const s = signupEmailSummary("joey@example.com");
    expect(s).toContain("joey@example.com");
    assertPlain(s);
  });
  it("signup (github) includes the URL and is jargon-free", () => {
    const s = signupGithubSummary("https://openpouch.sh/api/auth/github/start");
    expect(s).toContain("https://openpouch.sh/api/auth/github/start");
    assertPlain(s);
  });
  it("activate reads reassuring whether or not the key was saved", () => {
    expect(activateSummary(true).toLowerCase()).toContain("saved");
    assertPlain(activateSummary(true));
    assertPlain(activateSummary(false));
  });
  it("whoami: anonymous vs signed-in, both jargon-free", () => {
    const anon = whoamiSummary({ authenticated: false });
    expect(anon.toLowerCase()).toContain("account");
    // R9.1/R9.6: point at the real signup command (works from any harness,
    // incl. MCP-only) rather than an unfulfillable "just say the word".
    expect(anon).toContain("openpouch signup");
    assertPlain(anon);
    const signedIn = whoamiSummary({ authenticated: true, tier: "pro", liveDeployments: 3, maxLive: 500 });
    expect(signedIn).toContain("pro");
    expect(signedIn).toContain("3 of your 500");
    assertPlain(signedIn);
  });
});

describe("errorSummary", () => {
  it("maps known categories to a plain lead + the fix", () => {
    const s = errorSummary("auth", "no render API key found", "Set RENDER_API_KEY.");
    expect(s.toLowerCase()).toContain("couldn't sign in");
    expect(s).toContain("Set RENDER_API_KEY.");
  });
  it("falls back to the raw message for unknown categories", () => {
    const s = errorSummary("weird", "something odd", "try again");
    expect(s).toContain("something odd");
    expect(s).toContain("try again");
  });
});
