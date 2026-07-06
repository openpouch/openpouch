import { describe, expect, it } from "vitest";
import { appendBounded, spawnCollect, truncate, MAX_CAPTURED_BYTES } from "../src/engine.js";

describe("appendBounded (heap guard for captured child output)", () => {
  it("returns the full string while under the cap", () => {
    expect(appendBounded("ab", "cd", 10)).toBe("abcd");
  });

  it("keeps only the most recent `cap` bytes (the tail) once over the cap", () => {
    // "0123456789" + "abcde" = "0123456789abcde" (15 chars); last 6 = "9abcde"
    const out = appendBounded("0123456789", "abcde", 6);
    expect(out).toBe("9abcde");
  });

  it("preserves the tail across many appends (bounded memory)", () => {
    let s = "";
    for (let i = 0; i < 1000; i++) s = appendBounded(s, `line${i}\n`, 64);
    expect(s.length).toBeLessThanOrEqual(64);
    expect(s.endsWith("line999\n")).toBe(true); // newest output survives
  });
});

describe("spawnCollect output bounding", () => {
  it("caps captured stdout at MAX_CAPTURED_BYTES and keeps the tail", async () => {
    // Emit ~2 MB of filler, then a unique tail marker on the last line.
    const script = `const big='x'.repeat(2*1024*1024); process.stdout.write(big); process.stdout.write('\\nTAIL_MARKER_END\\n');`;
    const run = await spawnCollect(process.execPath, ["-e", script]);
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBeLessThanOrEqual(MAX_CAPTURED_BYTES);
    expect(run.stdout.includes("TAIL_MARKER_END")).toBe(true); // the tail (where a crash would be) is preserved
  });

  it("captures small output verbatim (no change for normal builds)", async () => {
    const run = await spawnCollect(process.execPath, ["-e", "process.stdout.write('hello'); process.stderr.write('warn')"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("hello");
    expect(run.stderr).toBe("warn");
  });
});

describe("truncate (unchanged head-keeping for stored logs)", () => {
  it("keeps the head and marks truncation past the limit", () => {
    expect(truncate("abcdef", 3)).toBe("abc\n…[truncated]");
    expect(truncate("ab", 3)).toBe("ab");
  });
});
