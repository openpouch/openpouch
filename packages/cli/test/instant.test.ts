import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@openpouch/core";
import { describe, expect, it } from "vitest";
import { collectDotenvExcludes, instantCommand } from "../src/commands/instant.js";
import type { CliContext } from "../src/shared.js";

/** A ProviderAdapter mock that also carries the instant-lane primitive. */
function mockRunAdapter() {
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
    getDeploy: async (_s, id) => ({ id, status: "live", createdAt: "2026-06-12T00:00:00.000Z" }),
  };
  return {
    ...base,
    instantDeploy: async (_tarball: Uint8Array, opts?: { projectHint?: string }) => ({
      id: `${opts?.projectHint ?? "joey"}-zzz999`,
      slug: `${opts?.projectHint ?? "joey"}-zzz999`,
      url: `https://${opts?.projectHint ?? "joey"}-zzz999.openpouch.sh`,
      claimUrl: "https://openpouch.sh/claim/x-zzz999?token=tok",
      claimToken: "tok",
      expiresAt: "2026-06-15T00:00:00.000Z",
      status: "live" as const,
    }),
  };
}

/** A deterministic post-deploy health probe — GET / returns 200 (no network). */
const healthyProbe = async () => ({ healthy: true, status: 200, detail: "received 200" });

async function tmpProject(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "opdeploy-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  return dir;
}

