import { describe, expect, it } from 'vitest';
import { WakeLimiter } from '../../src/broker/ratelimit.js';

describe('WakeLimiter', () => {
  it('allows max pushes per window per pair, then refuses; window slides; reset clears', () => {
    let t = 0;
    const l = new WakeLimiter(2, 1000, () => t);
    expect(l.tryConsume('a-a', 'b-b')).toBe(true);
    expect(l.tryConsume('a-a', 'b-b')).toBe(true);
    expect(l.tryConsume('a-a', 'b-b')).toBe(false);
    expect(l.tryConsume('a-a', 'c-c')).toBe(true);
    t = 1001;
    expect(l.tryConsume('a-a', 'b-b')).toBe(true);
    l.tryConsume('a-a', 'b-b');
    l.reset('a-a', 'b-b');
    expect(l.tryConsume('a-a', 'b-b')).toBe(true);
  });

  it('forgets pairs whose window has fully expired', () => {
    let t = 0;
    const l = new WakeLimiter(2, 1000, () => t);
    l.tryConsume('a-a', 'b-b');
    t = 2000;
    l.tryConsume('c-c', 'd-d');
    expect((l as unknown as { hits: Map<string, number[]> }).hits.size).toBe(1);
  });
});
