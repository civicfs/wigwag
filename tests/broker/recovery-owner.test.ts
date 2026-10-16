import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { insertMessage } from '../../src/store/messages.js';
import { recordLineage, recoveryCandidates } from '../../src/store/recovery.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { mcpClient, ownerClient, startBroker, startTestBroker, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function mcp(home: string, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/Users/x/code/myproject',
    pid_chain: [500, 400],
    mcp_ppid: 400,
    ...extra,
  };
  const { client, welcome } = await mcpClient(home, hello);
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string } };
}

describe('owner recovery diagnostics (W7)', () => {
  it('lists duplicate slots and flags; retiring a slot removes it from candidates and duplicates', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const live = await mcp(home);
    const slot = (name: string) => {
      const s = createSession(broker.db, {
        agent: 'claude',
        cwd: '/w',
        workspace: '/w',
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(broker.db, s.id, name, 'custom');
      bindAgentSession(broker.db, s.id, 'sid-dup');
      setState(broker.db, s.id, 'offline');
      return s.id;
    };
    const [a, b] = [slot('dup-one'), slot('dup-two')];
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    const report = await o.call<{ duplicates: Array<{ native_id: string; session_ids: string[] }>; flags: unknown[] }>(
      'owner.recovery',
      {},
    );
    expect(report.duplicates).toEqual([
      expect.objectContaining({
        agent: 'claude',
        native_id: 'sid-dup',
        workspace: '/w',
        session_ids: expect.arrayContaining([a, b]),
      }),
    ]);
    await expect(o.call('owner.retire_slot', { session_id: live.welcome.session_id })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(o.call('owner.retire_slot', { session_id: 'ses-nope' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await o.call('owner.retire_slot', { session_id: a })).toEqual({ session_id: a });
    await expect(o.call('owner.retire_slot', { session_id: a })).rejects.toMatchObject({ code: 'conflict' });
    expect((await o.call<{ duplicates: unknown[] }>('owner.recovery', {})).duplicates).toEqual([]);
    expect(
      recoveryCandidates(broker.db, { agent: 'claude', native: 'sid-dup', workspace: '/w', exceptId: 'x' }).map(
        (s) => s.id,
      ),
    ).toEqual([b]);
  });

  it.each(['pending', 'held', 'failed', 'stuck'])(
    'reports and protects a slot with %s backlog; force resolves its flags',
    async (state) => {
      const { home, broker } = await startTestBroker();
      cleanup.push(() => broker.stop());
      const slots = ['protected-one', 'duplicate-two'].map((name) => {
        const s = createSession(broker.db, {
          agent: 'claude',
          cwd: '/w',
          workspace: '/w',
          pid_chain: [],
          mcp_ppid: null,
        });
        claimName(broker.db, s.id, name, 'custom');
        bindAgentSession(broker.db, s.id, 'sid-protected');
        setState(broker.db, s.id, 'offline');
        return s.id;
      });
      const message = insertMessage(
        broker.db,
        {
          from_name: 'owner',
          to_target: 'protected-one',
          kind: 'message',
          priority: 'low',
          subject: 'retained',
          body: 'b',
          attachments: [],
          reply_to: null,
          request_id: null,
          expires_at: null,
          stream: null,
        },
        ['protected-one'],
      );
      broker.db.prepare('UPDATE deliveries SET state=? WHERE message_id=?').run(state, message.id);
      const shell = createSession(broker.db, {
        agent: 'claude',
        cwd: '/w',
        workspace: '/w',
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(broker.db, shell.id, 'refused-shell', 'native');
      bindAgentSession(broker.db, shell.id, 'sid-protected');
      setState(broker.db, shell.id, 'offline');
      recordLineage(broker.db, {
        agent: 'claude',
        native_id: 'sid-protected',
        workspace: '/w',
        session_id: shell.id,
        cause: 'resume',
        outcome: 'flagged',
        reason: 'ambiguous',
        evidence: { candidates: slots },
      });
      const owner = await ownerClient(home);
      cleanup.push(() => owner.close());
      const report = await owner.call<{ duplicates: Array<{ slots: Array<Record<string, unknown>> }> }>(
        'owner.recovery',
      );
      expect(report.duplicates[0].slots).toContainEqual(
        expect.objectContaining({
          session_id: slots[0],
          name: 'protected-one',
          name_source: 'custom',
          state: 'offline',
          link: 'connected',
          held_pending: ['pending', 'held'].includes(state) ? 1 : 0,
          undelivered: 1,
          assignments: [],
          last_seen_at: expect.any(String),
        }),
      );
      await expect(owner.call('owner.retire_slot', { session_id: slots[0] })).rejects.toMatchObject({
        code: 'conflict',
        message: expect.stringMatching(/1 undelivered/),
      });
      expect(getSession(broker.db, slots[0])?.retired_at).toBeNull();
      await owner.call('owner.retire_slot', { session_id: slots[0], force: true });
      expect((await owner.call<{ flags: unknown[] }>('owner.recovery')).flags).toEqual([]);
      expect(
        recoveryCandidates(broker.db, {
          agent: 'claude',
          native: 'sid-protected',
          workspace: '/w',
          exceptId: 'new',
        }).map((s) => s.id),
      ).toEqual([slots[1]]);
    },
  );

  it('reports active assignment roles and refuses retirement without force', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const make = (name: string, native: string) => {
      const s = createSession(broker.db, {
        agent: 'claude',
        cwd: '/w',
        workspace: '/w',
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(broker.db, s.id, name, 'custom');
      bindAgentSession(broker.db, s.id, native);
      setState(broker.db, s.id, 'offline');
      return s.id;
    };
    const lead = make('lead-protected', 'lead-native');
    const worker = make('worker-protected', 'worker-native');
    make('lead-duplicate', 'lead-native');
    make('worker-duplicate', 'worker-native');
    const m = insertMessage(
      broker.db,
      {
        from_name: 'owner',
        to_target: 'worker-protected',
        kind: 'message',
        priority: 'low',
        subject: 'task',
        body: 'b',
        attachments: [],
        reply_to: null,
        request_id: null,
        expires_at: null,
        stream: null,
      },
      ['worker-protected'],
    );
    broker.db.prepare("UPDATE deliveries SET state='read' WHERE message_id=?").run(m.id);
    broker.db
      .prepare('INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?,NULL)')
      .run('req-active', lead, 'lead-native', worker, 'worker-native', 'k', '{}', m.id, 't');
    const owner = await ownerClient(home);
    cleanup.push(() => owner.close());
    const report = await owner.call<{ duplicates: Array<{ slots: Array<Record<string, unknown>> }> }>('owner.recovery');
    const slots = report.duplicates.flatMap((d) => d.slots);
    expect(slots).toContainEqual(
      expect.objectContaining({ session_id: lead, assignments: [{ id: 'req-active', role: 'orchestrator' }] }),
    );
    expect(slots).toContainEqual(
      expect.objectContaining({ session_id: worker, assignments: [{ id: 'req-active', role: 'worker' }] }),
    );
    await expect(owner.call('owner.retire_slot', { session_id: worker })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/req-active/),
    });
    await owner.call('owner.retire_slot', { session_id: worker, force: true });
  });

  it('whoami states what this session supports', async () => {
    const home = tmpHome();
    const broker = await startBroker(home);
    cleanup.push(() => broker.stop());
    const claude = await mcp(home, { channel: false });
    expect(await claude.client.call('session.whoami')).toMatchObject({
      capabilities: {
        native_names: 'claude-hook-sidecar',
        resume_recovery: 'native-id',
        delivery: 'hook-boundary',
        parent_liveness: 'unavailable', // never hook-bound, so no parent identity was recorded
      },
    });
    const cx = await mcp(home, { agent: 'codex', mcp_ppid: 401 });
    await cx.client.call('session.bind', { agent_session_id: 't-x' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await cx.client.call('session.whoami')).toMatchObject({
      capabilities: {
        native_names: 'codex-session-index',
        resume_recovery: 'unavailable',
        delivery: 'hook-boundary',
        codex_push: 'held',
        codex_push_reason: 'app-server-unavailable',
        parent_liveness: 'unavailable',
      },
    });
  });

  it('codex with a reachable app-server still requires a trusted concrete ID', async () => {
    class App extends EventEmitter {
      async connect() {}
      async call(_m: string, p: { threadId: string }) {
        return { thread: { id: p.threadId, sessionId: p.threadId, parentThreadId: null, source: 'cli', name: null } };
      }
      send() {}
      close() {}
    }
    const home = tmpHome();
    const broker = await startBroker(home, {
      codexNames: new CodexNames({ factory: () => new App(), indexPath: `${home}/missing-session-index.jsonl` }),
    });
    cleanup.push(() => broker.stop());
    const cx = await mcp(home, { agent: 'codex' });
    await cx.client.call('session.bind', { agent_session_id: 't-y' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await cx.client.call('session.whoami')).toMatchObject({
      capabilities: {
        native_names: 'codex-app-server',
        resume_recovery: 'unavailable',
        resume_recovery_reason: 'codex-thread-id-untrusted',
        parent_liveness: 'thread-loaded',
      },
    });
  });
});