describe("openpouch deploy (instant lane)", () => {
  it("deploys, then writes manifest + policy + evidence back into the repo", async () => {
    const cwd = await tmpProject("@scope/cool-site");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.json.ok).toBe(true);
    const dep = result.json.deployment as { slug?: string; url: string; claimUrl: string };
    expect(dep.url).toBe("https://cool-site-zzz999.openpouch.sh"); // scope stripped from hint

    // R5: the live link is the primary result — promoted to the top level, ready to share.
    expect(result.json.url).toBe("https://cool-site-zzz999.openpouch.sh");
    expect(result.json.claimUrl).toBe("https://openpouch.sh/claim/x-zzz999?token=tok");
    // The claim link carries a secret token — flagged private so agents don't leak it (OpenClaw 2026-06-29).
    expect(result.json.claimUrlIsPrivate).toBe(true);
    // A live (static) deploy is reachable immediately — not flagged pending (R9.10),
    // and the post-deploy GET / check confirms it's healthy (P0).
    expect(result.json.pending).toBe(false);
    expect(result.json.healthStatus).toBe("healthy");
    expect(result.json.nextStep).toBeUndefined();
    expect(result.json.dataDurability).toBeUndefined(); // this app writes no local data (L10)
    // R3: a plain-language summary the agent relays to a non-technical human.
    expect(typeof result.json.summary).toBe("string");
    expect(result.json.summary as string).toContain("https://cool-site-zzz999.openpouch.sh");
    expect(result.json.summary as string).toContain("cool-site"); // the app name, in plain words
    expect(result.human.join("\n")).toContain(result.json.summary as string); // echoed to terminal users too
    // Field-named hand-off (user feedback #1, 2026-07-15/16): agents trimmed the
    // summary in free runs — `tellYourUser` carries URL, exact expiry date, every
    // keep option incl. the price, and never the claim link/token.
    const tell = result.json.tellYourUser as string;
    expect(tell).toContain("https://cool-site-zzz999.openpouch.sh");
    expect(tell).toContain("$15/month");
    expect(tell).toContain("openpouch.dev/pricing");
    expect(tell).not.toContain("token");
    expect(tell).not.toContain("openpouch.sh/claim");

    const manifest = JSON.parse(await readFile(join(cwd, "deploy.manifest.json"), "utf8"));
    expect(manifest.environments.preview.provider).toBe("openpouch-run");
    expect(manifest.environments.preview.serviceId).toBe("cool-site-zzz999");

    const evidenceRaw = await readFile(join(cwd, "deploy.evidence.json"), "utf8");
    const evidence = JSON.parse(evidenceRaw);
    expect(evidence.deployments[0].provider).toBe("openpouch-run");
    expect(evidence.deployments[0].environment).toBe("preview");
    // Fix B: the claim token must NOT be committed to evidence — the notes redact
    // it to a pointer, and the real link is persisted privately in .openpouch/claim.json.
    expect(evidenceRaw).not.toContain("token=");
    expect(evidence.deployments[0].notes).toContain(".openpouch/claim.json");
    const claim = JSON.parse(await readFile(join(cwd, ".openpouch", "claim.json"), "utf8"));
    expect(claim.claimUrl).toBe("https://openpouch.sh/claim/x-zzz999?token=tok");
    expect(claim.claimToken).toBe("tok");
    // …and .openpouch/ is gitignored so the private link never enters git history.
    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toContain(".openpouch/");

    const md = await readFile(join(cwd, "DEPLOYMENT.md"), "utf8");
    expect(md).toContain("cool-site-zzz999.openpouch.sh");
    // H4: DEPLOYMENT.md carries a resume checklist so an agent recovers after context loss.
    expect(md).toContain("## Resume after context loss");
    // F-02 (Codex 2026-07-12): resume commands must run in a FRESH shell that may
    // have no global binary — the npx form works everywhere.
    expect(md).toContain("npx -y openpouch verify --json");
    expect(md).toContain(".openpouch/claim.json");
  });

  it("--redact-secrets omits the claim link from the result but still saves it privately (Codex/OpenClaw 2026-07-02)", async () => {
    const cwd = await tmpProject("redacted");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { redactSecrets: true });

    expect(result.exitCode).toBe(0);
    // The claim token is gone from the machine result (top-level + nested)…
    expect(result.json.claimUrl).toBeUndefined();
    expect(result.json.claimUrlRedacted).toBe(true);
    expect(result.json.claimUrlIsPrivate).toBe(true);
    expect((result.json.deployment as { claimUrl?: string }).claimUrl).toBeUndefined();
    // …so the whole result (and the human lines) is safe to paste — no token anywhere…
    expect(JSON.stringify(result.json)).not.toContain("token=");
    expect(result.human.join("\n")).not.toContain("token=");
    expect(result.human.join("\n")).toContain(".openpouch/claim.json");
    // …and the relayable summary SAYS the link was redacted + where it lives (Codex 2026-07-04)
    expect(result.json.summary as string).toContain("deliberately left out");
    expect(result.json.summary as string).toContain(".openpouch/claim.json");
    // …but the real link is still saved locally (0600) so nothing is lost.
    const claim = JSON.parse(await readFile(join(cwd, ".openpouch", "claim.json"), "utf8"));
    expect(claim.claimUrl).toBe("https://openpouch.sh/claim/x-zzz999?token=tok");
  });

  it("account-owned deploy (run-d 0.3.1+): no claim fields, account summary, no claim.json (Codex F-01, 2026-07-12)", async () => {
    const cwd = await tmpProject("owned");
    const ownedAdapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => ({
        id: "owned-abc123",
        slug: "owned-abc123",
        url: "https://owned-abc123.openpouch.sh",
        ownership: "account" as const,
        expiryPolicy: "rolling-while-used" as const,
        expiresAt: "2026-10-10T00:00:00.000Z",
        status: "live" as const,
      }),
    };
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => ownedAdapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx);

    expect(result.exitCode).toBe(0);
    // Ownership + expiry semantics pass straight through from the server.
    expect(result.json.ownership).toBe("account");
    expect(result.json.expiryPolicy).toBe("rolling-while-used");
    // NO claim fields on an owned deploy — the app is already saved.
    expect(result.json.claimUrl).toBeUndefined();
    expect(result.json.claimUrlRedacted).toBeUndefined();
    expect(result.json.claimUrlIsPrivate).toBeUndefined();
    expect((result.json.deployment as { claimUrl?: string }).claimUrl).toBeUndefined();
    // The summary tells the rolling account story, never the anonymous one (K11).
    const summary = result.json.summary as string;
    expect(summary).toContain("as long as it's being used");
    expect(summary).not.toContain("72 hours");
    expect(summary).not.toContain("temporary preview");
    // No claim link exists → nothing may be written to .openpouch/claim.json.
    await expect(readFile(join(cwd, ".openpouch", "claim.json"), "utf8")).rejects.toThrow();
    // Human lines: rolling expiry wording, no claim line.
    const human = result.human.join("\n");
    expect(human).toContain("rolls forward");
    expect(human).not.toContain("claim:");
    // Owned hand-off tells the rolling story, pitch-free (user feedback #1).
    const tell = result.json.tellYourUser as string;
    expect(tell).toContain("saved to your openpouch account");
    expect(tell).not.toContain("$15");
    expect(tell).not.toContain("pricing");
  });

  it("nextCommands keep the npx form when invoked via npx (npm_command=exec) (Codex F-02, 2026-07-12)", async () => {
    const cwd = await tmpProject("npxform");
    const ctx: CliContext = { cwd, env: { npm_command: "exec" }, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);

    expect(result.exitCode).toBe(0);
    const next = result.json.nextCommands as { verify: string; logs: string; inspect: string };
    expect(next.verify.startsWith("npx -y openpouch verify --json")).toBe(true);
    expect(next.logs).toBe("npx -y openpouch logs --json --limit 120");
    expect(next.inspect).toBe("npx -y openpouch inspect --json");
  });

  it("refuses when a manifest already exists (governed lanes apply)", async () => {
    const cwd = await tmpProject("already");
    await writeFile(
      join(cwd, "deploy.manifest.json"),
      JSON.stringify({ version: 0, project: { name: "already" }, environments: { production: { provider: "render", serviceId: "srv-1" } } }),
    );
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(2); // usage
    expect((result.json.error as { message: string }).message).toContain("already has");
  });

  it("redeploys when the existing manifest is an instant-lane manifest", async () => {
    // After a first `deploy`, the repo holds an instant-lane manifest (provider
    // openpouch-run). A second `deploy` must redeploy, not block — agents
    // iterate deploy -> fix -> deploy, and the instant lane has no separate
    // redeploy primitive.
    const cwd = await tmpProject("iterate");
    await writeFile(
      join(cwd, "deploy.manifest.json"),
      JSON.stringify({ version: 0, project: { name: "iterate" }, environments: { preview: { provider: "openpouch-run", serviceId: "iterate-old", url: "https://iterate-old.openpouch.sh" } } }),
    );
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(0); // redeployed, not blocked
    expect(result.json.url).toBe("https://iterate-zzz999.openpouch.sh");
    const manifest = JSON.parse(await readFile(join(cwd, "deploy.manifest.json"), "utf8"));
    expect(manifest.environments.preview.serviceId).toBe("iterate-zzz999"); // rewritten to the new deploy
  });

  it("deploys an explicit subfolder — `npm run build && openpouch deploy dist`", async () => {
    const cwd = await tmpProject("vite-app");
    await mkdir(join(cwd, "dist"), { recursive: true });
    await writeFile(join(cwd, "dist", "index.html"), "<h1>built</h1>");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, "dist");
    expect(result.exitCode).toBe(0);
    // the project name (hint) comes from the root package.json, not dist/
    expect(result.json.url).toBe("https://vite-app-zzz999.openpouch.sh");
  });

  it("refuses to deploy an unbuilt frontend (no path) and points at the build output", async () => {
    const cwd = await tmpProject("vite-app");
    await writeFile(join(cwd, "index.html"), '<!doctype html><script type="module" src="/src/main.jsx"></script>');
    await mkdir(join(cwd, "dist"), { recursive: true });
    await writeFile(join(cwd, "dist", "index.html"), "<h1>built</h1>");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx); // no explicit dir → guard applies
    expect(result.exitCode).toBe(2); // usage
    const err = result.json.error as { message: string; fix: string; suggestedCommand?: string };
    expect(err.message).toContain("unbuilt frontend");
    expect(err.fix).toContain("openpouch deploy dist");
    // R9: machine-readable next command so an agent need not parse the prose fix
    expect(err.suggestedCommand).toBe("openpouch deploy dist");
  });

  it("unbuilt frontend with no build dir suggests `openpouch deploy .` (server-side build)", async () => {
    const cwd = await tmpProject("vite-app");
    await writeFile(join(cwd, "index.html"), '<!doctype html><script type="module" src="/src/main.jsx"></script>');
    // no dist/ — the way forward is build-on-deploy via an explicit path
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx); // no explicit dir → guard applies
    expect(result.exitCode).toBe(2);
    const err = result.json.error as { suggestedCommand?: string };
    expect(err.suggestedCommand).toBe("openpouch deploy .");
  });

  it("an explicit path bypasses the unbuilt guard (`deploy .` forces the folder)", async () => {
    const cwd = await tmpProject("vite-app");
    await writeFile(join(cwd, "index.html"), '<!doctype html><script type="module" src="/src/main.jsx"></script>');
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, "."); // explicit → no guard
    expect(result.exitCode).toBe(0);
  });

  it("a full-stack app (server entry + Vite frontend) is NOT blocked — deploys whole app", async () => {
    // OpenClaw cross-harness finding: Express API + Vite frontend. The dev index.html
    // references /src/, but there is a `start` script + server.js → it's a dynamic app.
    // `deploy dist` would drop the backend, so `openpouch deploy` (no path) must ship
    // the whole folder (run-d builds the frontend + runs the server), not refuse.
    const cwd = await mkdtemp(join(tmpdir(), "opdeploy-"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "fullstack", devDependencies: { vite: "^5" }, scripts: { build: "vite build", start: "node server.js" } }),
    );
    await writeFile(join(cwd, "index.html"), '<!doctype html><script type="module" src="/src/main.jsx"></script>');
    await writeFile(join(cwd, "server.js"), "// express server");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx); // no explicit path → guard must NOT fire
    expect(result.exitCode).toBe(0);
  });

  it("flags a still-building dynamic deploy so the agent waits before sharing (R9.10)", async () => {
    // instantDeploy is a single POST: a dynamic app's container may still be
    // `building`. The deploy succeeds (exit 0, URL returned) but the URL isn't
    // confirmed reachable — surface that instead of handing over a 502 link.
    const cwd = await tmpProject("api");
    const buildingAdapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => ({
        id: "api-bld111",
        slug: "api-bld111",
        url: "https://api-bld111.openpouch.sh",
        claimUrl: "https://openpouch.sh/claim/api-bld111?token=tok",
        claimToken: "tok",
        expiresAt: "2026-06-15T00:00:00.000Z",
        status: "building" as const,
        kind: "dynamic" as const,
      }),
    };
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => buildingAdapter };
    const result = await instantCommand(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.json.url).toBe("https://api-bld111.openpouch.sh"); // URL still returned
    expect(result.json.pending).toBe(true);
    expect(result.json.nextStep as string).toContain("openpouch verify");
    // human + summary both tell the operator/agent it's still coming up
    expect((result.json.summary as string).toLowerCase()).toContain("being deployed");
    expect(result.human.join("\n")).toContain("still starting");
  });

  it("records the source commit when the project is a git repo (P2)", async () => {
    const cwd = await tmpProject("tracked");
    // a local repo with no remote — `git rev-parse HEAD` still resolves
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
    git("init");
    git("add", ".");
    git("commit", "-m", "init");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".");
    expect(result.exitCode).toBe(0);

    const evidence = JSON.parse(await readFile(join(cwd, "deploy.evidence.json"), "utf8"));
    expect(evidence.deployments[0].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does NOT record a commit for an untracked deploy dir inside an ancestor repo (OpenClaw 2026-06-29)", async () => {
    // The parent workspace IS a git repo; the app sits in an UNTRACKED subfolder —
    // `git rev-parse HEAD` would resolve to the workspace's commit, which has nothing
    // to do with the deployed files. Recording it = false audit assurance, so it must be absent.
    const workspace = await mkdtemp(join(tmpdir(), "opws-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: workspace, stdio: "ignore" });
    git("init");
    await writeFile(join(workspace, "README.md"), "workspace\n");
    git("add", ".");
    git("commit", "-m", "workspace");
    const cwd = join(workspace, "app");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "untracked-app" }));
    await writeFile(join(cwd, "index.html"), "<h1>hi</h1>");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".");
    expect(result.exitCode).toBe(0);
    const evidence = JSON.parse(await readFile(join(cwd, "deploy.evidence.json"), "utf8"));
    expect(evidence.deployments[0].commit).toBeUndefined();
  });

  it("passes --var env to the deploy but surfaces NAMES only — values never leak (D7)", async () => {
    const cwd = await tmpProject("envapp");
    const m = mockRunAdapter();
    let seenEnv: Record<string, string> | undefined;
    const adapter = {
      ...m,
      instantDeploy: async (t: Uint8Array, o?: { projectHint?: string; env?: Record<string, string> }) => {
        seenEnv = o?.env;
        return m.instantDeploy(t, o);
      },
    };
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".", { vars: ["API_KEY=s3cr3t", "DB_URL=postgres://x"] });
    expect(result.exitCode).toBe(0);
    // The values reached the adapter (→ run-d → container).
    expect(seenEnv).toEqual({ API_KEY: "s3cr3t", DB_URL: "postgres://x" });
    // Only NAMES surface; the values appear nowhere in the json or human output.
    expect(result.json.envVars).toEqual(["API_KEY", "DB_URL"]);
    const out = JSON.stringify(result.json) + result.human.join("\n");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("postgres://x");
    expect(out).toContain("API_KEY"); // the name is fine to show
  });

  it("reads --env-file (dotenv); --var overrides the file; comments/quotes handled", async () => {
    const cwd = await tmpProject("envfile");
    await writeFile(join(cwd, ".env"), '# a comment\nFOO=fromfile\nBAR="quoted"\n\nBAZ=keep\n');
    const m = mockRunAdapter();
    let seenEnv: Record<string, string> | undefined;
    const adapter = {
      ...m,
      instantDeploy: async (t: Uint8Array, o?: { projectHint?: string; env?: Record<string, string> }) => {
        seenEnv = o?.env;
        return m.instantDeploy(t, o);
      },
    };
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".", { envFile: ".env", vars: ["FOO=override"] });
    expect(result.exitCode).toBe(0);
    expect(seenEnv).toEqual({ FOO: "override", BAR: "quoted", BAZ: "keep" });
  });

  it("rejects a bad env var name without leaking the value (D7)", async () => {
    const cwd = await tmpProject("badenv");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".", { vars: ["1BAD=topsecret"] });
    expect(result.exitCode).toBe(2); // EXIT.USAGE
    expect(JSON.stringify(result.json)).not.toContain("topsecret");
  });

  it("rejects the reserved keys PORT/HOME (the runtime drops them; accepting would mislead)", async () => {
    const cwd = await tmpProject("reservedenv");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    for (const reserved of ["PORT=3000", "HOME=/tmp"]) {
      const result = await instantCommand(ctx, ".", { vars: [reserved] });
      expect(result.exitCode).toBe(2); // EXIT.USAGE
      expect(JSON.stringify(result.json)).toContain("reserved");
    }
  });

  it("detects and records the framework + build/start (no more framework:null — P1)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdeploy-"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "shop", devDependencies: { vite: "^5" }, scripts: { build: "vite build", start: "node server.js" } }),
    );
    await writeFile(join(cwd, "index.html"), "<h1>hi</h1>");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".");

    expect(result.exitCode).toBe(0);
    const dep = result.json.deployment as { framework?: string | null; buildCommand?: string; startCommand?: string };
    expect(dep.framework).toBe("vite");
    expect(dep.buildCommand).toBe("vite build");
    expect(dep.startCommand).toBe("node server.js");
    // …and the recorded manifest carries it so `openpouch inspect` isn't framework:null.
    const manifest = JSON.parse(await readFile(join(cwd, "deploy.manifest.json"), "utf8"));
    expect(manifest.project.framework).toBe("vite");
    expect(manifest.build).toEqual({ buildCommand: "vite build", startCommand: "node server.js" });
  });

  it("warns that locally-stored data is ephemeral on a preview (L10 detect-and-surface)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdeploy-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "notes-api", dependencies: { "better-sqlite3": "^9" } }));
    await writeFile(join(cwd, "index.html"), "<h1>notes</h1>");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, "."); // explicit dir → no unbuilt guard

    expect(result.exitCode).toBe(0);
    const dd = result.json.dataDurability as { storesData: boolean; ephemeral: boolean; signals: string[] };
    expect(dd).toMatchObject({ storesData: true, ephemeral: true });
    expect(dd.signals).toContain("SQLite database (better-sqlite3)");
    // the human-facing summary spells out that the data won't survive (R3)
    expect((result.json.summary as string).toLowerCase()).toContain("saves data");
    expect((result.json.summary as string).toLowerCase()).toContain("not kept");
    expect(result.human.join("\n")).toContain("saves data locally");
  });

  it("flags a live-but-unhealthy deploy as degraded so the agent fixes it before sharing (P0)", async () => {
    // The container reports `live`, but GET / returns 404 (e.g. an Express server
    // serving an unbuilt React dist/). The deploy "succeeds" — but handing this
    // URL to a human means relaying a dead link. We must surface it.
    const cwd = await tmpProject("broken");
    const ctx: CliContext = {
      cwd,
      // tiny budget so the poll loop exits fast on the (permanent) non-200
      env: { OPENPOUCH_INSTANT_SMOKE_TIMEOUT_MS: "20" },
      createAdapter: () => mockRunAdapter(), // adapter says status: "live"
      probeUrl: async () => ({ healthy: false, status: 404, detail: "received 404" }),
    };
    const result = await instantCommand(ctx);

    expect(result.exitCode).toBe(0); // the container IS live → the deploy didn't fail
    expect(result.json.ok).toBe(true);
    expect(result.json.pending).toBe(false); // it's up, just not healthy (≠ still starting)
    expect(result.json.healthStatus).toBe("degraded");
    expect(result.json.nextStep as string).toContain("openpouch logs");
    expect((result.json.deployment as { httpStatus?: number }).httpStatus).toBe(404);
    // The summary must NOT invite sharing the dead link.
    expect(result.json.summary as string).not.toContain("anyone");
    expect((result.json.summary as string).toLowerCase()).toContain("isn't loading");
    expect(result.human.join("\n")).toContain("verify before sharing");
    // No hand-off block on a broken deploy — a dead URL is not handed over (R9).
    expect(result.json.tellYourUser).toBeUndefined();
  });

  it("OPENPOUCH_INSTANT_SMOKE_TIMEOUT_MS=0 disables the health check (reports healthy, no probe)", async () => {
    const cwd = await tmpProject("nocheck");
    let probed = false;
    const ctx: CliContext = {
      cwd,
      env: { OPENPOUCH_INSTANT_SMOKE_TIMEOUT_MS: "0" },
      createAdapter: () => mockRunAdapter(),
      probeUrl: async () => {
        probed = true;
        return { healthy: false, status: 500, detail: "received 500" };
      },
    };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(0);
    expect(probed).toBe(false); // budget 0 → never probes
    expect(result.json.healthStatus).toBe("healthy");
  });

  it("does not pack openpouch's own deploy artifacts into the upload bundle (Fix F, Codex 2026-07-01)", async () => {
    // A follow-up deploy: artifacts from a prior deploy already sit in the folder.
    // They belong in the repo, but must not be re-uploaded (file count grew 17->20).
    const cwd = await tmpProject("repack");
    await writeFile(join(cwd, "deploy.manifest.json"), "{}");
    await writeFile(join(cwd, "deploy.policy.json"), "{}");
    await writeFile(join(cwd, "deploy.evidence.json"), '{"version":0,"deployments":[]}');
    await writeFile(join(cwd, "DEPLOYMENT.md"), "# old");
    let captured: Uint8Array | undefined;
    const m = mockRunAdapter();
    const adapter = {
      ...m,
      instantDeploy: async (t: Uint8Array, o?: { projectHint?: string; env?: Record<string, string> }) => {
        captured = t;
        return m.instantDeploy(t, o);
      },
    };
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, "."); // explicit dir → deploy this folder as-is
    expect(result.exitCode).toBe(0);
    // Inspect the ACTUAL uploaded tarball (real tar, not mocked).
    const tarPath = join(cwd, "captured.tgz");
    await writeFile(tarPath, Buffer.from(captured!));
    const entries = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" })
      .split("\n")
      .map((e) => e.replace(/^\.\//, "").replace(/\/$/, ""));
    expect(entries).toContain("package.json"); // real source is still packed
    for (const artifact of ["deploy.manifest.json", "deploy.policy.json", "deploy.evidence.json", "DEPLOYMENT.md"]) {
      expect(entries).not.toContain(artifact);
    }
  });

  it("never packs dotenv secrets (root OR nested) or the --env-file into the upload bundle (would be served publicly)", async () => {
    const cwd = await tmpProject("dotenv");
    await writeFile(join(cwd, ".env"), "STRIPE_SECRET=sk_live_topsecret");
    await writeFile(join(cwd, ".env.production"), "DB_URL=postgres://prod");
    await writeFile(join(cwd, "custom.secrets"), "TOKEN=abc"); // pointed at by --env-file
    // Nested dotenv — the `./.env` glob only anchors at the root on GNU tar, so
    // without exact-path excludes this would leak on a Linux client (verified).
    await mkdir(join(cwd, "packages", "api"), { recursive: true });
    await writeFile(join(cwd, "packages", "api", ".env"), "NESTED_SECRET=sk_live_nested");
    let captured: Uint8Array | undefined;
    const m = mockRunAdapter();
    const adapter = {
      ...m,
      instantDeploy: async (t: Uint8Array, o?: { projectHint?: string; env?: Record<string, string> }) => {
        captured = t;
        return m.instantDeploy(t, o);
      },
    };
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, ".", { envFile: "custom.secrets" });
    expect(result.exitCode).toBe(0);
    const tarPath = join(cwd, "captured-env.tgz");
    await writeFile(tarPath, Buffer.from(captured!));
    const entries = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" })
      .split("\n")
      .map((e) => e.replace(/^\.\//, "").replace(/\/$/, ""));
    expect(entries).toContain("package.json"); // real source still packed
    for (const secret of [".env", ".env.production", "custom.secrets", "packages/api/.env"]) {
      expect(entries).not.toContain(secret);
    }
  });

  it("collectDotenvExcludes finds dotenv files at any depth and skips dependency dirs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdotenv-"));
    await writeFile(join(cwd, ".env"), "A=1");
    await writeFile(join(cwd, ".env.production"), "B=2");
    await mkdir(join(cwd, "packages", "api"), { recursive: true });
    await writeFile(join(cwd, "packages", "api", ".env"), "C=3");
    await mkdir(join(cwd, "sub"), { recursive: true });
    await writeFile(join(cwd, "sub", ".env.local"), "D=4");
    // Inside a skipped dependency dir → must NOT be reported (already excluded wholesale).
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "pkg", ".env"), "IGNORED=1");
    // Not a dotenv secret → left alone.
    await writeFile(join(cwd, "src.env.js"), "// not a dotenv file");

    const excludes = (await collectDotenvExcludes(cwd)).sort();
    expect(excludes).toEqual(
      ["./.env", "./.env.production", "./packages/api/.env", "./sub/.env.local"].sort(),
    );
  });

  it("reports authenticated:false for an anonymous deploy (Fix G, Codex 2026-07-01)", async () => {
    const cwd = await tmpProject("anon");
    // Isolate OPENPOUCH_HOME to an empty dir so no real key file on this machine is picked up.
    const home = await mkdtemp(join(tmpdir(), "ophome-"));
    const ctx: CliContext = { cwd, env: { OPENPOUCH_HOME: home }, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.json.authenticated).toBe(false);
  });

  it("reports authenticated:true when an openpouch API key is set — and never echoes it (Fix G)", async () => {
    const cwd = await tmpProject("keyed");
    const ctx: CliContext = { cwd, env: { OPENPOUCH_API_KEY: "op_live_secret" }, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.json.authenticated).toBe(true);
    const out = JSON.stringify(result.json) + result.human.join("\n");
    expect(out).not.toContain("op_live_secret"); // the key itself never appears in output
  });
});

