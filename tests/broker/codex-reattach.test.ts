import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import type { AppFrame } from '../../src/questions/app-server.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { recordLineage } from '../../src/store/recovery.js';
import { bindAgentSession, claimName, createSession, getSession } from '../../src/store/sessions.js';
import { mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
class Metadata extends EventEmitter {
  loaded = ['T'];
  root = true;
  down = false;
  pauseRead?: { entered: () => void; gate: Promise<void> };
  async connect() {}
  async call(method: string, p: { threadId?: string }) {
    if (this.down) throw new Error('fixture unavailable');
    if (method === 'thread/loaded/list') return { data: this.loaded };
    if (this.pauseRead) {
      const pause = this.pauseRead;
      this.pauseRead = undefined;
      pause.entered();
      await pause.gate;
    }
    const child = p.threadId === 'child' || !this.root;
    return {
      thread: {
        id: p.threadId,
        sessionId: child ? 'T' : p.threadId,
        parentThreadId: child ? 'parent' : null,
        source: child ? { subAgent: 'review' } : 'cli',
      },
    };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
type NativeQuestions = { request: AppFrame | null; turns: unknown[]; unavailable: boolean; apps: Questions[] };
class Questions extends EventEmitter {
  sent: unknown[] = [];
  closed = false;
  constructor(private readonly state: NativeQuestions) {
    super();
  }
  async connect() {}
  async call(method: string) {
    if (this.state.unavailable && ['thread/resume', 'thread/read'].includes(method))
      throw new Error('fixture replay unavailable');
    if (method === 'thread/resume' && this.state.request) this.emit('message', this.state.request);
    return { thread: { turns: this.state.turns } };
  }
  send(frame: unknown) {
    this.sent.push(frame);
  }
  close() {
    this.closed = true;
    this.emit('disconnected');
  }
}
async function boot() {
  const home = tmpHome(),
    app = new Metadata();
  const nativeQuestions: NativeQuestions = { request: null, turns: [], unavailable: false, apps: [] };
  const broker = await startBroker(home, {
    codexNames: new CodexNames({ factory: () => app, indexPath: join(home, 'missing-index') }),
    codexQuestionFactory: () => {
      const q = new Questions(nativeQuestions);
      nativeQuestions.apps.push(q);
      return q;
    },
    transports: {
      claude: { kind: 'claude-channel', async push() {} },
      codex: { kind: 'codex-queue', async push() {} },
    },
  });
  cleanup.push(() => broker.stop());
  const connect = async (extra = {}) => {
    const c = await mcpClient(home, { agent: 'codex', cwd: home, ...extra });
    cleanup.push(() => c.client.destroy());
    return c;
  };
  const old = await connect({ requested_name: 'cx-worker' });
  await old.client.call('session.bind', { agent_session_id: 'T', question_relay_version: 1 });
  const lead = await mcpClient(home, { requested_name: 'lead-one', cwd: home });
  cleanup.push(() => lead.client.destroy());
  await lead.client.call('session.bind', { agent_session_id: 'L' });
  const assignment = await lead.client.call<{ id: string }>('assignment.delegate', {
    to: 'cx-worker',
    subject: 'task',
    body: 'retained',
    idempotency_key: 'key',
  });
  const owner = await ownerClient(home);
  cleanup.push(() => owner.destroy());
  const mail = await owner.call<{ id: string }>('owner.send', {
    to: 'cx-worker',
    subject: 'private',
    body: 'old-private-mail',
    priority: 'low',
    attach_paths: [],
  });
  await until(() => deliveriesOfMessage(broker.db, mail.id)[0]?.state === 'held');
  const disconnect = async () => {
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.link === 'disconnected');
    await broker.liveness?.probeNow();
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      parent_state: 'live',
      link: 'disconnected',
    });
  };
  return { home, broker, app, connect, old, lead, nativeQuestions, assignment, mail, owner, disconnect };
}
describe('verified Codex MCP reattachment without a remembered slot', () => {
  it.each([
    'active',
    'answered',
    'already-sent',
    'native-resolved',
    'turn-ended',
    'replay-unavailable',
    'request-id-changed',
  ])('revalidates a preserved synchronous native question (%s) before submitting anything', async (scenario) => {
    const f = await boot();
    const q = f.broker.questions.capture(f.old.welcome.session_id, {
      native_session_id: 'T',
      turn_id: 'turn1',
      tool_use_id: 'call1',
      kind: 'codex',
      questions: [
        {
          id: 'q1',
          header: '',
          question: 'Which?',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });
    if (!q) throw new Error('missing fixture relay');
    const oldApp = f.nativeQuestions.apps.at(-1);
    if (!oldApp) throw new Error('missing fixture native attachment');
    const request: AppFrame = {
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'T',
        turnId: 'turn1',
        itemId: 'call1',
        questions: [
          { id: 'q1', header: '', question: 'Which?', options: [{ label: 'A', description: '' }], isOther: true },
        ],
      },
    };
    if (!['answered', 'replay-unavailable'].includes(scenario)) oldApp.emit('message', request);
    if (['answered', 'replay-unavailable'].includes(scenario))
      await f.lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    if (scenario === 'already-sent')
      await f.lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    expect(oldApp.sent).toHaveLength(scenario === 'already-sent' ? 1 : 0);
    await f.disconnect();
    f.nativeQuestions.request = request;
    if (scenario === 'native-resolved') {
      f.nativeQuestions.request = null;
      oldApp.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'T', requestId: 42 } });
    }
    if (scenario === 'turn-ended') {
      f.nativeQuestions.request = null;
      f.nativeQuestions.turns = [{ id: 'turn1', status: 'completed', items: [] }];
    }
    if (scenario === 'replay-unavailable') f.nativeQuestions.unavailable = true;
    if (scenario === 'request-id-changed') f.nativeQuestions.request = { ...request, id: 43 };
    const fresh = await f.connect();
    await fresh.client.call('session.bind', { agent_session_id: 'T', question_relay_version: 1 });
    if (['active', 'answered', 'already-sent'].includes(scenario)) {
      expect(f.broker.questions.get(q.id)?.state).toBe(scenario === 'active' ? 'pending' : 'answered');
      if (scenario === 'active')
        await f.lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
      await until(() => f.nativeQuestions.apps.flatMap((app) => app.sent).length === 1);
      const applied = f.nativeQuestions.apps.at(-1);
      expect(applied).not.toBe(oldApp);
      expect(f.nativeQuestions.apps.flatMap((app) => app.sent)[0]).toMatchObject({ id: 42 });
      applied?.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'T', requestId: 42 } });
      await until(() => f.broker.questions.get(q.id)?.state === 'applied');
      f.broker.questions.emit('changed');
      expect(f.nativeQuestions.apps.flatMap((app) => app.sent)).toHaveLength(1);
    } else if (['native-resolved', 'turn-ended'].includes(scenario)) {
      await until(() => f.broker.questions.get(q.id)?.state === 'cancelled');
      expect(f.broker.questions.get(q.id)?.error).toMatch(/Native.*(resolved|ended)/);
      expect(f.nativeQuestions.apps.flatMap((app) => app.sent)).toEqual([]);
    } else {
      await until(() => f.broker.questions.codexWaiting.has(f.old.welcome.session_id), 1000);
      expect(f.broker.questions.get(q.id)?.state).toBe(scenario === 'replay-unavailable' ? 'answered' : 'pending');
      expect(f.nativeQuestions.apps.flatMap((app) => app.sent)).toEqual([]);
      expect(JSON.stringify(await fresh.client.call('session.whoami'))).toContain(
        scenario === 'replay-unavailable' ? 'question-revalidation-unavailable' : 'native-request-unverified',
      );
      if (scenario === 'replay-unavailable') {
        f.nativeQuestions.unavailable = false;
        await fresh.client.call('session.turn', { phase: 'started' });
        await until(() => f.nativeQuestions.apps.flatMap((app) => app.sent).length === 1, 1000);
        f.nativeQuestions.apps
          .at(-1)
          ?.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'T', requestId: 42 } });
        await until(() => f.broker.questions.get(q.id)?.state === 'applied', 1000);
      }
    }
  });
  it.each([
    'connected',
    'ambiguous',
    'unloaded',
    'non-root',
    'metadata-down',
    'unsupported-old',
    'unsupported-new',
    'switched-away',
    'wrong-workspace',
    'descendant-id',
    'legacy-new',
  ])('refuses %s reattachment without moving mail or assignment', async (condition) => {
    const f = await boot();
    if (condition !== 'connected') await f.disconnect();
    if (condition === 'ambiguous') {
      const old = getSession(f.broker.db, f.old.welcome.session_id);
      if (!old) throw new Error('missing fixture slot');
      const duplicate = createSession(f.broker.db, {
        agent: 'codex',
        cwd: f.home,
        workspace: old.workspace,
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(f.broker.db, duplicate.id, 'another-worker', 'custom');
      bindAgentSession(f.broker.db, duplicate.id, 'T');
      f.broker.db
        .prepare(
          "UPDATE sessions SET link='disconnected',bind_origin='hook-verified',host_client_name='codex-mcp-client',host_client_version='0.162.1' WHERE id=?",
        )
        .run(duplicate.id);
    }
    if (condition === 'unloaded') f.app.loaded = [];
    if (condition === 'non-root') f.app.root = false;
    if (condition === 'metadata-down') f.app.down = true;
    if (condition === 'unsupported-old')
      f.broker.db
        .prepare("UPDATE sessions SET host_client_version='not-trusted' WHERE id=?")
        .run(f.old.welcome.session_id);
    if (condition === 'switched-away')
      recordLineage(f.broker.db, {
        agent: 'codex',
        native_id: 'other-T',
        previous_native_id: 'T',
        workspace: getSession(f.broker.db, f.old.welcome.session_id)?.workspace ?? '',
        session_id: f.old.welcome.session_id,
        cause: 'switch',
        outcome: 'observed',
        reason: 'conversation-split',
        evidence: {},
      });
    const fresh = await f.connect({
      ...(condition === 'unsupported-new' ? { host_client: { name: 'codex-mcp-client', version: 'not-trusted' } } : {}),
      ...(condition === 'legacy-new' ? { version: undefined, schema_version: undefined } : {}),
      ...(condition === 'wrong-workspace' ? { cwd: join(f.home, 'other-workspace') } : {}),
    });
    await expect(
      fresh.client.call('session.bind', {
        agent_session_id: 'T',
        ...(condition === 'descendant-id'
          ? { hook_origin: { name: 'codex-mcp-client', version: '0.162.1', thread_id: 'child' } }
          : {}),
      }),
    ).rejects.toBeDefined();
    expect(await fresh.client.call('session.whoami')).toMatchObject({ id: fresh.welcome.session_id, bound: false });
    expect(getSession(f.broker.db, f.old.welcome.session_id)?.agent_session_id).toBe('T');
    expect(f.broker.questions.assignment(f.assignment.id)?.worker_session_id).toBe(f.old.welcome.session_id);
    expect(deliveriesOfMessage(f.broker.db, f.mail.id)[0]?.state).toBe('held');
    expect(JSON.stringify(await fresh.client.call('msg.inbox'))).not.toContain(f.mail.id);
  });

  it.each([
    'generation-after-restart',
    'old-host-revoked',
    'new-host-revoked',
    'unloaded-after-read',
    'retired-after-read',
  ])('rechecks %s after metadata I/O and refuses the stale handover', async (change) => {
    const f = await boot();
    await f.disconnect();
    if (change === 'old-host-revoked') {
      f.broker.config.codex.trusted_host_versions.push('fixture-new');
      f.broker.db
        .prepare("UPDATE sessions SET host_client_version='fixture-new' WHERE id=?")
        .run(f.old.welcome.session_id);
    }
    if (change === 'new-host-revoked') f.broker.config.codex.trusted_host_versions.push('fixture-new');
    const fresh = await f.connect(
      change === 'new-host-revoked' ? { host_client: { name: 'codex-mcp-client', version: 'fixture-new' } } : {},
    );
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    f.app.pauseRead = { entered: enter, gate };
    const binding = fresh.client.call('session.bind', { agent_session_id: 'T' });
    const refused = expect(binding).rejects.toMatchObject({ code: 'conflict' });
    await entered;
    try {
      if (change === 'generation-after-restart') {
        // Fake the generation invalidation caused by a restarted broker's replacement connection; no process I/O.
        f.broker.db
          .prepare('UPDATE sessions SET conn_generation=conn_generation+1 WHERE id=?')
          .run(f.old.welcome.session_id);
      }
      if (change.endsWith('host-revoked')) f.broker.config.codex.trusted_host_versions = [];
      if (change === 'unloaded-after-read') f.app.loaded = [];
      if (change === 'retired-after-read')
        f.broker.db
          .prepare("UPDATE sessions SET retired_at='fixture-retirement' WHERE id=?")
          .run(f.old.welcome.session_id);
    } finally {
      release();
    }
    await refused;
    expect(getSession(f.broker.db, fresh.welcome.session_id)?.retired_into).toBeNull();
    expect(f.broker.questions.assignment(f.assignment.id)?.worker_session_id).toBe(f.old.welcome.session_id);
    expect(deliveriesOfMessage(f.broker.db, f.mail.id)[0]?.state).toBe('held');
  });
  it.each([false, true])(
    'restores only the verified disconnected thread’s work (descendant loaded=%s)',
    async (descendant) => {
      const f = await boot();
      await f.disconnect();
      if (descendant) f.app.loaded.push('child');
      const fresh = await f.connect();
      expect(fresh.welcome.session_id).not.toBe(f.old.welcome.session_id);
      await fresh.client.call('session.bind', { agent_session_id: 'T', question_relay_version: 1 });
      expect(await fresh.client.call('session.whoami')).toMatchObject({
        id: f.old.welcome.session_id,
        name: 'cx-worker',
        capabilities: { resume_recovery: 'unavailable' },
      });
      expect(f.broker.questions.assignment(f.assignment.id)?.worker_session_id).toBe(f.old.welcome.session_id);
      expect(getSession(f.broker.db, fresh.welcome.session_id)?.retired_into).toBe(f.old.welcome.session_id);
      expect(getSession(f.broker.db, f.old.welcome.session_id)?.codex_push_reason).toBe(
        descendant ? 'descendant-loaded' : null,
      );
      expect(JSON.stringify(await fresh.client.call('msg.inbox'))).toContain(f.mail.id);
    },
  );
  it('preserves a historical disconnected binding and reports exactly what cannot be rehomed', async () => {
    const f = await boot();
    await f.disconnect();
    f.broker.db
      .prepare("UPDATE sessions SET bind_origin='unverified',host_client_name=NULL,host_client_version=NULL WHERE id=?")
      .run(f.old.welcome.session_id);
    f.broker.db
      .prepare("DELETE FROM session_lineage WHERE session_id=? AND reason='binding-origin'")
      .run(f.old.welcome.session_id);
    const fresh = await f.connect();
    await expect(fresh.client.call('session.bind', { agent_session_id: 'T' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('wigwag recovery --json'),
    });
    expect(getSession(f.broker.db, f.old.welcome.session_id)?.agent_session_id).toBe('T');
    expect(deliveriesOfMessage(f.broker.db, f.mail.id)[0]?.state).toBe('held');
    expect(f.broker.questions.assignment(f.assignment.id)?.worker_session_id).toBe(f.old.welcome.session_id);
    const report = JSON.stringify(await f.owner.call('owner.recovery'));
    expect(report).toContain('codex-reattach-unverified');
    expect(report).toContain('held mail and active assignment remain');
  });
});
