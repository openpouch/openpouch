import { spawn } from "node:child_process";

/**
 * Container engine abstraction for the M2 dynamic lane. The orchestrator talks
 * only to this interface; `DockerEngine` shells out to the hardened `docker`
 * profile on the box, while tests inject a fake. Build and runtime both run in
 * the sandbox (proposal §3): a throwaway build container installs deps, then a
 * long-lived run container serves one process on one port.
 */

export type ContainerState = "running" | "stopped" | "missing";

export interface BuildSpec {
  slug: string;
  /** Host directory bind-mounted to /app (read-write); node_modules persists here. */
  siteDir: string;
  /** Install command, e.g. "npm ci --ignore-scripts" (run under sh -c). */
  installCmd: string;
}

export interface BuildScriptSpec {
  slug: string;
  siteDir: string;
  /** The app's build command (run under sh -c), e.g. "npm run build". */
  buildCmd: string;
}

export interface CreateSpec {
  slug: string;
  siteDir: string;
  /** Shell command that starts the app (run under sh -c), e.g. "npm start". */
  startCmd: string;
  /** Host port published on 127.0.0.1, forwarded to the container's PORT. */
  hostPort: number;
  /** App env vars/secrets injected as container env (`-e KEY=value`). Values are
   *  secrets (D7) — never logged. Ephemeral: present only while the container
   *  exists (survives stop/start, NOT a recreate after box reboot). */
  env?: Record<string, string>;
}

export interface BuildResult {
  ok: boolean;
  logs: string;
}