describe("openpouch deploy --health-path (OpenClaw 2026-07-04)", () => {
  it("probes the extra path after `/`, reports it, and records it in manifest + evidence", async () => {
    const cwd = await tmpProject("api-app");
    const probed: string[] = [];
    const ctx: CliContext = {
      cwd,
      env: {},
      createAdapter: () => mockRunAdapter(),
      probeUrl: async (url) => {
        probed.push(url);
        return { healthy: true, status: 200, detail: "received 200" };
      },
    };
    const result = await instantCommand(ctx, undefined, { healthPath: "/api/health" });
    expect(result.exitCode).toBe(0);
    expect(result.json.healthStatus).toBe("healthy");
    expect(result.json.healthPathCheck).toEqual({ path: "/api/health", passed: true, httpStatus: 200 });
    // the extra path was actually probed (same seam as the `/` gate)
    expect(probed).toContain("https://api-app-zzz999.openpouch.sh/api/health");
    // recorded truth: verify re-checks the same path via the manifest healthcheck
    const manifest = JSON.parse(await readFile(join(cwd, "deploy.manifest.json"), "utf8"));
    expect(manifest.healthcheck).toEqual({ path: "/api/health", expectStatus: 200, timeoutMs: 10000 });
    const evidence = JSON.parse(await readFile(join(cwd, "deploy.evidence.json"), "utf8"));
    expect(evidence.deployments[0].healthPath).toBe("/api/health");
  });

  it("degrades when `/` answers but the health path doesn't (live shell, dead API)", async () => {
    const cwd = await tmpProject("shell-up");
    const ctx: CliContext = {
      cwd,
      env: {},
      createAdapter: () => mockRunAdapter(),
      probeUrl: async (url) =>
        url.endsWith("/api/health")
          ? { healthy: false, status: 404, detail: "received 404" }
          : { healthy: true, status: 200, detail: "received 200" },
    };
    const result = await instantCommand(ctx, undefined, { healthPath: "/api/health" });
    expect(result.exitCode).toBe(0); // the deploy itself succeeded — health is reported, not hidden
    expect(result.json.healthStatus).toBe("degraded");
    expect((result.json.healthPathCheck as { passed: boolean }).passed).toBe(false);
    expect(result.json.nextStep as string).toContain("/api/health");
    expect(result.human.join("\n")).toContain("/api/health");
    const evidence = JSON.parse(await readFile(join(cwd, "deploy.evidence.json"), "utf8"));
    expect(evidence.deployments[0].healthStatus).toBe("degraded");
  });
});

