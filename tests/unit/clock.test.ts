import { describe, expect, it } from 'vitest';
import { compareTimestamps, HybridLogicalClock, isTimestamp } from '../../src/clock';

describe('HybridLogicalClock', () => {
  it('is strictly monotonic even when the wall clock goes backwards', () => {
    let wall = 1000;
    const clock = new HybridLogicalClock('a', () => wall);
    const first = clock.now();
    wall = 500;
    const second = clock.now();
    expect(compareTimestamps(second, first)).toBe(1);
    expect(second.wall).toBe(1000);
    expect(second.counter).toBe(1);
  });

  it('moves past observed remote timestamps (causality beats clock skew)', () => {
    const clock = new HybridLogicalClock('b', () => 100);
    clock.observe({ wall: 5000, counter: 7, node: 'a' });
    const next = clock.now();
    expect(compareTimestamps(next, { wall: 5000, counter: 7, node: 'a' })).toBe(1);
  });

  it('resets the counter when physical time advances', () => {
    let wall = 10;
    const clock = new HybridLogicalClock('a', () => wall);
    clock.now();
    clock.now();
    wall = 11;
    expect(clock.now()).toEqual({ wall: 11, counter: 0, node: 'a' });
  });

  it('orders timestamps totally, using node id as the final tie-breaker', () => {
    expect(compareTimestamps({ wall: 1, counter: 0, node: 'a' }, { wall: 1, counter: 0, node: 'b' })).toBe(-1);
    expect(compareTimestamps({ wall: 1, counter: 1, node: 'a' }, { wall: 1, counter: 0, node: 'b' })).toBe(1);
    expect(compareTimestamps({ wall: 2, counter: 0, node: 'a' }, { wall: 1, counter: 9, node: 'z' })).toBe(1);
  });

  it('validates untrusted timestamps', () => {
    expect(isTimestamp({ wall: 1, counter: 0, node: 'x' })).toBe(true);
    expect(isTimestamp({ wall: -1, counter: 0, node: 'x' })).toBe(false);
    expect(isTimestamp({ wall: 1.5, counter: 0, node: 'x' })).toBe(false);
    expect(isTimestamp({ wall: 1, counter: 0 })).toBe(false);
    expect(isTimestamp(null)).toBe(false);
  });
});
