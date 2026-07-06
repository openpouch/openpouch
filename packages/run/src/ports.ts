/**
 * Host-port allocator for dynamic deployments. Each running container publishes
 * one port on 127.0.0.1; this hands out a free one from a bounded range and
 * tracks what is in use. Single-threaded run-d serializes calls, so no locking.
 */
export class PortExhaustedError extends Error {
  constructor(min: number, max: number) {
    super(`no free port in range ${min}-${max}`);
    this.name = "PortExhaustedError";
  }
}

export class PortPool {
  private readonly used = new Set<number>();

  constructor(
    private readonly min: number,
    private readonly max: number,
  ) {
    if (max < min) throw new Error(`invalid port range ${min}-${max}`);
  }

  /** Mark a port as in use — used to rebuild state from the registry on boot. */
  reserve(port: number): void {
    this.used.add(port);
  }

  release(port: number): void {
    this.used.delete(port);
  }

  has(port: number): boolean {
    return this.used.has(port);
  }

  get size(): number {
    return this.used.size;
  }

  /** Allocate the lowest free port in range and mark it used. */
  allocate(): number {
    for (let p = this.min; p <= this.max; p++) {
      if (!this.used.has(p)) {
        this.used.add(p);
        return p;
      }
    }
    throw new PortExhaustedError(this.min, this.max);
  }
}