describe("copyable next commands + health-path-aware resume (OpenClaw 2026-07-05)", () => {
  it("deploy JSON carries nextCommands, health-path aware, and DEPLOYMENT.md resume uses the exact verify command", async () => {
    const cwd = await tmpProject("next-cmds");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { healthPath: "/api/health" });
    expect(result.exitCode).toBe(0);
    // #4: mechanical follow-ups — no flag reconstruction needed in agent loops
    expect(result.json.nextCommands).toEqual({
      verify: "openpouch verify --json --health-path /api/health",
      logs: "openpouch logs --json --limit 120",
      inspect: "openpouch inspect --json",
    });
    // #3: the resume checklist + self-repair runbook name the exact command
    const md = await readFile(join(cwd, "DEPLOYMENT.md"), "utf8");
    const hits = md.split("openpouch verify --json --health-path /api/health").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2); // resume checklist + self-repair step 4
    expect(md).toContain("manifest healthcheck is applied automatically");
  });

  it("without a health path, nextCommands and the resume checklist stay generic", async () => {
    const cwd = await tmpProject("next-cmds-plain");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, {});
    expect(result.exitCode).toBe(0);
    expect((result.json.nextCommands as { verify: string }).verify).toBe("openpouch verify --json");
    const md = await readFile(join(cwd, "DEPLOYMENT.md"), "utf8");
    // DEPLOYMENT.md always uses the npx form — a fresh session may have no
    // global binary (Codex F-02, 2026-07-12); nextCommands above stay bare
    // because THIS invocation didn't come through npx (npm_command unset).
    expect(md).toContain("`npx -y openpouch verify --json` — health-check the live URL (GET / expects 200)");
  });
});

