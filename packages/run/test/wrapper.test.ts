import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WrapperEngine } from "../src/engine-wrapper.js";
import { configFromEnv } from "../src/server.js";

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../ops/op-docker.sh", import.meta.url));

/**
 * The op-docker wrapper is the B1 privilege boundary (root-owned). These tests
 * drive it with a FAKE docker that records its argv, so we can assert:
 *  - it constructs the FIXED hardened profile run-d cannot influence,
 *  - it rejects malformed slugs/ports/verbs before ever calling docker,
 *  - app commands reach `sh -c` as a single argv element (no host-shell split).
 */
describe("op-docker wrapper (B1 privilege boundary)", () => {
  let dir: string;
  let sites: string;
  let volumes: string;
  let capture: string;
  let fakeDocker: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opwrap-"));
    sites = join(dir, "sites");
    volumes = join(dir, "volumes");
    await mkdir(join(sites, "demo"), { recursive: true }); // the server-assigned slug dir
    await mkdir(volumes, { recursive: true });
    capture = join(dir, "argv.log");
    fakeDocker = join(dir, "docker");
    // Records each argv on its own line; emulates `inspect`/`create` output.
    await writeFile(
      fakeDocker,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$CAPTURE"\n` +
        `if [ "$1" = inspect ]; then echo running; fi\n` +
        `if [ "$1" = create ]; then echo fake-container-id; fi\nexit 0\n`,
      "utf8",
    );
    await chmod(fakeDocker, 0o755);
    env = {
      ...process.env,
      OP_DOCKER_BIN: fakeDocker,
      OP_SITES_DIR: sites,
      OP_VOLUMES_DIR: volumes,
      OP_RUN_USER: "1000:1000",
      CAPTURE: capture,
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) => exec("bash", [SCRIPT, ...args], { env });
  const captured = async () => (existsSync(capture) ? (await readFile(capture, "utf8")).split("\n") : []);

  it("build constructs the fixed hardened profile and passes installCmd intact", async () => {
    await run(["build", "demo", "npm ci --ignore-scripts ; echo pwned"]);
    const lines = await captured();
    // Hardening run-d cannot turn off:
    for (const flag of ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--network", "op-egress", "--user", "1000:1000"]) {
      expect(lines).toContain(flag);
    }
    expect(lines).toContain("op-egress");
    // The site dir is derived from the slug (canonicalized), mounted at /app — never `/`:
    expect(lines).toContain(`${realpathSync(join(sites, "demo"))}:/app`);
    // The install command reaches `sh -c` as ONE argv element (no host-shell split):
    expect(lines).toContain("npm ci --ignore-scripts ; echo pwned");
    // run-d can never have injected an escape (privileged, host mount, docker socket):
    expect(lines).not.toContain("--privileged");
    expect(lines.some((l) => l.includes("/:/host") || l.includes("docker.sock"))).toBe(false);
    expect(lines).not.toContain("--network=host");
  });

  it("buildapp uses the same hardened build profile and passes buildCmd intact (L9)", async () => {
    await run(["buildapp", "demo", "npm run build ; echo pwned"]);
    const lines = await captured();
    for (const flag of ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--network", "op-egress", "--user", "1000:1000"]) {
      expect(lines).toContain(flag);
    }
    expect(lines).toContain(`${realpathSync(join(sites, "demo"))}:/app`);
    expect(lines).toContain("npm run build ; echo pwned"); // one argv element to sh -c
    expect(lines).toContain("op-build-demo"); // throwaway build container, not the app container
    expect(lines).not.toContain("--privileged");
    expect(lines.some((l) => l.includes("/:/host") || l.includes("docker.sock"))).toBe(false);
  });

  it("create publishes only on 127.0.0.1 with the requested in-range port", async () => {
    await run(["create", "demo", "20123", "node server.js"]);
    const lines = await captured();
    expect(lines).toContain("--name");
    expect(lines).toContain("op-app-demo");
    expect(lines).toContain("127.0.0.1:20123:8080");
    expect(lines).toContain("node server.js");
    expect(lines).toContain("--restart");
  });

  it("create injects validated app env vars as -e (base64-decoded); reserved PORT/HOME dropped", async () => {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    await run(["create", "demo", "20123", "node server.js", `API_KEY ${b64("s3cr3t")}\nDB_URL ${b64("postgres://u:p@h/db")}\nPORT ${b64("9999")}`]);
    const lines = await captured();
    expect(lines).toContain("API_KEY=s3cr3t");
    expect(lines).toContain("DB_URL=postgres://u:p@h/db");
    // PORT is reserved → the user value is dropped; the real injected PORT stays.
    expect(lines).not.toContain("PORT=9999");
    expect(lines).toContain("PORT=8080");
    // Env injection did not weaken the hardened profile.
    expect(lines).toContain("no-new-privileges");
    expect(lines).not.toContain("--privileged");
  });

  it("create rejects a bad env var name and never echoes the secret value (D7)", async () => {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    let err: { stderr?: string; stdout?: string } | undefined;
    try {
      await run(["create", "demo", "20123", "node server.js", `1BAD ${b64("topsecret")}`]);
    } catch (e) {
      err = e as { stderr?: string; stdout?: string };
    }
    expect(err).toBeDefined();
    expect(`${err?.stderr ?? ""}${err?.stdout ?? ""}`).not.toContain("topsecret");
  });

  it("create bind-mounts a validated volume key read-write at /data (L13) — and only with a key", async () => {
    await mkdir(join(volumes, "acct_ab12", "shop"), { recursive: true });
    await run(["create", "demo", "20123", "node server.js", "", "acct_ab12/shop"]);
    let lines = await captured();
    expect(lines).toContain(`${realpathSync(join(volumes, "acct_ab12", "shop"))}:/data`);
    // The volume did not weaken the hardened profile.
    expect(lines).toContain("no-new-privileges");
    // Without a key there is no /data mount at all.
    await rm(capture, { force: true });
    await run(["create", "demo", "20123", "node server.js"]);
    lines = await captured();
    expect(lines.join("\n")).not.toContain(":/data");
  });

  it("create injects env AND mounts the volume when BOTH ride along (the 2026-07-18 live regression: env was parsed only at exactly 4 args)", async () => {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    await mkdir(join(volumes, "acct_ab12", "shop"), { recursive: true });
    await run(["create", "demo", "20123", "node server.js", `DATA_DIR ${b64("/data")}`, "acct_ab12/shop"]);
    const lines = await captured();
    expect(lines).toContain("DATA_DIR=/data");
    expect(lines).toContain(`${realpathSync(join(volumes, "acct_ab12", "shop"))}:/data`);
  });

  it("create rejects traversal-shaped, unknown, and symlink-escaping volume keys BEFORE calling docker (L13)", async () => {
    // traversal shape fails key validation
    await expect(run(["create", "demo", "20123", "node server.js", "", "../../etc"])).rejects.toThrow();
    // well-formed but nonexistent dir
    await expect(run(["create", "demo", "20123", "node server.js", "", "acct_ab12/missing"])).rejects.toThrow();
    // well-formed key whose dir is a symlink escaping the volumes base
    await mkdir(join(volumes, "acct_ab12"), { recursive: true });
    await symlink(dir, join(volumes, "acct_ab12", "evil"));
    await expect(run(["create", "demo", "20123", "node server.js", "", "acct_ab12/evil"])).rejects.toThrow();
    // docker was never invoked for any of the three
    expect(existsSync(capture)).toBe(false);
  });

  it("state maps docker status to running/stopped/missing", async () => {
    const { stdout } = await run(["state", "demo"]);
    expect(stdout.trim()).toBe("running"); // fake inspect prints "running"
  });

  it.each([
    ["bad slug — semicolon", ["build", "a;b", "x"]],
    ["bad slug — path traversal", ["build", "../etc", "x"]],
    ["bad slug — uppercase", ["start", "Demo"]],
    ["bad slug — too long", ["start", "a".repeat(41)]],
    ["port below range", ["create", "demo", "80", "x"]],
    ["port above range", ["create", "demo", "21000", "x"]],
    ["port non-numeric", ["create", "demo", "8080abc", "x"]],
    ["unknown verb", ["nuke", "demo"]],
    ["wrong arity", ["build", "demo"]],
    ["buildapp wrong arity", ["buildapp", "demo"]],
    ["buildapp bad slug", ["buildapp", "a;b", "npm run build"]],
  ])("rejects %s before calling docker (exit 2, docker untouched)", async (_label, args) => {
    await expect(run(args)).rejects.toMatchObject({ code: 2 });
    expect(await captured()).toEqual([]); // the fake docker was never invoked
  });

  it("refuses a slug whose site dir does not exist", async () => {
    await expect(run(["build", "ghost", "x"])).rejects.toMatchObject({ code: 2 });
  });
});

