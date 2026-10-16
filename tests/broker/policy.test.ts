import { describe, expect, it } from 'vitest';
import { decide } from '../../src/broker/policy.js';

const P = { action: 'push' };
const H = (reason: string) => ({ action: 'hold', reason });

describe('wake policy (spec §6)', () => {
  it('a disconnected Claude session keeps an active throttle for every priority', () => {
    for (const priority of ['urgent', 'normal', 'low'] as const) {
      expect(decide({ priority, recipient: 'disconnected', muted: false, throttled: true })).toEqual({
        action: 'hold',
        reason: 'throttled',
      });
    }
  });
  it('a Claude session whose MCP is disconnected holds even urgent items as disconnected (W8)', () => {
    for (const priority of ['urgent', 'normal', 'low'] as const) {
      expect(decide({ priority, recipient: 'disconnected', muted: false, throttled: false })).toEqual({
        action: 'hold',
        reason: 'disconnected',
      });
    }
  });
  it.each([
    ['urgent', 'idle', P],
    ['urgent', 'busy', P],
    ['urgent', 'offline', H('offline')],
    ['urgent', 'unbound', H('unbound')],
    ['normal', 'idle', P],
    ['normal', 'busy', P],
    ['normal', 'offline', H('offline')],
    ['normal', 'unbound', H('unbound')],
    ['low', 'idle', H('low')],
    ['low', 'busy', H('low')],
    ['low', 'offline', H('offline')],
    ['low', 'unbound', H('unbound')],
  ] as const)('%s → %s recipient', (priority, recipient, expected) => {
    expect(decide({ priority, recipient, muted: false, throttled: false })).toEqual(expected);
  });
  it('urgent bypasses mutes; normal is held as muted; throttles hold everything', () => {
    expect(decide({ priority: 'urgent', recipient: 'idle', muted: true, throttled: false })).toEqual(P);
    expect(decide({ priority: 'normal', recipient: 'idle', muted: true, throttled: false })).toEqual(H('muted'));
    expect(decide({ priority: 'urgent', recipient: 'idle', muted: false, throttled: true })).toEqual(H('throttled'));
  });
});

describe('wake policy for a Claude session without a usable channel (E-3)', () => {
  it.each([
    ['urgent', H('unbound')],
    ['normal', H('unbound')],
    ['low', H('low')],
  ] as const)('%s → no-channel recipient', (priority, expected) => {
    expect(decide({ priority, recipient: 'no-channel', muted: false, throttled: false })).toEqual(expected);
  });
  it('mutes and throttles keep their own hold reason', () => {
    expect(decide({ priority: 'normal', recipient: 'no-channel', muted: true, throttled: false })).toEqual(H('muted'));
    expect(decide({ priority: 'urgent', recipient: 'no-channel', muted: false, throttled: true })).toEqual(
      H('throttled'),
    );
  });
});
