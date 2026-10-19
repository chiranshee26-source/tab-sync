/**
 * Hybrid Logical Clock (Kulkarni et al., 2014).
 *
 * Timestamps stay close to wall-clock time but are guaranteed to be
 * monotonic per tab and to move past any timestamp the tab has observed.
 * So an edit made *after* seeing another tab's value always wins over it,
 * even if Date.now() goes backwards. The node id breaks the remaining ties,
 * which makes the ordering total: two timestamps are equal only if they
 * come from the same tab and the same tick.
 */

export interface Timestamp {
  readonly wall: number;
  readonly counter: number;
  readonly node: string;
}

export const ZERO_TIMESTAMP: Timestamp = Object.freeze({ wall: 0, counter: 0, node: '' });

export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

export function isTimestamp(value: unknown): value is Timestamp {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(t.wall) &&
    (t.wall as number) >= 0 &&
    Number.isSafeInteger(t.counter) &&
    (t.counter as number) >= 0 &&
    typeof t.node === 'string' &&
    t.node.length <= 64
  );
}

export class HybridLogicalClock {
  private last: Timestamp;

  constructor(
    readonly node: string,
    private readonly physicalNow: () => number = Date.now,
  ) {
    this.last = { ...ZERO_TIMESTAMP, node };
  }

  /** Issues a timestamp for a local event. */
  now(): Timestamp {
    const wall = Math.max(this.last.wall, this.physicalNow());
    const counter = wall === this.last.wall ? this.last.counter + 1 : 0;
    this.last = { wall, counter, node: this.node };
    return this.last;
  }

  /** Advances the clock past a timestamp received from another tab. */
  observe(remote: Timestamp): void {
    const local = this.last;
    const wall = Math.max(local.wall, remote.wall, this.physicalNow());
    let counter = 0;
    if (wall === local.wall && wall === remote.wall) counter = Math.max(local.counter, remote.counter) + 1;
    else if (wall === local.wall) counter = local.counter + 1;
    else if (wall === remote.wall) counter = remote.counter + 1;
    this.last = { wall, counter, node: this.node };
  }
}
