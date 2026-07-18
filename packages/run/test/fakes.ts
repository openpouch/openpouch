import type { BuildResult, BuildScriptSpec, BuildSpec, ContainerEngine, ContainerState, CreateSpec } from "../src/engine.js";
import type { CaddyRouter } from "../src/router.js";

/** In-memory container engine for orchestrator/server tests — no Docker. */
export class FakeEngine implements ContainerEngine {
  readonly states = new Map<string, ContainerState>();
  readonly calls: string[] = [];
  buildOk = true;
  buildLogs = "fake build logs";
  /** App build script (buildApp) outcome — defaults to success. */
  buildAppOk = true;
  buildAppLogs = "fake app build logs";
  /** Make create() throw, to exercise the start-failure path. */
  failCreate = false;
  private seq = 0;

  async build(spec: BuildSpec): Promise<BuildResult> {
    this.calls.push(`build:${spec.slug}`);
    return { ok: this.buildOk, logs: this.buildLogs };
  }

  async buildApp(spec: BuildScriptSpec): Promise<BuildResult> {
    this.calls.push(`buildApp:${spec.slug}`);
    return { ok: this.buildAppOk, logs: this.buildAppLogs };
  }

  /** Last CreateSpec per slug — lets tests assert the volume mount etc. */
  readonly createSpecs = new Map<string, CreateSpec>();

  async create(spec: CreateSpec): Promise<string> {
    this.calls.push(`create:${spec.slug}`);
    this.createSpecs.set(spec.slug, spec);
    if (this.failCreate) throw new Error("fake create failure");
    const id = `c-${spec.slug}-${++this.seq}`;
    this.states.set(id, "stopped");
    return id;
  }

  async start(id: string): Promise<void> {
    this.calls.push(`start:${id}`);
    this.states.set(id, "running");
  }

  async stop(id: string): Promise<void> {
    this.calls.push(`stop:${id}`);
    this.states.set(id, "stopped");
  }

  async remove(id: string): Promise<void> {
    this.calls.push(`remove:${id}`);
    this.states.set(id, "missing");
  }

  async state(id: string): Promise<ContainerState> {
    return this.states.get(id) ?? "missing";
  }

  async logs(id: string): Promise<string> {
    return `logs for ${id}`;
  }
}

/** Recording router — captures every host list it was asked to sync. */
export class FakeRouter implements CaddyRouter {
  readonly synced: string[][] = [];
  async sync(hostnames: string[]): Promise<void> {
    this.synced.push([...hostnames]);
  }
  get last(): string[] {
    return this.synced[this.synced.length - 1] ?? [];
  }
}
