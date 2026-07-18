import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * M-1 aggregate daily counters (B4 / USAGE-MONITORING backlog, staged 0.3.0).
 *
 * counters.json in the data dir holds per-UTC-day aggregate tallies — never
 * per-user, per-account or per-IP data (privacy guardrail: the weekly usage
 * monitor reads ONLY aggregates). Written atomically (temp + rename) like the
 * registry; increments are in-memory-first and persistence is chained, so a
 * counter bump can never fail a request.
 *
 * Shape: { "2026-07-15": { "deploys": {"static": 1, ...}, "signups": 3, ... } }
 */

type DayBucket = Record<string, number | Record<string, number>>;

export interface CountersOptions {
  dataDir: string;
  /** Days of history to keep (old buckets are pruned on rollover). */
  retentionDays?: number;
}

const DEFAULT_RETENTION_DAYS = 400;

export class Counters {
  private readonly file: string;
  private readonly retentionDays: number;
  private data: Record<string, DayBucket> = {};
  /** Serialises writes so concurrent bumps never race the temp file. */
  private writeChain: Promise<void> = Promise.resolve();
  private onError?: (message: string) => void;

  constructor(opts: CountersOptions & { onError?: (message: string) => void }) {
    this.file = join(opts.dataDir, "counters.json");
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.onError = opts.onError;
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, DayBucket>;
      }
    } catch {
      // missing or corrupt file → start fresh (counters are best-effort telemetry)
      this.data = {};
    }
    this.prune(Date.now());
  }

  /**
   * Increment `key` (optionally nested under `sub`) in today's UTC bucket.
   * Synchronous in memory; persistence is queued and errors only logged —
   * telemetry must never break the request path.
   */
  bump(key: string, sub?: string, now: number = Date.now()): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (!this.data[day]) {
      this.data[day] = {};
      this.prune(now);
    }
    const bucket = this.data[day];
    if (sub === undefined) {
      const current = bucket[key];
      bucket[key] = (typeof current === "number" ? current : 0) + 1;
    } else {
      const current = bucket[key];
      const nested: Record<string, number> = typeof current === "object" && current !== null ? current : {};
      nested[sub] = (nested[sub] ?? 0) + 1;
      bucket[key] = nested;
    }
    this.writeChain = this.writeChain
      .then(() => this.save())
      .catch((err) => this.onError?.(`counters persist failed: ${(err as Error).message}`));
  }

  /** Await all queued writes (tests / graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Read-only view (tests + the usage monitor read the file directly in prod). */
  snapshot(): Record<string, DayBucket> {
    return JSON.parse(JSON.stringify(this.data)) as Record<string, DayBucket>;
  }

  private prune(now: number): void {
    const cutoff = new Date(now - this.retentionDays * 24 * 3_600_000).toISOString().slice(0, 10);
    for (const day of Object.keys(this.data)) if (day < cutoff) delete this.data[day];
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 1)}\n`, "utf8");
    await rename(tmp, this.file);
  }
}