describe("evidence deploy context (OpenClaw 2026-07-04)", () => {
  it("records cliVersion/kind/health/expiry/env-var names and renders them in DEPLOYMENT.md", async () => {
    const cwd = await tmpProject("ctx-rich");
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { vars: ["GREETING=hi"] });
    expect(result.exitCode).toBe(0);
    const evidence = JSON.parse(await readFile(join(cwd, "deploy.evidence.json"), "utf8"));
    const rec = evidence.deployments[0] as Record<string, unknown>;
    expect(rec.cliVersion).toBe("0.0.0-dev"); // the dev fallback; the release bundle injects the real one
    expect(rec.kind).toBe("static");
    expect(rec.healthStatus).toBe("healthy");
    expect(rec.expiresAt).toBe("2026-06-15T00:00:00.000Z");
    expect(rec.envVarNames).toEqual(["GREETING"]); // names only — the value stays out
    expect(JSON.stringify(evidence)).not.toContain("hi\""); // value never lands in evidence
    const md = await readFile(join(cwd, "DEPLOYMENT.md"), "utf8");
    expect(md).toContain("## Deploy details");
    expect(md).toContain("CLI: openpouch 0.0.0-dev");
    expect(md).toContain("Env vars (names only — values never recorded): GREETING");
    expect(md).toContain("Expires: 2026-06-15T00:00:00.000Z");
  });
});