export interface ContainerEngine {
  /** Install dependencies in a throwaway hardened container. */
  build(spec: BuildSpec): Promise<BuildResult>;
  /**
   * Run the app's build script (e.g. `npm run build`) in a throwaway hardened
   * container after deps are installed (build-on-deploy, PRD L9). Output (e.g.
   * `dist/`) lands in the bind-mounted /app, so the run container then serves
   * the built app. Same sandbox/limits as `build`.
   */
  buildApp(spec: BuildScriptSpec): Promise<BuildResult>;
  /** Create (without starting) the run container; returns its id. */
  create(spec: CreateSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Force-remove the container (idempotent — missing is fine). */
  remove(id: string): Promise<void>;
  state(id: string): Promise<ContainerState>;
  logs(id: string, tail?: number): Promise<string>;
}

export interface DockerEngineConfig {
  /** Base image (pre-pulled on the box), e.g. "node:22-alpine". */
  image: string;
  /** "uid:gid" the container runs as. Empty → omit --user (tests only). */
  user: string;
  /** Egress-filtered docker network. */
  network: string;
  /** Runtime limits. */
  memory: string;
  cpus: string;
  pidsLimit: number;
  /** Build gets a little more headroom than runtime. */
  buildMemory: string;
  buildCpus: string;
  buildTimeoutMs: number;
  /** Port the app listens on inside the container (injected as PORT). */
  containerPort: number;
}

export interface CommandRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const MAX_LOG_BYTES = 16 * 1024;

export function truncate(s: string, max = MAX_LOG_BYTES): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

/**
 * Per-stream ceiling on what `spawnCollect` accumulates in memory. Real build
 * logs are far smaller; this only bites a runaway/malicious child that spews
 * GBs to stdout during a build, which would otherwise balloon run-d's heap
 * before the build timeout fires. We keep the **tail** (drop the oldest bytes),
 * because that's what the orchestrator surfaces via `openpouch logs` — the crash
 * is at the end. 1 MB is ~orders above any legitimate build's output.
 */
export const MAX_CAPTURED_BYTES = 1024 * 1024;

/** Append `chunk` to `buf`, keeping at most `cap` bytes (the most recent tail). */
export function appendBounded(buf: string, chunk: string, cap = MAX_CAPTURED_BYTES): string {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Spawn `command` with `args` as an argv array (never a shell — no injection),
 * collect stdout/stderr, optional kill-after-timeout. Shared by `DockerEngine`
 * (raw `docker`) and `WrapperEngine` (the privileged `op-docker` wrapper, B1).
 */
export function spawnCollect(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (c: Buffer) => (stdout = appendBounded(stdout, String(c))));
    child.stderr.on("data", (c: Buffer) => (stderr = appendBounded(stderr, String(c))));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

const runDocker = (args: string[], opts?: { timeoutMs?: number }): Promise<CommandRun> => spawnCollect("docker", args, opts);

export class DockerEngine implements ContainerEngine {
  constructor(private readonly cfg: DockerEngineConfig) {}

  private hardening(build: boolean): string[] {
    const args = ["--network", this.cfg.network, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp"];
    if (this.cfg.user) args.push("--user", this.cfg.user);
    args.push("--memory", build ? this.cfg.buildMemory : this.cfg.memory);
    args.push("--cpus", build ? this.cfg.buildCpus : this.cfg.cpus);
    args.push("--pids-limit", String(this.cfg.pidsLimit));
    return args;
  }

  /** Run one command in a throwaway hardened build container (install or build script). */
  private async runBuildContainer(slug: string, siteDir: string, cmd: string): Promise<BuildResult> {
    const name = `op-build-${slug}`;
    // Clear any stale build container from a crashed prior attempt.
    await runDocker(["rm", "-f", name]).catch(() => {});
    const args = [
      "run", "--rm", "--name", name,
      ...this.hardening(true),
      "-v", `${siteDir}:/app`, "-w", "/app",
      "-e", "HOME=/app", "-e", "npm_config_cache=/tmp/.npm", "-e", "npm_config_update_notifier=false", "-e", "CI=1",
      this.cfg.image,
      "sh", "-c", cmd,
    ];
    let res: CommandRun;
    try {
      res = await runDocker(args, { timeoutMs: this.cfg.buildTimeoutMs });
    } catch (err) {
      return { ok: false, logs: `build could not start: ${(err as Error).message}` };
    }
    if (res.timedOut) {
      await runDocker(["rm", "-f", name]).catch(() => {});
      return { ok: false, logs: truncate(`build timed out after ${this.cfg.buildTimeoutMs}ms\n${res.stdout}\n${res.stderr}`) };
    }
    return { ok: res.code === 0, logs: truncate(`${res.stdout}\n${res.stderr}`.trim()) };
  }

  build(spec: BuildSpec): Promise<BuildResult> {
    return this.runBuildContainer(spec.slug, spec.siteDir, spec.installCmd);
  }

  buildApp(spec: BuildScriptSpec): Promise<BuildResult> {
    return this.runBuildContainer(spec.slug, spec.siteDir, spec.buildCmd);
  }

  async create(spec: CreateSpec): Promise<string> {
    const name = `op-app-${spec.slug}`;
    await runDocker(["rm", "-f", name]).catch(() => {});
    const args = [
      "create", "--name", name,
      ...this.hardening(false),
      "-v", `${spec.siteDir}:/app`, "-w", "/app",
      "-e", "HOME=/app", "-e", `PORT=${this.cfg.containerPort}`, "-e", "NODE_ENV=production",
      // App env vars/secrets (D7: never logged). PORT/HOME are reserved — the app
      // must listen on the injected PORT — so user values for those are dropped.
      ...Object.entries(spec.env ?? {})
        .filter(([k]) => k !== "PORT" && k !== "HOME")
        .flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-p", `127.0.0.1:${spec.hostPort}:${this.cfg.containerPort}`,
      "--restart", "no",
      this.cfg.image,
      "sh", "-c", spec.startCmd,
    ];
    const res = await runDocker(args);
    if (res.code !== 0) throw new Error(`docker create failed: ${res.stderr.trim() || res.stdout.trim()}`);
    const id = res.stdout.trim().split("\n").pop() ?? name;
    return id || name;
  }

  async start(id: string): Promise<void> {
    const res = await runDocker(["start", id]);
    if (res.code !== 0) throw new Error(`docker start failed: ${res.stderr.trim()}`);
  }

  async stop(id: string): Promise<void> {
    await runDocker(["stop", "--time", "5", id]).catch(() => {});
  }

  async remove(id: string): Promise<void> {
    await runDocker(["rm", "-f", id]).catch(() => {});
  }

  async state(id: string): Promise<ContainerState> {
    const res = await runDocker(["inspect", "-f", "{{.State.Status}}", id]);
    if (res.code !== 0) return "missing";
    return res.stdout.trim() === "running" ? "running" : "stopped";
  }

  async logs(id: string, tail = 200): Promise<string> {
    const res = await runDocker(["logs", "--tail", String(tail), id]);
    return truncate(`${res.stdout}\n${res.stderr}`.trim());
  }
}
