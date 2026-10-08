import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import {
  activeThrottles,
  addMute,
  addSubscription,
  addThrottle,
  isMuted,
  isThrottled,
  releaseThrottle,
  removeMute,
  subscribersFor,
} from '../../src/store/subs.js';
import { tmpHome } from '../helpers.js';

describe('subs', () => {
  it('matches stream and kv-prefix subscriptions', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    addSubscription(db, 'x-a', 'stream:ci-results', 'low', { ok: false });
    addSubscription(db, 'x-b', 'kv:migrations/', 'normal', null);
    expect(subscribersFor(db, { kind: 'stream', stream: 'ci-results' })).toEqual([
      { session_name: 'x-a', priority: 'low', filter: { ok: false } },
    ]);
    expect(subscribersFor(db, { kind: 'kv', key: 'migrations/next' }).map((s) => s.session_name)).toEqual(['x-b']);
    expect(subscribersFor(db, { kind: 'kv', key: 'other' })).toEqual([]);
  });
  it('mutes by sender or stream, and unmutes', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    addMute(db, 'x-a', 'sender:chatty');
    expect(isMuted(db, 'x-a', 'chatty')).toBe(true);
    expect(isMuted(db, 'x-a', 'other')).toBe(false);
    addMute(db, 'x-a', 'stream:noise');
    expect(isMuted(db, 'x-a', 'wigwag', 'noise')).toBe(true);
    removeMute(db, 'x-a', 'sender:chatty');
    expect(isMuted(db, 'x-a', 'chatty')).toBe(false);
  });
  it('throttles are per pair and releasable', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    addThrottle(db, 'x-a', 'x-b');
    expect(isThrottled(db, 'x-a', 'x-b')).toBe(true);
    expect(isThrottled(db, 'x-b', 'x-a')).toBe(false);
    expect(activeThrottles(db)).toHaveLength(1);
    releaseThrottle(db, 'x-a', 'x-b');
    expect(isThrottled(db, 'x-a', 'x-b')).toBe(false);
  });
});