describe("openpouch deploy — failure-path legibility (OpenClaw suite run 2026-07-05)", () => {
  it("stops locally with a usage error when package.json is invalid JSON — nothing is uploaded, no quota spent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opdeploy-brokenpkg-"));
    await writeFile(join(dir, "package.json"), "{ invalid json\n");
    let uploads = 0;
    const adapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => {
        uploads++;
        throw new Error("must not be reached");
      },
    };
    const ctx: CliContext = { cwd: dir, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(2);
    const err = result.json.error as { category: string; message: string; fix: string };
    expect(err.category).toBe("usage");
    expect(err.message).toContain("package.json is not valid JSON");
    expect(err.fix).toContain("Fix the JSON syntax");
    expect(uploads).toBe(0);
  });

  it("stops locally with a usage error for an empty directory — nothing is uploaded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opdeploy-empty-"));
    let uploads = 0;
    const adapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => {
        uploads++;
        throw new Error("must not be reached");
      },
    };
    const ctx: CliContext = { cwd: dir, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(2);
    const err = result.json.error as { category: string; message: string };
    expect(err.category).toBe("usage");
    expect(err.message).toContain("no files to deploy");
    expect(uploads).toBe(0);
  });

  it("surfaces the server's captured build/startup output as error.failureLogs on a failed dynamic deploy", async () => {
    const dir = await tmpProject("crashy-app");
    class FakeRunApiError extends Error {
      readonly category = "provider";
      readonly status = 422;
      readonly fix =
        "Your app failed while building or starting on the server — the captured output is included in this error. Fix the cause it shows, then rerun the same deploy command (each redeploy gets a fresh URL).";
      readonly serverLogs = "[install] added 94 packages\n[build] vite ok\n[app] Error: boom at server.js:2\n";
      constructor() {
        super("openpouch-run 422: dynamic deploy failed: app did not answer HTTP in time");
      }
    }
    const adapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => {
        throw new FakeRunApiError();
      },
    };
    const ctx: CliContext = { cwd: dir, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(5);
    const err = result.json.error as { category: string; fix: string; failureLogs?: string[] };
    expect(err.category).toBe("provider");
    // the CAUSE travels with the error — the failed record is gone server-side (self-repair, P1)
    expect(err.failureLogs).toBeDefined();
    expect(err.failureLogs!.some((l) => l.includes("Error: boom at server.js:2"))).toBe(true);
    expect(result.human.join("\n")).toContain("Error: boom at server.js:2");
  });

  it("maps the server's empty-upload 400 to a usage error (backstop behind the local preflight)", async () => {
    const dir = await tmpProject("weird-app");
    class FakeNoFilesError extends Error {
      readonly category = "provider";
      readonly status = 400;
      readonly fix = "The uploaded folder contained no deployable files. Point the deploy at a folder with content — an index.html (static site) or a package.json project — then rerun.";
      constructor() {
        super("openpouch-run 400: tarball contained no files");
      }
    }
    const adapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => {
        throw new FakeNoFilesError();
      },
    };
    const ctx: CliContext = { cwd: dir, env: {}, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(2);
    expect((result.json.error as { category: string }).category).toBe("usage");
  });
});

