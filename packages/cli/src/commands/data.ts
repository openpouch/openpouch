import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunAdapter } from "@openpouch/adapter-run";
import {
  ANONYMOUS_KEY,
  EXIT,
  errorResult,
  isProviderApiError,
  makeAdapter,
  resolveProviderApiKey,
  summarized,
  type CliContext,
  type CommandResult,
} from "../shared.js";
import { dataSummary } from "../summary.js";
import { buildTarball } from "./instant.js";

/**
 * `openpouch data <push|pull|ls> <app> [dir|dest]` — the L13 data channel for a
 * named app's persistent /data volume. This is what makes migrations (and
 * backups) fully agent-autonomous: `push` replaces the volume's contents with a
 * local directory (the server stops the container for the write and restarts it
 * health-gated), `pull` downloads the volume as a .tgz (the backup primitive),
 * `ls` lists names/sizes only. Owner-key-gated; file CONTENTS are customer data
 * (D7) — they are never logged or echoed, and results carry counts/sizes only.
 */
export async function dataCommand(ctx: CliContext, verb?: string, app?: string, pathArg?: string): Promise<CommandResult> {
  if (verb !== "push" && verb !== "pull" && verb !== "ls") {
    return errorResult(
      EXIT.USAGE,
      "usage",
      `usage: openpouch data <push|pull|ls> <app> [dir|dest]`,
      "Examples: `openpouch data push my-shop ./data-export` · `openpouch data pull my-shop backup.tgz` · `openpouch data ls my-shop`.",
    );
  }
  if (app === undefined || app === "") {
    return errorResult(EXIT.USAGE, "usage", `openpouch data ${verb} needs the app name`, "Run `openpouch list` to see your apps, then e.g. `openpouch data ls <name>`.");
  }
  const key = (await resolveProviderApiKey(ctx.env, "openpouch-run")) ?? ANONYMOUS_KEY;
  if (key === ANONYMOUS_KEY) {
    return errorResult(
      EXIT.AUTH,
      "auth",
      "the data channel needs your account key (named apps are account-owned)",
      "Sign up (`openpouch signup --email you@example.com`), save your API key, then rerun the same command.",
    );
  }
  const adapter = makeAdapter(ctx, "openpouch-run", key) as Partial<RunAdapter>;
  if (typeof adapter.dataPush !== "function" || typeof adapter.dataPull !== "function" || typeof adapter.dataList !== "function") {
    return errorResult(EXIT.UNEXPECTED, "provider", "data channel unavailable", "This is an internal wiring error.");
  }

  try {
    if (verb === "ls") {
      const listing = await adapter.dataList(app);
      return summarized(
        EXIT.OK,
        { ok: true, app, count: listing.files.length, totalBytes: listing.totalBytes, files: listing.files },
        dataSummary({ verb: "ls", app, files: listing.files.length, bytes: listing.totalBytes }),
        [
          `openpouch data ls — ${app}: ${listing.files.length} file(s), ${listing.totalBytes} bytes`,
          ...listing.files.slice(0, 50).map((f) => `  ${f.path}  ${f.bytes} bytes  ${f.mtime}`),
          ...(listing.files.length > 50 ? [`  … ${listing.files.length - 50} more`] : []),
        ],
      );
    }

    if (verb === "pull") {
      const bytes = await adapter.dataPull(app);
      const dest = resolve(ctx.cwd, pathArg !== undefined && pathArg !== "" ? pathArg : `${app}-data.tgz`);
      await writeFile(dest, bytes);
      return summarized(
        EXIT.OK,
        { ok: true, app, file: dest, bytes: bytes.byteLength },
        dataSummary({ verb: "pull", app, bytes: bytes.byteLength, dest }),
        [`openpouch data pull — ${app} → ${dest} (${bytes.byteLength} bytes, gzipped tar)`],
      );
    }

    // push
    if (pathArg === undefined || pathArg === "") {
      return errorResult(EXIT.USAGE, "usage", "openpouch data push needs the local directory to upload", "Example: `openpouch data push my-shop ./data-export` — its contents REPLACE the app's /data.");
    }
    const dir = resolve(ctx.cwd, pathArg);
    try {
      if (!(await stat(dir)).isDirectory()) {
        return errorResult(EXIT.USAGE, "usage", `not a directory: ${pathArg}`, "Point `data push` at a folder whose contents should become the app's /data.");
      }
    } catch {
      return errorResult(EXIT.USAGE, "usage", `folder not found: ${pathArg}`, "Point `data push` at an existing folder.");
    }
    const tarball = await buildTarball(dir);
    const result = await adapter.dataPush(app, tarball);
    return summarized(
      EXIT.OK,
      { ok: true, app, files: result.files, restarted: result.restarted, ...(result.warning !== undefined ? { warning: result.warning } : {}) },
      dataSummary({ verb: "push", app, files: result.files, restarted: result.restarted, ...(result.warning !== undefined ? { warning: true } : {}) }),
      [
        `openpouch data push — ${app}: /data replaced (${result.files} file(s))${result.restarted ? ", app restarted and healthy" : ""}`,
        ...(result.warning !== undefined ? [`  warning: ${result.warning}`] : []),
      ],
    );
  } catch (e) {
    if (isProviderApiError(e)) {
      return errorResult(e.category === "auth" ? EXIT.AUTH : EXIT.PROVIDER, e.category, e.message, e.fix);
    }
    throw e;
  }
}
