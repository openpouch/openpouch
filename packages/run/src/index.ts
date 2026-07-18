import { configFromEnv, createRunServer, type RunConfig } from "./server.js";

export * from "./store.js";
export * from "./tar.js";
export * from "./detect.js";
export * from "./engine.js";
export * from "./engine-wrapper.js";
export * from "./ports.js";
export * from "./router.js";
export * from "./proxy.js";
export * from "./orchestrator.js";
export * from "./accounts.js";
export * from "./counters.js";
export * from "./auth.js";
export * from "./quota.js";
export * from "./mailer.js";
export * from "./github.js";
export { configFromEnv, createRunServer, type RunConfig, type RunServer, type RunServerDeps, type DynamicConfig, type AccountConfig } from "./server.js";

/** Boot run-d: reconcile dynamic state, listen, and start the expiry + idle loops. */
export async function startServer(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config: RunConfig = configFromEnv(env);
  const { server, sweep, orchestrator } = await createRunServer(config, { log: (m) => process.stdout.write(`run-d: ${m}\n`) });

  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`openpouch-run listening on 127.0.0.1:${config.port} (base ${config.baseDomain}, dynamic ${config.dynamicEnabled ? "ON" : "off"})\n`);
  });

  // Restore container/route state after a run-d or box restart (idempotent).
  if (orchestrator) {
    orchestrator.reconcile(Date.now()).catch((e) => process.stderr.write(`reconcile error: ${String(e)}\n`));
  }

  const reaper = setInterval(() => {
    sweep()
      .then((removed) => {
        if (removed.length > 0) process.stdout.write(`reaper: expired ${removed.length} deployment(s)\n`);
      })
      .catch((e) => process.stderr.write(`reaper error: ${String(e)}\n`));
  }, 5 * 60_000);
  reaper.unref();

  // Scale-to-zero: stop containers with no recent traffic.
  if (orchestrator) {
    const idle = setInterval(() => {
      orchestrator.idleSweep(Date.now()).catch((e) => process.stderr.write(`idle-sweep error: ${String(e)}\n`));
    }, 60_000);
    idle.unref();
  }
}
