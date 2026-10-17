import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/store/db.js';
import {
  assignedNames,
  attachConnection,
  bindAgentSession,
  claimName,
  createSession,
  findByAgentSessionId,
  getSession,
  markAllOffline,
  markDisconnectedIfCurrent,
  markOfflineIfCurrent,
  provisionalName,
  setAgentIdentity,
  setNameSource,
  setNativeName,
  setNativeRef,
  setParentState,
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

describe('v3 session fields', () => {
  it('claimName writes the name source when given and keeps it otherwise', () => {
    const a = mk();
    claimName(db, a.id, 'claude-x-abcd', 'provisional');
    expect(getSession(db, a.id)?.name_source).toBe('provisional');
    claimName(db, a.id, 'role-name', 'custom');
    expect(getSession(db, a.id)?.name_source).toBe('custom');
    claimName(db, a.id, 'other-name');
    expect(getSession(db, a.id)?.name_source).toBe('custom');
  });
  it('stores the native name, native ref and name source', () => {
    const a = mk();
    setNativeName(db, a.id, 'Node refactor');
    setNativeRef(db, a.id, '/p/sid.jsonl');
    setNameSource(db, a.id, 'native');
    expect(getSession(db, a.id)).toMatchObject({
      native_name: 'Node refactor',
      native_ref: '/p/sid.jsonl',
      name_source: 'native',
    });
  });
  it('connection generations: attach increments; only the current generation marks offline', () => {
    const a = mk();
    const g1 = attachConnection(db, a.id);
    const g2 = attachConnection(db, a.id);
    expect(g2).toBe(g1 + 1);
    expect(markOfflineIfCurrent(db, a.id, g1)).toBe(false);
    expect(getSession(db, a.id)?.state).toBe('online-idle');
    expect(markOfflineIfCurrent(db, a.id, g2)).toBe(true);
    expect(getSession(db, a.id)?.state).toBe('offline');
  });
  it('W8 link, parent state and agent identity', () => {
    const a = mk();
    const g = attachConnection(db, a.id);
    setAgentIdentity(db, a.id, 4242, 'darwin:Thu Oct 15 08:47:53 2026:501');
    setParentState(db, a.id, 'live');
    expect(getSession(db, a.id)).toMatchObject({
      link: 'connected',
      agent_pid: 4242,
      agent_start: 'darwin:Thu Oct 15 08:47:53 2026:501',
      parent_state: 'live',
    });
    expect(getSession(db, a.id)?.parent_checked_at).not.toBeNull();
    expect(markDisconnectedIfCurrent(db, a.id, g - 1, 'live')).toBe(false);
    expect(markDisconnectedIfCurrent(db, a.id, g, 'unknown')).toBe(true);
    expect(getSession(db, a.id)).toMatchObject({ state: 'online-idle', link: 'disconnected', parent_state: 'unknown' });
    attachConnection(db, a.id);
    expect(getSession(db, a.id)?.link).toBe('connected');
  });
});
