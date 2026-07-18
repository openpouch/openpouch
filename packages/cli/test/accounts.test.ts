import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderAdapter } from "@openpouch/core";
import { RunApiError } from "@openpouch/adapter-run";
import { describe, expect, it } from "vitest";
import { activateCommand } from "../src/commands/activate.js";
import { signupCommand } from "../src/commands/signup.js";
import { whoamiCommand } from "../src/commands/whoami.js";
import { resolveProviderApiKey, type CliContext } from "../src/shared.js";

const ISSUED_KEY = "op_live_deadbeefdeadbeef_theSecretPart";

function fakeRun(extra: Record<string, unknown> = {}) {
  const base: ProviderAdapter = {
    id: "openpouch-run",
    listServices: async () => [],
    getService: async (id) => ({ id, name: id }),
    getRecentDeploys: async () => [],
    getEnvVarNames: async () => [],
    getLogs: async () => [],
    triggerDeploy: async () => {
      throw new Error("unsupported");
    },
    getDeploy: async (_s, id) => ({ id, status: "live" as const, createdAt: "t" }),
  };
  return {
    ...base,
    whoami: async () => ({
      account: { id: "acct_1", status: "active", tier: "pro", identities: [{ kind: "email", value: "joey@example.com" }], createdAt: "t" },
      tier: { name: "pro", deploysPerHour: 120, deploysPerDay: 1000, maxLiveDeployments: 500, maxBytes: 1, maxDynamic: 100 },
      usage: { liveDeployments: 3, dynamicDeployments: 1, deploysLastHour: 2, deploysLastDay: 5 },
    }),
    signupEmail: async (_email: string) => ({ accountId: "acct_new", message: "check your email" }),
    verifyEmail: async (account: string, _token: string) => ({ key: ISSUED_KEY, account: { id: account, status: "active", tier: "free", identities: [], createdAt: "t" } }),
    githubStartUrl: () => "https://openpouch.sh/api/auth/github/start",
    ...extra,
  };
}

async function emptyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openpouch-home-"));
}

describe("openpouch whoami", () => {
  it("reports anonymous when no key is configured", async () => {
    const ctx: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: await emptyHome() }, createAdapter: () => fakeRun() };
    const result = await whoamiCommand(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.json.authenticated).toBe(false);
    expect(typeof result.json.summary).toBe("string");
    expect((result.json.summary as string).toLowerCase()).toContain("account");
  });

  it("threads the API key to the adapter and reports tier + usage", async () => {
    let seenKey: string | undefined;
    const ctx: CliContext = {
      cwd: ".",
      env: { OPENPOUCH_HOME: await emptyHome(), OPENPOUCH_API_KEY: "op_live_abcdef0123456789_sek" },
      createAdapter: (_provider, apiKey) => {
        seenKey = apiKey;
        return fakeRun();
      },
    };
    const result = await whoamiCommand(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.json.authenticated).toBe(true);
    expect(seenKey).toBe("op_live_abcdef0123456789_sek");
    expect((result.json.tier as { name: string }).name).toBe("pro");
    expect((result.json.usage as { liveDeployments: number }).liveDeployments).toBe(3);
  });
});

describe("openpouch signup", () => {
  it("starts an email signup", async () => {
    const ctx: CliContext = { cwd: ".", env: {}, createAdapter: () => fakeRun() };
    const result = await signupCommand(ctx, { email: "joey@example.com" });
    expect(result.exitCode).toBe(0);
    expect(result.json.method).toBe("email");
    expect(result.json.accountId).toBe("acct_new");
    expect(result.json.summary as string).toContain("joey@example.com");
  });

  it("prints the GitHub authorize URL for --github", async () => {
    const ctx: CliContext = { cwd: ".", env: {}, createAdapter: () => fakeRun() };
    const result = await signupCommand(ctx, { github: true });
    expect(result.exitCode).toBe(0);
    expect(result.json.method).toBe("github");
    expect(result.json.startUrl).toContain("/api/auth/github/start");
  });

  it("errors with usage when no method is given", async () => {
    const ctx: CliContext = { cwd: ".", env: {}, createAdapter: () => fakeRun() };
    const result = await signupCommand(ctx, {});
    expect(result.exitCode).toBe(2);
  });

  it("gives an actionable message when the email is already registered — 409, not 'deployment expired' (cross-harness 2026-07-01, Befund K)", async () => {
    const ctx: CliContext = {
      cwd: ".",
      env: {},
      createAdapter: () =>
        fakeRun({
          signupEmail: async () => {
            throw new RunApiError(409, "exists");
          },
        }),
    };
    const result = await signupCommand(ctx, { email: "taken@example.com" });
    expect(result.exitCode).toBe(2); // usage conflict — NOT a provider outage (5)
    const err = result.json.error as { message: string; fix: string };
    expect(err.message).toContain("already exists");
    expect(err.fix).toContain("openpouch whoami");
    // the misleading deployment-expiry wording must be gone entirely
    const out = JSON.stringify(result.json);
    expect(out).not.toContain("deployment may have expired");
    expect(out).not.toContain("72h");
  });
});

