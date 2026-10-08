import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { kvCas, kvGet, kvHistory, kvList } from '../../src/store/kv.js';
import { addLink, scopeFor } from '../../src/store/links.js';
import { tmpHome } from '../helpers.js';

const db = () => openDb(join(tmpHome(), 'state.db'));
const WS = '/w/a';

describe('kv', () => {
  it('create-only with expected=null, then CAS by version', () => {
    const d = db();
    expect(kvCas(d, scopeFor(d, WS), 'migrations/next', null, { n: 724 }, 'x-a', 1000)).toMatchObject({
      ok: true,
      version: 1,
    });
    const lose = kvCas(d, scopeFor(d, WS), 'migrations/next', null, { n: 725 }, 'x-b', 1000);
    expect(lose.ok).toBe(false);
    if (!lose.ok) expect(lose.current?.value).toEqual({ n: 724 });
    expect(kvCas(d, scopeFor(d, WS), 'migrations/next', 1, { n: 725 }, 'x-b', 1000)).toMatchObject({
      ok: true,
      version: 2,
    });
    const stale = kvCas(d, scopeFor(d, WS), 'migrations/next', 1, { n: 726 }, 'x-a', 1000);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.current?.version).toBe(2);
  });
  it('delete is a tombstone; history keeps every version; list hides tombstones', () => {
    const d = db();
    kvCas(d, scopeFor(d, WS), 'lane/a', null, 'x', 'x-a', 1000);
    kvCas(d, scopeFor(d, WS), 'lane/b', null, 'y', 'x-a', 1000);
    expect(kvCas(d, scopeFor(d, WS), 'lane/a', 1, null, 'x-a', 1000)).toMatchObject({ ok: true, version: 2 });
    expect(kvGet(d, scopeFor(d, WS), 'lane/a')?.value).toBeNull();
    expect(kvList(d, scopeFor(d, WS), 'lane/').map((r) => r.key)).toEqual(['lane/b']);
    expect(kvHistory(d, scopeFor(d, WS), 'lane/a').map((r) => [r.version, r.value])).toEqual([
      [1, 'x'],
      [2, null],
    ]);
    expect(kvCas(d, scopeFor(d, WS), 'lane/a', null, 'again', 'x-b', 1000)).toMatchObject({ ok: true, version: 3 });
  });
  it('validates key pattern and value size (UTF-8 bytes)', () => {
    const d = db();
    expect(() => kvCas(d, scopeFor(d, WS), 'Bad Key', null, 1, 'x-a', 1000)).toThrow(/key/);
    expect(() => kvCas(d, scopeFor(d, WS), 'k', null, 'é'.repeat(6), 'x-a', 13)).toThrow(/limit/);
  });
  it('each workspace owns its keys; linking makes a shared name a conflict until one side deletes', () => {
    const d = db();
    const A = () => scopeFor(d, '/w/a');
    const B = () => scopeFor(d, '/w/b');
    expect(kvCas(d, A(), 'lock', null, 'a', 'x-a', 1000)).toMatchObject({ ok: true, version: 1 });
    expect(kvCas(d, B(), 'lock', null, 'b', 'x-b', 1000)).toMatchObject({ ok: true, version: 1 });
    expect(kvGet(d, A(), 'lock')).toMatchObject({ value: 'a', workspace: '/w/a' });
    expect(kvGet(d, B(), 'lock')).toMatchObject({ value: 'b', workspace: '/w/b' });
    addLink(d, '/w/a', '/w/b');
    expect(() => kvGet(d, A(), 'lock')).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => kvGet(d, A(), 'lock')).toThrow(/\/w\/a.*\/w\/b/);
    expect(() => kvHistory(d, B(), 'lock')).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => kvCas(d, A(), 'lock', 1, 'a2', 'x-a', 1000)).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => kvGet(d, scopeFor(d, null), 'lock')).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(kvList(d, A(), '').map((r) => [r.key, r.workspace])).toEqual([
      ['lock', '/w/a'],
      ['lock', '/w/b'],
    ]);
    // one side deletes its own copy (delete prefers the caller's workspace) → the name resolves again
    expect(kvCas(d, B(), 'lock', 1, null, 'x-b', 1000)).toMatchObject({ ok: true, version: 2 });
    expect(kvGet(d, B(), 'lock')).toMatchObject({ value: 'a', workspace: '/w/a' });
    // R42-E: a write sees the key in two workspaces (A live, B tombstone) → still a conflict
    expect(() => kvCas(d, B(), 'lock', 1, 'from-b', 'x-b', 1000)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    // a new key is created in the caller's workspace
    expect(kvCas(d, B(), 'fresh', null, 1, 'x-b', 1000)).toMatchObject({ ok: true, version: 1 });
    expect(kvGet(d, A(), 'fresh')).toMatchObject({ workspace: '/w/b' });
    expect(kvGet(d, scopeFor(d, '/w/c'), 'fresh')).toBeNull();
  });
  it('I2: tombstones of one key in two linked workspaces make a CAS a conflict', () => {
    const d = db();
    for (const ws of ['/w/a', '/w/b']) {
      kvCas(d, scopeFor(d, ws), 'gone', null, 1, 'x', 1000);
      kvCas(d, scopeFor(d, ws), 'gone', 1, null, 'x', 1000);
    }
    addLink(d, '/w/a', '/w/b');
    expect(() => kvCas(d, scopeFor(d, '/w/a'), 'gone', null, 2, 'x', 1000)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(() => kvCas(d, scopeFor(d, '/w/b'), 'gone', 2, 3, 'x', 1000)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });
});
