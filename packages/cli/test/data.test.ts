import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataCommand } from "../src/commands/data.js";
import type { CliContext } from "../src/shared.js";

/** L13 data channel CLI: push/pull/ls wrap the adapter, key-gated, D7-clean. */

function mockAdapter() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = {
    dataPush: async (app: string, tarball: Uint8Array) => {
      calls.push({ method: "push", args: [app, tarball.byteLength] });
      return { app, files: 2, restarted: true };
    },
    dataPull: async (app: string) => {
      calls.push({ method: "pull", args: [app] });
      return new TextEncoder().encode("fake-tgz-bytes");
    },
    dataList: async (app: string) => {
      calls.push({ method: "ls", args: [app] });
      return { app, files: [{ path: "inventory.db", bytes: 42, mtime: "2026-07-17T00:00:00.000Z" }], totalBytes: 42 };
    },
  };
  return { adapter, calls };
}

const ctxWith = (cwd: string, adapter: unknown, env: Record<string, string | undefined> = { OPENPOUCH_API_KEY: "op_live_k" }): CliContext => ({
  cwd,
  env,
  createAdapter: () => adapter as never,
});

describe("openpouch data (L13)", () => {
  it("needs an account key — anonymous gets an auth error with the signup fix, adapter never called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdata-anon-"));
    const { adapter, calls } = mockAdapter();
    const result = await dataCommand(ctxWith(cwd, adapter, { OPENPOUCH_HOME: cwd }), "ls", "shop");
    expect(result.exitCode).toBe(4);
    expect((result.json.error as { fix: string }).fix).toContain("signup");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown verb and a missing app as usage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdata-usage-"));
    const { adapter } = mockAdapter();
    expect((await dataCommand(ctxWith(cwd, adapter), "sync", "shop")).exitCode).toBe(2);
    expect((await dataCommand(ctxWith(cwd, adapter), "ls")).exitCode).toBe(2);
  });

  it("push tars the given directory and relays counts only — file contents never appear in the output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdata-push-"));
    const dataDir = join(cwd, "export");
    await writeFile(join(cwd, "unrelated.txt"), "x");
    const { adapter, calls } = mockAdapter();
    // missing dir → usage
    expect((await dataCommand(ctxWith(cwd, adapter), "push", "shop")).exitCode).toBe(2);
    expect((await dataCommand(ctxWith(cwd, adapter), "push", "shop", "missing-dir")).exitCode).toBe(2);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "inventory.db"), "SECRET-ROW-CONTENT");
    const result = await dataCommand(ctxWith(cwd, adapter), "push", "shop", "export");
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ ok: true, app: "shop", files: 2, restarted: true });
    expect(calls.at(-1)?.method).toBe("push");
    // D7: contents never surface
    expect(JSON.stringify(result.json) + result.human.join("\n")).not.toContain("SECRET-ROW-CONTENT");
    expect(String(result.json.summary)).toContain("restarted");
  });

  it("pull writes the backup file and reports its path + size", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdata-pull-"));
    const { adapter } = mockAdapter();
    const result = await dataCommand(ctxWith(cwd, adapter), "pull", "shop");
    expect(result.exitCode).toBe(0);
    const file = String(result.json.file);
    expect(file.endsWith("shop-data.tgz")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("fake-tgz-bytes");
    expect(String(result.json.summary)).toContain("backup");
  });

  it("ls lists names/sizes and a relayable summary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opdata-ls-"));
    const { adapter } = mockAdapter();
    const result = await dataCommand(ctxWith(cwd, adapter), "ls", "shop");
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ ok: true, app: "shop", count: 1, totalBytes: 42 });
    expect(result.human.join("\n")).toContain("inventory.db");
  });
});