describe("openpouch activate", () => {
  it("activates, saves the key to a 0600 file, and keeps the secret out of the JSON", async () => {
    const home = await emptyHome();
    const ctx: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: home }, createAdapter: () => fakeRun() };
    const result = await activateCommand(ctx, { account: "acct_new", token: "tok" });
    expect(result.exitCode).toBe(0);
    expect(result.json.saved).toBe(true);
    expect(result.json.keyPrefix).toBe("op_live_deadbeefdeadbeef");
    // R7/global rule 7: the raw secret is NOT in the structured output on success.
    expect(JSON.stringify(result.json)).not.toContain("theSecretPart");

    const keyPath = join(home, ".openpouch", "openpouch-run.key");
    expect((await readFile(keyPath, "utf8")).trim()).toBe(ISSUED_KEY);
    const mode = (await stat(keyPath)).mode;
    expect(mode & 0o077).toBe(0); // owner-only — no group/other access
  });

  it("errors with usage when account/token are missing", async () => {
    const ctx: CliContext = { cwd: ".", env: {}, createAdapter: () => fakeRun() };
    const result = await activateCommand(ctx, { account: "acct_new" });
    expect(result.exitCode).toBe(2);
  });

  // ── data-loss guard (2026-06-21 incident: activate clobbered an SSH key) ──────

  it("refuses to overwrite a private key sitting at the key path (no data loss)", async () => {
    const home = await emptyHome();
    const keyPath = join(home, ".openpouch", "openpouch-run.key");
    await mkdir(dirname(keyPath), { recursive: true });
    // Obvious fake — a PKCS#8 header (no algo tag) still triggers the activate
    // private-key sniff (`looksLikePrivateKey`), but it never matches a real-secret
    // scanner that looks for RSA/OPENSSH/EC/PGP keys (keeps the D19 pre-public scan clean).
    const PEM =
      "-----BEGIN PRIVATE KEY-----\nFAKE-TEST-KEY-not-a-real-secret\n-----END PRIVATE KEY-----\n";
    await writeFile(keyPath, PEM, { mode: 0o600 });

    const ctx: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: home }, createAdapter: () => fakeRun() };
    const result = await activateCommand(ctx, { account: "acct_new", token: "tok" });

    expect(await readFile(keyPath, "utf8")).toBe(PEM); // foreign file untouched
    expect(result.json.saved).toBe(false);
    expect(String(result.json.reason)).toContain("private key");
    // single-use token: the key must be surfaced so it is not silently lost
    expect(result.json.key).toBe(ISSUED_KEY);
    expect(result.exitCode).toBe(0);
  });

  it("refuses to overwrite any non-openpouch file at the key path", async () => {
    const home = await emptyHome();
    const keyPath = join(home, ".openpouch", "openpouch-run.key");
    await mkdir(dirname(keyPath), { recursive: true });
    const FOREIGN = "some-important-credential-value";
    await writeFile(keyPath, FOREIGN, { mode: 0o600 });

    const ctx: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: home }, createAdapter: () => fakeRun() };
    const result = await activateCommand(ctx, { account: "acct_new", token: "tok" });

    expect(await readFile(keyPath, "utf8")).toBe(FOREIGN); // untouched
    expect(result.json.saved).toBe(false);
    expect(result.json.key).toBe(ISSUED_KEY);
  });

  it("replaces an existing openpouch key and backs the old one up to .bak (0600)", async () => {
    const home = await emptyHome();
    const keyPath = join(home, ".openpouch", "openpouch-run.key");
    await mkdir(dirname(keyPath), { recursive: true });
    const OLD = "op_live_0123456789abcdef_oldSecretValue\n";
    await writeFile(keyPath, OLD, { mode: 0o600 });

    const ctx: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: home }, createAdapter: () => fakeRun() };
    const result = await activateCommand(ctx, { account: "acct_new", token: "tok" });

    expect(result.json.saved).toBe(true);
    expect((await readFile(keyPath, "utf8")).trim()).toBe(ISSUED_KEY);
    expect(await readFile(`${keyPath}.bak`, "utf8")).toBe(OLD); // prior key recoverable
    expect((await stat(`${keyPath}.bak`)).mode & 0o077).toBe(0); // 0600
  });

  it("honours OPENPOUCH_KEY_FILE for both writing (activate) and reading (resolve)", async () => {
    const home = await emptyHome();
    const custom = join(home, "nested", "creds", "my-openpouch-key");
    const env = { OPENPOUCH_HOME: home, OPENPOUCH_KEY_FILE: custom };
    const ctx: CliContext = { cwd: ".", env, createAdapter: () => fakeRun() };

    const result = await activateCommand(ctx, { account: "acct_new", token: "tok" });
    expect(result.json.saved).toBe(true);
    expect(result.json.keyPath).toBe(custom);
    expect((await readFile(custom, "utf8")).trim()).toBe(ISSUED_KEY);

    // the reader resolves from the same override → deploys find the key again
    expect(await resolveProviderApiKey(env, "openpouch-run")).toBe(ISSUED_KEY);
  });

  it("honours --key-file for the write path", async () => {
    const home = await emptyHome();
    const custom = join(home, "flag-located.key");
    const ctx: CliContext = { cwd: ".", env: { OPENPOUCH_HOME: home }, createAdapter: () => fakeRun() };

    const result = await activateCommand(ctx, { account: "acct_new", token: "tok", keyFile: custom });
    expect(result.json.saved).toBe(true);
    expect(result.json.keyPath).toBe(custom);
    expect((await readFile(custom, "utf8")).trim()).toBe(ISSUED_KEY);
  });
});