describe("openpouch deploy --app — stable URLs across redeploys (L12)", () => {
  function appAdapter(echo: { app?: string; updated?: boolean; ownership?: "account" }) {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = {
      ...mockRunAdapter(),
      instantDeploy: async (_t: Uint8Array, opts?: Record<string, unknown>) => {
        calls.push(opts ?? {});
        return {
          id: "shop-a1b2c3",
          slug: "shop-a1b2c3",
          url: "https://shop-a1b2c3.openpouch.sh",
          expiresAt: "2026-10-15T00:00:00.000Z",
          status: "live" as const,
          ...(echo.ownership !== undefined ? { ownership: echo.ownership, expiryPolicy: "rolling-while-used" as const } : {}),
          ...(echo.app !== undefined ? { app: echo.app, updated: echo.updated === true } : {}),
        };
      },
    };
    return { adapter, calls };
  }

  it("refuses --app without an account LOCALLY (usage), before any upload", async () => {
    const cwd = await tmpProject("anon-app");
    const { adapter, calls } = appAdapter({});
    const ctx: CliContext = { cwd, env: { OPENPOUCH_HOME: cwd }, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { app: "shop" });
    expect(result.exitCode).toBe(2);
    expect((result.json.error as { category: string; message: string }).message).toContain("need an account");
    expect(calls).toHaveLength(0); // nothing was uploaded
  });

  it("rejects an invalid --app name locally", async () => {
    const cwd = await tmpProject("bad-app");
    const { adapter } = appAdapter({});
    const ctx: CliContext = { cwd, env: { OPENPOUCH_API_KEY: "op_live_k" }, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { app: "My_Shop!" });
    expect(result.exitCode).toBe(2);
    expect((result.json.error as { message: string }).message).toContain("invalid --app name");
  });

  it("keyed --app deploy: header threaded, result says stable URL + named app, summary tells the story", async () => {
    const cwd = await tmpProject("keyed-app");
    const { adapter, calls } = appAdapter({ app: "shop", updated: false, ownership: "account" });
    const ctx: CliContext = { cwd, env: { OPENPOUCH_API_KEY: "op_live_k" }, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { app: "shop" });
    expect(result.exitCode).toBe(0);
    expect(calls[0]!["app"]).toBe("shop");
    expect(result.json.urlStability).toBe("stable");
    expect(result.json.app).toBe("shop");
    expect(result.json.updated).toBe(false);
    expect((result.json.deployment as { app?: string }).app).toBe("shop");
    // The hand-off block and summary carry the same-URL promise, jargon-free.
    expect(String(result.json.tellYourUser)).toContain("stays the same");
    expect(String(result.json.summary)).toContain('"shop"');
    expect(result.human.join("\n")).toContain("named app");
  });

  it("an UPDATE tells the human the link they shared keeps working", async () => {
    const cwd = await tmpProject("upd-app");
    const { adapter } = appAdapter({ app: "shop", updated: true, ownership: "account" });
    const ctx: CliContext = { cwd, env: { OPENPOUCH_API_KEY: "op_live_k" }, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { app: "shop" });
    expect(result.exitCode).toBe(0);
    expect(result.json.updated).toBe(true);
    expect(String(result.json.tellYourUser)).toContain("was updated");
    expect(String(result.json.summary)).toContain("was just updated");
    expect(result.human.join("\n")).toContain("UPDATED behind its stable URL");
  });

  it("version skew: a server that ignores --app is surfaced honestly (fresh URL, no false stability)", async () => {
    const cwd = await tmpProject("skew-app");
    const { adapter } = appAdapter({ ownership: "account" }); // echoes NO app field
    const ctx: CliContext = { cwd, env: { OPENPOUCH_API_KEY: "op_live_k" }, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { app: "shop" });
    expect(result.exitCode).toBe(0);
    expect(result.json.urlStability).toBe("fresh-per-deploy");
    expect(result.json.appNotSupportedByServer).toBe(true);
    expect(result.json.app).toBeUndefined();
    expect(result.human.join("\n")).toContain("server ignored --app");
  });
});

