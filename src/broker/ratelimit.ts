export class WakeLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryConsume(from: string, to: string): boolean {
    const key = `${from}\u0000${to}`;
    const t = this.now();
    // Drop pairs whose whole window has expired so the map does not grow with every pair ever seen.
    for (const [k, hits] of this.hits) {
      if (hits.length === 0 || (hits[hits.length - 1] as number) <= t - this.windowMs) this.hits.delete(k);
    }
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  reset(from: string, to: string): void {
    this.hits.delete(`${from}\u0000${to}`);
  }
}
