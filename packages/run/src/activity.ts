import { open, stat } from "node:fs/promises";

/**
 * Static-lane activity source for usage-based persistence (D25, design §3.3).
 *
 * Static previews are served by Caddy's wildcard `file_server` — run-d never
 * sees those requests. Instead of putting run-d into that hot path (rejected:
 * SPOF for the fastest lane), we tail Caddy's JSON access log incrementally
 * and surface which slugs received requests since the last tick.
 *
 * Fail-safe by construction: a missing/unreadable log, a rotated file, or a
 * malformed line can only ever UNDER-report activity — and the sweep treats
 * missing measurements as "never delete" (§3.5). Nothing here can take a
 * site down; the worst case is a warning mail that arrives although someone
 * did visit (healed on the next tick).
 *
 * Expected log shape: one JSON object per line with `request.host` (Caddy's
 * default JSON access log). Only hosts that are DIRECT subdomains of
 * `baseDomain` count; anything else (apex, api, foreign hosts) is ignored.
 */
export class AccessLogActivity {
  /** Byte offset of the first UNPROCESSED byte in the log file. */
  private offset = 0;
  private warnedUnreadable = false;

  constructor(
    private readonly path: string,
    private readonly baseDomain: string,
    private readonly log: (msg: string) => void = () => {},
    /** Safety bound per tick — a runaway log never stalls the reaper. */
    private readonly maxBytesPerTick = 8 * 1024 * 1024,
  ) {}

  /** Slugs that received at least one request since the last collect(). */
  async collect(): Promise<string[]> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        this.log(`activity: access log ${this.path} not readable — static activity tracking degraded (fail-safe: nothing expires for lack of measurement)`);
      }
      return [];
    }
    this.warnedUnreadable = false;
    if (size < this.offset) this.offset = 0; // rotated/truncated → start over
    if (size === this.offset) return [];

    const toRead = Math.min(size - this.offset, this.maxBytesPerTick);
    let chunk: string;
    try {
      const fh = await open(this.path, "r");
      try {
        const buf = Buffer.alloc(toRead);
        const { bytesRead } = await fh.read(buf, 0, toRead, this.offset);
        chunk = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch (err) {
      this.log(`activity: read failed (${(err as Error).message}) — retrying next tick`);
      return [];
    }

    // Only consume complete lines; a line still being written stays for next tick.
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline < 0) {
      // No complete line in this chunk. If the chunk is cap-sized the line is
      // absurdly long (not a Caddy access log) — skip it rather than stall forever.
      if (chunk.length >= this.maxBytesPerTick) this.offset += chunk.length;
      return [];
    }
    const complete = chunk.slice(0, lastNewline + 1);
    this.offset += Buffer.byteLength(complete, "utf8");

    const suffix = `.${this.baseDomain.toLowerCase()}`;
    const slugs = new Set<string>();
    for (const line of complete.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let host: string | undefined;
      try {
        const parsed = JSON.parse(trimmed) as { request?: { host?: unknown } };
        if (typeof parsed.request?.host === "string") host = parsed.request.host;
      } catch {
        continue; // malformed line — under-report, never fail
      }
      if (!host) continue;
      const lower = host.toLowerCase().replace(/:\d+$/, "");
      if (!lower.endsWith(suffix)) continue;
      const slug = lower.slice(0, -suffix.length);
      if (slug.length === 0 || slug.includes(".")) continue; // apex or nested — not a preview slug
      slugs.add(slug);
    }
    return [...slugs];
  }
}