describe("openpouch deploy on a governed project — the migration intent fork (L13/G3)", () => {
  async function governedProject(): Promise<string> {
    const cwd = await tmpProject("gov-app");
    await writeFile(
      join(cwd, "deploy.manifest.json"),
      JSON.stringify({
        version: 0,
        project: { name: "gov-app" },
        env: [],
        environments: { production: { provider: "render", serviceId: "srv-1" } },
      }),
    );
    return cwd;
  }

  it("without --app it refuses AND names the migration move (never a dead end)", async () => {
    const cwd = await governedProject();
    const ctx: CliContext = { cwd, env: {}, createAdapter: () => mockRunAdapter(), probeUrl: healthyProbe };
    const result = await instantCommand(ctx);
    expect(result.exitCode).toBe(2);
    const err = result.json.error as { message: string; fix: string };
    expect(err.fix).toContain("--app");
    expect(err.fix).toContain("rollback anchor");
    expect(err.fix).toContain("WORKFLOWS.md");
  });

  it("with --app it DEPLOYS (this IS the migration) and tells the truth about the old host", async () => {
    const cwd = await governedProject();
    const adapter = {
      ...mockRunAdapter(),
      instantDeploy: async () => ({
        id: "gov-a1",
        slug: "gov-a1",
        url: "https://gov-a1.openpouch.sh",
        expiresAt: "2026-10-15T00:00:00.000Z",
        status: "live" as const,
        ownership: "account" as const,
        expiryPolicy: "rolling-while-used" as const,
        app: "gov-app",
        updated: false,
      }),
    };
    const ctx: CliContext = { cwd, env: { OPENPOUCH_API_KEY: "op_live_k" }, createAdapter: () => adapter, probeUrl: healthyProbe };
    const result = await instantCommand(ctx, undefined, { app: "gov-app" });
    expect(result.exitCode).toBe(0);
    expect(result.json.migratingFrom).toEqual(["render"]);
    expect(result.human.join("\n")).toContain("rollback anchor");
    expect(result.human.join("\n")).toContain("data push");
  });
});
