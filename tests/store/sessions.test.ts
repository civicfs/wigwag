import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/store/db.js';
import {
  assignedNames,
  bindAgentSession,
  claimName,
  createSession,
  findByAgentSessionId,
  getSession,
  markAllOffline,
  provisionalName,
  setState,
} from '../../src/store/sessions.js';
import { tmpHome } from '../helpers.js';

let db: Db;
beforeEach(() => {
  db = openDb(join(tmpHome(), 'state.db'));
});
const mk = (agent: 'claude' | 'codex' = 'claude') =>
  createSession(db, { agent, cwd: '/w/myproject', pid_chain: [10, 9, 1], mcp_ppid: 9 });

describe('sessions', () => {
  it('creates an online-idle unnamed session with ses- id and SPAWN provisions null', () => {
    const s = mk();
    expect(s.id).toMatch(/^ses-/);
    expect(s.state).toBe('online-idle');
    expect(s.name).toBeNull();
    expect(s.transport).toBe('claude-channel');
    expect(s.spawned_by).toBeNull();
    expect(s.launch_json).toBeNull();
    expect(mk('codex').transport).toBe('codex-queue');
  });
  it('rejects a name held by a live session and reports the holder', () => {
    const a = mk();
    const b = mk();
    expect(claimName(db, a.id, 'codex-merger')).toEqual({ ok: true });
    const r = claimName(db, b.id, 'codex-merger');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.holder.id).toBe(a.id);
  });
  it('lets a new session take the name of an offline holder', () => {
    const a = mk();
    const b = mk();
    claimName(db, a.id, 'reviewer');
    setState(db, a.id, 'offline');
    expect(claimName(db, b.id, 'reviewer')).toEqual({ ok: true });
    expect(getSession(db, a.id)?.name).toBeNull();
    expect(getSession(db, b.id)?.name).toBe('reviewer');
    expect(assignedNames(db)).toEqual(['reviewer']);
  });
  it('renaming releases the previous name', () => {
    const a = mk();
    claimName(db, a.id, 'one-name');
    claimName(db, a.id, 'two-name');
    expect(assignedNames(db)).toEqual(['two-name']);
  });
  it('binds agent session ids and marks all offline', () => {
    const a = mk();
    bindAgentSession(db, a.id, 'thread-123');
    expect(findByAgentSessionId(db, 'thread-123')?.id).toBe(a.id);
    markAllOffline(db);
    expect(getSession(db, a.id)?.state).toBe('offline');
  });
});

describe('provisionalName', () => {
  it.each([[`/w/${'a'.repeat(200)}`], ['/w/Weird Dir!!_é€'], ['/'], ['/w/---'], ['/w/123']])(
    'matches the name pattern for %s',
    (cwd) => {
      for (const agent of ['claude', 'codex'] as const) {
        expect(provisionalName(agent, cwd, 'abcd')).toMatch(/^[a-z][a-z0-9-]{1,47}$/);
      }
    },
  );
});
