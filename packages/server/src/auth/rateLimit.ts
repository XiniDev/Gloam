/**
 * In-memory limiters (SPEC §22.5). Token buckets for message/request rates; failure windows with lockout for
 * authentication attempts. All state is per process and swept periodically.
 */

export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly capacity: number;
  readonly refillPerMs: number;
  constructor(capacity: number, refillPerSecond: number, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.tokens = capacity;
    this.last = now;
  }
  take(n = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
  idleSince(): number {
    return this.last;
  }
}

/** Keyed token buckets (e.g. per session, per user+message type). */
export class BucketMap {
  private readonly buckets = new Map<string, TokenBucket>();
  readonly capacity: number;
  readonly refillPerSecond: number;
  constructor(capacity: number, refillPerSecond: number) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
  }
  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.capacity, this.refillPerSecond, now);
      this.buckets.set(key, b);
    }
    return b.take(1, now);
  }
  sweep(olderThanMs: number, now = Date.now()): void {
    for (const [k, b] of this.buckets) if (now - b.idleSince() > olderThanMs) this.buckets.delete(k);
  }
}

interface Window {
  count: number;
  start: number;
  lockedUntil: number;
  strikes: number;
}

/**
 * Counts failures in a sliding window; reaching `max` locks the key for `lockMs`. With `backoff`, each further
 * lockout doubles (admin login: "then exponential backoff").
 */
export class AttemptLimiter {
  private readonly entries = new Map<string, Window>();
  readonly max: number;
  readonly windowMs: number;
  readonly lockMs: number;
  readonly backoff: boolean;
  constructor(opts: { max: number; windowMs: number; lockMs: number; backoff?: boolean }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.lockMs = opts.lockMs;
    this.backoff = opts.backoff ?? false;
  }
  /** Milliseconds until the key may try again, or 0. */
  lockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    return Math.max(0, e.lockedUntil - now);
  }
  fail(key: string, now = Date.now()): { locked: boolean; lockedForMs: number } {
    let e = this.entries.get(key);
    if (!e || now - e.start > this.windowMs) {
      e = { count: 0, start: now, lockedUntil: e?.lockedUntil ?? 0, strikes: e?.strikes ?? 0 };
      this.entries.set(key, e);
    }
    e.count++;
    if (e.count >= this.max) {
      const mult = this.backoff ? 2 ** e.strikes : 1;
      e.lockedUntil = now + this.lockMs * mult;
      e.strikes++;
      e.count = 0;
      e.start = now;
      return { locked: true, lockedForMs: e.lockedUntil - now };
    }
    return { locked: false, lockedForMs: 0 };
  }
  succeed(key: string): void {
    this.entries.delete(key);
  }
  sweep(now = Date.now()): void {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil < now && now - e.start > this.windowMs * 4) this.entries.delete(k);
    }
  }
}
