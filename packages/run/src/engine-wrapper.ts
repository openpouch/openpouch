import {
  spawnCollect,
  truncate,
  type BuildResult,
  type BuildScriptSpec,
  type BuildSpec,
  type ContainerEngine,
  type ContainerState,
  type CreateSpec,
} from "./engine.js";

/**
 * B1 privilege model: instead of giving run-d direct access to the Docker
 * socket (root-equivalent), run-d drives a small, root-owned `op-docker`
 * wrapper through a tightly-scoped sudoers rule. The wrapper exposes only
 * fixed VERBS and **constructs the hardened `docker` command itself** — run-d
 * can never inject `-v /:/host`, `--privileged`, `--user 0`, etc. (proposal
 * `claude-code/2026-06-13-b1-dynamic-privilege-model-proposal.md`, Option B).
 *
 * Security note: we deliberately do NOT pass the bind-mount path here. The
 * wrapper derives `siteDir` from the validated `slug` itself, so a compromised
 * run-d cannot influence the mount source at all. We pass only the verb +
 * slug + hostPort + the per-app install/start command (the latter run inside
 * the sandbox via `sh -c`, so their content cannot escape the container).
 *
 * The "container id" in this engine is the slug: the wrapper's lifecycle verbs
 * (`start`/`stop`/`rm`/`state`/`logs`) take a slug and operate only on the
 * `op-app-<slug>` / `op-build-<slug>` containers it owns. The orchestrator
 * treats the id opaquely, so this is transparent to it.
 */
export class WrapperEngine implements ContainerEngine {
  /** Parsed command, e.g. ["sudo", "/usr/local/sbin/op-docker"]. */
  private readonly cmd: string[];

  constructor(command: string | string[]) {
    const parts = Array.isArray(command) ? command : command.trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === "") throw new Error("WrapperEngine: empty command");
    this.cmd = parts;
  }

  private run(verb: string, verbArgs: string[], opts?: { timeoutMs?: number }) {
    return spawnCollect(this.cmd[0]!, [...this.cmd.slice(1), verb, ...verbArgs], opts);
  }

  async build(spec: BuildSpec): Promise<BuildResult> {
    let res;
    try {
      res = await this.run("build", [spec.slug, spec.installCmd]);
    } catch (err) {
      return { ok: false, logs: `build could not start: ${(err as Error).message}` };
    }
    return { ok: res.code === 0, logs: truncate(`${res.stdout}\n${res.stderr}`.trim()) };
  }

  async buildApp(spec: BuildScriptSpec): Promise<BuildResult> {
    let res;
    try {
      res = await this.run("buildapp", [spec.slug, spec.buildCmd]);
    } catch (err) {
      return { ok: false, logs: `build script could not start: ${(err as Error).message}` };
    }
    return { ok: res.code === 0, logs: truncate(`${res.stdout}\n${res.stderr}`.trim()) };
  }

  async create(spec: CreateSpec): Promise<string> {
    const args = [spec.slug, String(spec.hostPort), spec.startCmd];
    // App env vars/secrets as an optional 4th arg: `KEY base64(value)` lines.
    // base64 keeps values opaque + safe across the wrapper (no special-char /
    // newline issues); the wrapper validates keys and injects them as `-e`.
    // PORT/HOME are reserved (the app must listen on the injected PORT).
    const envLines = Object.entries(spec.env ?? {})
      .filter(([k]) => k !== "PORT" && k !== "HOME")
      .map(([k, v]) => `${k} ${Buffer.from(v, "utf8").toString("base64")}`)
      .join("\n");
    if (envLines !== "") args.push(envLines);
    const res = await this.run("create", args);
    if (res.code !== 0) throw new Error(`op-docker create failed: ${res.stderr.trim() || res.stdout.trim()}`);
    // The wrapper addresses lifecycle verbs by slug; that is this engine's container id.
    return spec.slug;
  }

  async start(id: string): Promise<void> {
    const res = await this.run("start", [id]);
    if (res.code !== 0) throw new Error(`op-docker start failed: ${res.stderr.trim()}`);
  }

  async stop(id: string): Promise<void> {
    await this.run("stop", [id]).catch(() => {});
  }

  async remove(id: string): Promise<void> {
    await this.run("rm", [id]).catch(() => {});
  }

  async state(id: string): Promise<ContainerState> {
    const res = await this.run("state", [id]);
    if (res.code !== 0) return "missing";
    const s = res.stdout.trim();
    return s === "running" ? "running" : s === "missing" ? "missing" : "stopped";
  }

  async logs(id: string, tail = 200): Promise<string> {
    const res = await this.run("logs", [id, String(tail)]);
    return truncate(`${res.stdout}\n${res.stderr}`.trim());
  }
}