describe("WrapperEngine → op-docker verb mapping", () => {
  let dir: string;
  let capture: string;
  let fakeWrapper: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opwrapeng-"));
    capture = join(dir, "argv.log");
    fakeWrapper = join(dir, "op-docker");
    // Stand-in for op-docker: records the verb + args it receives, mimics state/create.
    await writeFile(
      fakeWrapper,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${capture}"\n` +
        `if [ "$1" = state ]; then echo running; fi\nexit 0\n`,
      "utf8",
    );
    await chmod(fakeWrapper, 0o755);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const lines = async () => (await readFile(capture, "utf8")).split("\n").filter(Boolean);

  it("build/create/start/state map to the wrapper verbs; create returns the slug as id", async () => {
    const engine = new WrapperEngine([fakeWrapper]);

    const b = await engine.build({ slug: "demo", siteDir: "/ignored", installCmd: "npm ci" });
    expect(b.ok).toBe(true);

    const id = await engine.create({ slug: "demo", siteDir: "/ignored", startCmd: "npm start", hostPort: 20100 });
    expect(id).toBe("demo"); // the slug IS the container id in wrapper mode

    await engine.start(id);
    expect(await engine.state(id)).toBe("running");

    const log = await lines();
    expect(log).toEqual([
      "build", "demo", "npm ci",
      "create", "demo", "20100", "npm start",
      "start", "demo",
      "state", "demo",
    ]);
  });

  it("create passes the volume KEY as the 5th positional arg, filling the env slot with '' (L13)", async () => {
    const engine = new WrapperEngine([fakeWrapper]);
    await engine.create({
      slug: "demo",
      siteDir: "/ignored",
      startCmd: "npm start",
      hostPort: 20100,
      volumeDir: "/host/volumes/acct_a/shop", // wrapper mode never uses the raw path
      volumeKey: "acct_a/shop",
    });
    // Read the capture RAW: the filled-with-"" env slot is an empty line that
    // the filtering `lines()` helper would drop — the position is the point.
    const raw = (await readFile(capture, "utf8")).split("\n");
    expect(raw.slice(0, 6)).toEqual(["create", "demo", "20100", "npm start", "", "acct_a/shop"]);
  });

  it("buildApp maps to the `buildapp` verb with the build command (build-on-deploy, L9)", async () => {
    const engine = new WrapperEngine([fakeWrapper]);
    const r = await engine.buildApp({ slug: "demo", siteDir: "/ignored", buildCmd: "npm run build" });
    expect(r.ok).toBe(true);
    expect(await lines()).toEqual(["buildapp", "demo", "npm run build"]);
  });

  it("parses a multi-word command string (e.g. 'sudo /usr/local/sbin/op-docker')", async () => {
    const engine = new WrapperEngine(`bash ${fakeWrapper}`);
    await engine.start("demo");
    expect(await lines()).toEqual(["start", "demo"]);
  });

  it("rejects an empty command", () => {
    expect(() => new WrapperEngine("   ")).toThrow();
  });
});

describe("OPENPOUCH_RUN_DOCKER_CMD wiring", () => {
  it("defaults to direct docker (empty) and reads the wrapper command from the env", () => {
    expect(configFromEnv({}).dynamic.dockerCmd).toBe("");
    expect(configFromEnv({ OPENPOUCH_RUN_DOCKER_CMD: "sudo /usr/local/sbin/op-docker" }).dynamic.dockerCmd).toBe(
      "sudo /usr/local/sbin/op-docker",
    );
  });
});
