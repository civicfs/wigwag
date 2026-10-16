import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parentOnDisconnect } from '../../src/broker/liveness.js';
import { type Db, nowIso, openDb } from '../../src/store/db.js';
import { insertMessage } from '../../src/store/messages.js';
import {
  adoptCanonical,
  listLineage,
  liveNativeHolders,
  recordLineage,
  recoveryCandidates,
} from '../../src/store/recovery.js';
import {
  type Agent,
  bindAgentSession,
  claimName,
  createSession,
  getSession,
  markDisconnectedIfCurrent,
  type SessionRow,
  setAgentIdentity,
  setParentState,
  setState,
} from '../../src/store/sessions.js';
import { tmpHome } from '../helpers.js';

let db: Db;
beforeEach(() => {
  db = openDb(join(tmpHome(), 'state.db'));
});
afterEach(() => db.close());
const mk = (
  o: {
    agent?: Agent;
    ws?: string;
    name?: string;
    native?: string;
    offline?: boolean;
    detached?: boolean;
    ppid?: number;
  } = {},
) => {
  const ws = o.ws ?? '/w';
  const s = createSession(db, {
    agent: o.agent ?? 'claude',
    cwd: ws,
    workspace: ws,
    pid_chain: [o.ppid ?? 9, 1],
    mcp_ppid: o.ppid ?? 9,
  });
  if (o.name) claimName(db, s.id, o.name, 'custom');
  if (o.native) bindAgentSession(db, s.id, o.native);
  if (o.offline) setState(db, s.id, 'offline');
  // W8: live, but its MCP link dropped while the parent stays open.
  if (o.detached) markDisconnectedIfCurrent(db, s.id, 0, 'live');
  return getSession(db, s.id) as SessionRow;
};
const assign = (worker: SessionRow, lead: SessionRow) => {
  const m = insertMessage(
    db,
    {
      from_name: lead.name as string,
      to_target: worker.name as string,
      kind: 'message',
      priority: 'normal',
      subject: 's',
      body: 'b',
      attachments: [],
      reply_to: null,
      request_id: null,
      expires_at: null,
      stream: null,
    },
    [worker.name as string],
  );
  db.prepare('INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(
    'req-a1',
    lead.id,
    lead.agent_session_id,
    worker.id,
    worker.agent_session_id,
    'k',
    '{}',
    m.id,
    nowIso(),
  );
  const relay = db.prepare(
    'INSERT INTO question_relays (id,assignment_id,native_session_id,turn_id,tool_use_id,kind,questions_json,message_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  relay.run(
    'req-q1',
    'req-a1',
    worker.agent_session_id,
    't1',
    'u1',
    'claude',
    '[]',
    m.id,
    'pending',
    nowIso(),
    nowIso(),
  );
  relay.run(
    'req-q2',
    'req-a1',
    worker.agent_session_id,
    't1',
    'u2',
    'codex_async',
    '[]',
    m.id,
    'pending',
    nowIso(),
    nowIso(),
  );
};

describe('recovery candidates', () => {
  it('only offline, unretired, same agent/native/workspace slots that are named or assigned', () => {
    const me = mk({ ppid: 600 });
    const good = mk({ name: 'worker-one', native: 'sid-1', offline: true });
    mk({ name: 'live-one', native: 'sid-1' }); // live
    mk({ name: 'other-ws', native: 'sid-1', offline: true, ws: '/elsewhere' });
    mk({ agent: 'codex', name: 'codex-one', native: 'sid-1', offline: true });
    mk({ native: 'sid-1', offline: true }); // husk: unnamed, unassigned
    const retired = mk({ name: 'retired-one', native: 'sid-1', offline: true });
    db.prepare('UPDATE sessions SET retired_at = ? WHERE id = ?').run(nowIso(), retired.id);
    expect(
      recoveryCandidates(db, { agent: 'claude', native: 'sid-1', workspace: '/w', exceptId: me.id }).map((s) => s.id),
    ).toEqual([good.id]);
    expect(liveNativeHolders(db, 'claude', 'sid-1', me.id).map((s) => s.name)).toEqual(['live-one']);
  });

  it('never treats a retired row as a live native holder', () => {
    const s = mk({ native: 'sid-retired', name: 'retired-role' });
    db.prepare('UPDATE sessions SET retired_at = ? WHERE id = ?').run(nowIso(), s.id);
    expect(liveNativeHolders(db, 'claude', 'sid-retired', 'other')).toEqual([]);
  });

  it('a link-disconnected slot (W8) is a candidate, not a live holder, and can be adopted', () => {
    const me = mk({ agent: 'codex', ppid: 600 });
    const detached = mk({ agent: 'codex', name: 'codex-helper', native: 'T', detached: true });
    expect(liveNativeHolders(db, 'codex', 'T', me.id)).toEqual([]);
    expect(
      recoveryCandidates(db, { agent: 'codex', native: 'T', workspace: '/w', exceptId: me.id }).map((s) => s.id),
    ).toEqual([detached.id]);
    const r = adoptCanonical(db, {
      provisionalId: me.id,
      canonicalId: detached.id,
      native: 'T',
      state: 'online-idle',
      evidence: {},
    });
    expect(r.ok).toBe(true);
    expect(getSession(db, detached.id)).toMatchObject({
      link: 'connected',
      state: 'online-idle',
      name: 'codex-helper',
    });
  });
});

