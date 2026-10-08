import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { activeLinks, addLink, removeLink, scopeOf } from '../../src/store/links.js';
import { tmpHome } from '../helpers.js';

const db = () => openDb(join(tmpHome(), 'state.db'));

describe('workspace links', () => {
  it('scope is the connected component of the undirected link graph', () => {
    const d = db();
    expect([...scopeOf(d, '/a')]).toEqual(['/a']);
    expect(addLink(d, '/b', '/a')).toBe(true);
    expect(addLink(d, '/a', '/b')).toBe(false); // already active, normalized a < b
    addLink(d, '/b', '/c');
    addLink(d, '/x', '/y');
    expect([...scopeOf(d, '/c')].sort()).toEqual(['/a', '/b', '/c']);
    expect(activeLinks(d).map((l) => [l.a, l.b])).toEqual([
      ['/a', '/b'],
      ['/b', '/c'],
      ['/x', '/y'],
    ]);
    expect(removeLink(d, '/b', '/a')).toBe(true);
    expect(removeLink(d, '/b', '/a')).toBe(false);
    expect([...scopeOf(d, '/a')]).toEqual(['/a']);
    expect([...scopeOf(d, '/c')].sort()).toEqual(['/b', '/c']);
    addLink(d, '/a', '/b'); // relink after unlink creates a new active row
    expect([...scopeOf(d, '/a')].sort()).toEqual(['/a', '/b', '/c']);
  });

  it('records every link and unlink append-only', () => {
    const d = db();
    addLink(d, '/a', '/b');
    removeLink(d, '/a', '/b');
    const events = d.prepare('SELECT a, b, action FROM workspace_link_events ORDER BY rowid').all();
    expect(events).toEqual([
      { a: '/a', b: '/b', action: 'link' },
      { a: '/a', b: '/b', action: 'unlink' },
    ]);
    expect(() => d.prepare('DELETE FROM workspace_link_events').run()).toThrow(/append-only/);
    expect(() => d.prepare(`UPDATE workspace_link_events SET action = 'link'`).run()).toThrow(/append-only/);
  });

  it('rejects linking a workspace to itself', () => {
    expect(() => addLink(db(), '/a', '/a')).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });
});
