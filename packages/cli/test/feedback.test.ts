import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feedbackCommand } from "../src/commands/feedback.js";
import { feedbackOutboxPath } from "../src/feedback.js";
import { run } from "../src/main.js";

const tmpHome = () => mkdtemp(join(tmpdir(), "opfb-"));

describe("openpouch feedback (R10.3 — opt-in, secret-free, no transmission by default)", () => {
  it("records the note to a local outbox and does not transmit (no endpoint configured)", async () => {
    const home = await tmpHome();
    const ctx = { cwd: ".", env: { OPENPOUCH_HOME: home } };
    const r = await feedbackCommand(ctx, "deploy reported live but / was 404");
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, recorded: true, sent: false });
    const line = (await readFile(feedbackOutboxPath(ctx.env), "utf8")).trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry["message"]).toBe("deploy reported live but / was 404");
    // secret-free: only a timestamp + the human's own note — nothing about the project
    expect(Object.keys(entry).sort()).toEqual(["at", "message"]);
  });

  it("is a no-op when opted out (DO_NOT_TRACK), writing nothing", async () => {
    const home = await tmpHome();
    const ctx = { cwd: ".", env: { OPENPOUCH_HOME: home, DO_NOT_TRACK: "1" } };
    const r = await feedbackCommand(ctx, "anything");
    expect(r.json).toMatchObject({ ok: true, recorded: false, reason: "opt-out" });
    await expect(readFile(feedbackOutboxPath(ctx.env), "utf8")).rejects.toThrow();
  });

  it("usage-errors (exit 2) on empty text", async () => {
    const r = await feedbackCommand({ cwd: ".", env: {} }, "   ");
    expect(r.exitCode).toBe(2);
    expect((r.json.error as { message: string }).message).toContain("no feedback text");
  });
});

describe("feedbackHint at friction (R10.1 / R10.3 / R10.5a)", () => {
  it("an error result invites optional feedback (agent-legible field)", async () => {
    const json = JSON.parse((await run(["nope", "--json"], { cwd: ".", env: {} })).output) as Record<string, unknown>;
    expect(json["ok"]).toBe(false);
    expect(String(json["feedbackHint"])).toContain("openpouch feedback");
  });
  it("is suppressed entirely when opted out", async () => {
    const json = JSON.parse((await run(["nope", "--json"], { cwd: ".", env: { DO_NOT_TRACK: "1" } })).output) as Record<string, unknown>;
    expect(json["feedbackHint"]).toBeUndefined();
  });
  it("never appears on a successful command (no friction)", async () => {
    const json = JSON.parse((await run(["--version", "--json"], { cwd: ".", env: {} })).output) as Record<string, unknown>;
    expect(json["feedbackHint"]).toBeUndefined();
  });
});