describe('adoptCanonical', () => {
  it.each([false, true])(
    'replaces stale canonical parent identity during adoption (new identity available: %s)',
    (hasIdentity) => {
      const c = mk({ name: 'worker-one', native: 'sid-1', offline: true, ppid: 4242 });
      setAgentIdentity(db, c.id, 4242, 'old-start');
      setParentState(db, c.id, 'live');
      const p = mk({ name: 'new-slot', ppid: 4242 });
      if (hasIdentity) {
        setAgentIdentity(db, p.id, 4242, 'new-start');
        setParentState(db, p.id, 'live');
      }
      const current = getSession(db, p.id) as SessionRow;
      const r = adoptCanonical(db, {
        provisionalId: p.id,
        canonicalId: c.id,
        native: 'sid-1',
        state: 'online-idle',
        evidence: {},
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.canonical).toMatchObject({
        agent_pid: current.agent_pid,
        agent_start: current.agent_start,
        parent_state: current.parent_state,
        parent_checked_at: current.parent_checked_at,
      });
      if (hasIdentity)
        expect(parentOnDisconnect(r.canonical, () => new Map([[4242, 'new-start']]), false)).toBe('live');
    },
  );

  it('moves the live connection onto the canonical slot and retires the provisional one', () => {
    const lead = mk({ name: 'lead-one', native: 'lead-native', ppid: 100 });
    const c = mk({ name: 'worker-one', native: 'sid-1' });
    assign(c, lead);
    db.prepare('INSERT INTO question_integrations VALUES (?, ?, ?)').run(c.id, 'sid-1', nowIso());
    setState(db, c.id, 'offline');
    const p = mk({ name: 'claude-w-abcd', ppid: 600 });
    const r = adoptCanonical(db, {
      provisionalId: p.id,
      canonicalId: c.id,
      native: 'sid-1',
      state: 'online-idle',
      evidence: { hook: 'test' },
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ fromName: 'claude-w-abcd', fromSource: 'custom', cancelledRelays: ['req-q1'] });
    expect(getSession(db, c.id)).toMatchObject({
      state: 'online-idle',
      name: 'worker-one',
      agent_session_id: 'sid-1',
      mcp_ppid: 600,
      conn_generation: r.generation,
    });
    expect(getSession(db, p.id)).toMatchObject({
      state: 'offline',
      name: null,
      agent_session_id: null,
      retired_into: c.id,
    });
    const relays = db.prepare('SELECT id, state FROM question_relays ORDER BY id').all();
    expect(relays).toEqual([
      { id: 'req-q1', state: 'cancelled' },
      { id: 'req-q2', state: 'pending' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM question_integrations').get()).toEqual({ n: 0 });
    expect(listLineage(db, { limit: 10 })).toMatchObject([
      { session_id: p.id, canonical_session_id: c.id, cause: 'resume', outcome: 'adopted', evidence: { hook: 'test' } },
    ]);
  });

  it('a canonical slot that lost its name takes the provisional name', () => {
    const c = mk({ native: 'sid-1' });
    const p = mk({ name: 'claude-w-abcd', ppid: 600 });
    setState(db, c.id, 'offline');
    const r = adoptCanonical(db, {
      provisionalId: p.id,
      canonicalId: c.id,
      native: 'sid-1',
      state: 'online-busy',
      evidence: {},
    });
    expect(r.ok).toBe(true);
    expect(getSession(db, c.id)).toMatchObject({ name: 'claude-w-abcd', state: 'online-busy' });
  });

  it('refuses a live canonical, a live holder, and a provisional bound to another conversation', () => {
    const c = mk({ name: 'worker-one', native: 'sid-1' });
    const p = mk({ ppid: 600 });
    const args = {
      provisionalId: p.id,
      canonicalId: c.id,
      native: 'sid-1',
      state: 'online-idle' as const,
      evidence: {},
    };
    expect(adoptCanonical(db, args)).toEqual({ ok: false, reason: 'canonical-changed' });
    setState(db, c.id, 'offline');
    const holder = mk({ name: 'holder-one', native: 'sid-1', ppid: 700 });
    expect(adoptCanonical(db, args)).toEqual({ ok: false, reason: 'live-holder' });
    setState(db, holder.id, 'offline');
    bindAgentSession(db, p.id, 'sid-other');
    expect(adoptCanonical(db, args)).toEqual({ ok: false, reason: 'provisional-changed' });
    expect(getSession(db, c.id)?.state).toBe('offline');
  });

  it('records flagged lineage that listLineage filters', () => {
    const p = mk();
    recordLineage(db, {
      agent: 'claude',
      native_id: 'sid-9',
      workspace: '/w',
      session_id: p.id,
      cause: 'resume',
      outcome: 'flagged',
      reason: 'ambiguous',
      evidence: { candidates: ['a', 'b'] },
    });
    recordLineage(db, {
      agent: 'claude',
      native_id: 'sid-9',
      workspace: '/w',
      session_id: p.id,
      cause: 'switch',
      outcome: 'observed',
      evidence: {},
    });
    expect(listLineage(db, { outcome: 'flagged', unresolved: true, limit: 10 })).toMatchObject([
      { reason: 'ambiguous', evidence: { candidates: ['a', 'b'] } },
    ]);
  });
});
