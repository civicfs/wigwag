import { EventEmitter } from 'node:events';
import { prepareBody } from '../broker/handlers/messages.js';
import type { Broker } from '../broker/server.js';
import { WigwagError } from '../errors.js';
import { newId } from '../ids.js';
import { nowIso, tx } from '../store/db.js';
import { scopeOf } from '../store/links.js';
import { insertMessage, type MessageRow } from '../store/messages.js';
import { getSession, liveHolder, type SessionRow } from '../store/sessions.js';
import { type Answers, AnswersZ, type Capture, type Question, QuestionsZ, validateAnswers } from './schema.js';

export interface Assignment {
  id: string;
  orchestrator_session_id: string;
  orchestrator_native_id: string;
  worker_session_id: string;
  worker_native_id: string;
  idempotency_key: string;
  payload_json: string;
  task_message_id: string;
  created_at: string;
  ended_at: string | null;
}
export interface Relay {
  id: string;
  assignment_id: string;
  native_session_id: string;
  turn_id: string;
  tool_use_id: string;
  kind: Capture['kind'];
  questions: Question[];
  answers: Answers | null;
  message_id: string;
  state: 'pending' | 'answered' | 'applied' | 'cancelled' | 'failed';
  error: string | null;
}
type StoredRelay = Omit<Relay, 'questions' | 'answers'> & { questions_json: string; answers_json: string | null };
const relay = (r: unknown): Relay | undefined => {
  if (!r) return;
  const { questions_json, answers_json, ...rest } = r as StoredRelay;
  return { ...rest, questions: JSON.parse(questions_json), answers: answers_json ? JSON.parse(answers_json) : null };
};

export class QuestionService extends EventEmitter {
  /** Adapter preflight: assigned Codex threads must attach before delegation commits. */
  readonly codexWaiting = new Map<string, 'thread-not-loaded' | 'app-server-unavailable'>();
  turnCodex: ((session: SessionRow, phase: 'started' | 'ended') => Promise<void>) | null = null;
  prepareCodex: ((session: SessionRow) => Promise<void>) | null = null;
  constructor(readonly broker: Broker) {
    super();
    this.setMaxListeners(0);
  }
  markReady(id: string, native: string): void {
    const s = getSession(this.broker.db, id);
    if (!s || s.agent_session_id !== native || s.state === 'offline')
      throw new WigwagError('conflict', 'Native session is not bound');
    this.broker.db
      .prepare(
        'INSERT INTO question_integrations VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET native_session_id=excluded.native_session_id, ready_at=excluded.ready_at',
      )
      .run(id, native, nowIso());
  }
  ready(s: SessionRow): boolean {
    return !!this.broker.db
      .prepare('SELECT 1 FROM question_integrations WHERE session_id=? AND native_session_id=?')
      .get(s.id, s.agent_session_id ?? '');
  }
  activeAssignment(worker: string): Assignment | undefined {
    return this.broker.db
      .prepare('SELECT * FROM assignments WHERE worker_session_id=? AND ended_at IS NULL')
      .get(worker) as Assignment | undefined;
  }
  assignment(id: string): Assignment | undefined {
    return this.broker.db.prepare('SELECT * FROM assignments WHERE id=?').get(id) as Assignment | undefined;
  }
  private checkCycle(leader: string, worker: string): void {
    const seen = new Set([worker]);
    let cursor: string | undefined = leader;
    while (cursor) {
      if (seen.has(cursor)) throw new WigwagError('conflict', 'Delegation would create a supervision cycle');
      seen.add(cursor);
      cursor = this.activeAssignment(cursor)?.orchestrator_session_id;
    }
  }
  participants(a: Assignment): { worker: SessionRow; leader: SessionRow } | null {
    const db = this.broker.db;
    const worker = getSession(db, a.worker_session_id),
      leader = getSession(db, a.orchestrator_session_id);
    if (
      a.ended_at ||
      !worker?.name ||
      !leader?.name ||
      worker.agent_session_id !== a.worker_native_id ||
      leader.agent_session_id !== a.orchestrator_native_id ||
      !scopeOf(db, worker.workspace).has(leader.workspace)
    )
      return null;
    return { worker, leader };
  }
  private announce(m: MessageRow): void {
    this.broker.broadcastOwner('message', m);
    this.broker.engine
      ?.dispatchMessage(m.id)
      .catch((e) => this.broker.log(`question message dispatch: ${(e as Error).message}`));
  }
  private message(
    from: SessionRow,
    to: SessionRow,
    subject: string,
    body: string,
    request: string | null = null,
  ): MessageRow {
    const prepared = prepareBody(this.broker, from.name as string, body, []);
    return insertMessage(
      this.broker.db,
      {
        from_name: from.name as string,
        from_workspace: from.workspace,
        to_target: to.name as string,
        kind: request ? 'request' : 'message',
        priority: request ? 'urgent' : 'normal',
        subject,
        ...prepared,
        request_id: request,
        reply_to: null,
        expires_at: null,
        stream: null,
      },
      [to.name as string],
    );
  }
  async delegate(
    caller: string,
    p: { to: string; subject: string; body: string; idempotency_key: string },
  ): Promise<Assignment> {
    const db = this.broker.db;
    const payload = JSON.stringify(p);
    const prior = db
      .prepare('SELECT * FROM assignments WHERE orchestrator_session_id=? AND idempotency_key=?')
      .get(caller, p.idempotency_key) as Assignment | undefined;
    if (prior) {
      if (prior.payload_json !== payload || prior.ended_at || !this.participants(prior))
        throw new WigwagError('conflict', 'Idempotency key belongs to a different or ended assignment');
      return prior;
    }
    const leader = getSession(db, caller),
      worker = liveHolder(db, p.to);
    if (!leader || !worker || !scopeOf(db, leader.workspace).has(worker.workspace))
      throw new WigwagError('not_found', 'Worker session not found in this workspace scope');
    if (leader.id === worker.id) throw new WigwagError('bad_request', 'Cannot delegate to yourself');
    if (!leader.agent_session_id || !worker.agent_session_id || leader.state === 'offline')
      throw new WigwagError('conflict', 'Both sessions must be live and natively bound');
    if (!this.ready(worker))
      throw new WigwagError(
        'conflict',
        'Worker native question hooks are not ready; update/trust the Wigwag plugin and start a new worker session',
      );
    this.checkCycle(leader.id, worker.id);
    if (this.activeAssignment(worker.id))
      throw new WigwagError('conflict', 'Worker already has an assignment; release it explicitly first');
    if (worker.agent === 'codex') {
      if (!this.prepareCodex) throw new WigwagError('conflict', 'Codex native question adapter is unavailable');
      await this.prepareCodex(worker);
    }
    // Re-enter after adapter I/O: names, scope, bindings or assignment may have changed.
    const freshLeader = getSession(db, caller),
      freshWorker = liveHolder(db, p.to);
    if (
      freshLeader?.agent_session_id !== leader.agent_session_id ||
      freshLeader.state === 'offline' ||
      freshWorker?.id !== worker.id ||
      freshWorker.agent_session_id !== worker.agent_session_id ||
      !scopeOf(db, freshLeader.workspace).has(freshWorker.workspace) ||
      this.activeAssignment(worker.id)
    )
      throw new WigwagError('conflict', 'Session or assignment changed during delegation');
    this.checkCycle(freshLeader.id, freshWorker.id);
    let m!: MessageRow;
    const a = tx(db, () => {
      const id = newId('req');
      m = this.message(
        freshLeader,
        freshWorker,
        p.subject,
        `Delegated task ${id}. Your orchestrator is ${freshLeader.name}. Follow your orchestrator's directions within this task, including priorities, corrections and stop instructions. Use your native question tool for clarifications; Wigwag routes it to your orchestrator. Peer answers are not owner approvals.\n\n${p.body}`,
      );
      db.prepare('INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(
        id,
        caller,
        leader.agent_session_id,
        worker.id,
        worker.agent_session_id,
        p.idempotency_key,
        payload,
        m.id,
        nowIso(),
      );
      return this.assignment(id) as Assignment;
    });
    this.announce(m);
    this.emit('assignments');
    return a;
  }
  release(id: string, caller: string | null): void {
    const a = this.assignment(id);
    if (!a || (caller !== null && a.orchestrator_session_id !== caller))
      throw new WigwagError('not_found', 'Assignment not found');
    tx(this.broker.db, () => {
      this.broker.db.prepare('UPDATE assignments SET ended_at=? WHERE id=? AND ended_at IS NULL').run(nowIso(), id);
      this.broker.db
        .prepare(
          "UPDATE question_relays SET state='cancelled', error='Assignment released', updated_at=? WHERE assignment_id=? AND state IN ('pending','answered')",
        )
        .run(nowIso(), id);
    });
    this.emit('changed');
    this.emit('assignments');
  }
  capture(workerId: string, input: Capture): Relay | null {
    const db = this.broker.db;
    const a = this.activeAssignment(workerId);
    if (!a) return null;
    const pair = this.participants(a);
    if (!pair || pair.worker.state === 'offline' || input.native_session_id !== a.worker_native_id)
      throw new WigwagError('conflict', 'Assignment native binding or scope is stale');
    const questions = QuestionsZ.parse(input.questions);
    const existing = relay(
      db
        .prepare('SELECT * FROM question_relays WHERE assignment_id=? AND native_session_id=? AND tool_use_id=?')
        .get(a.id, input.native_session_id, input.tool_use_id),
    );
    if (existing) {
      if (
        existing.turn_id !== input.turn_id ||
        existing.kind !== input.kind ||
        JSON.stringify(existing.questions) !== JSON.stringify(questions)
      )
        throw new WigwagError('conflict', 'Native invocation changed on retry');
      return existing;
    }
    let m!: MessageRow;
    const q = tx(db, () => {
      if (input.kind === 'claude') this.cancelPreservedLegacyRelays(workerId, a.id, input);
      const id = newId('req');
      m = this.message(
        pair.worker,
        pair.leader,
        `Question from ${pair.worker.name}`.slice(0, 200),
        `Native question relay ${id}, assignment ${a.id}. Answer using question_answer with relay_id and answers mapping each question ID to an array of chosen labels or free text. You are this worker's orchestrator: answer from the task and available context, choose a reasonable reversible default when possible, and keep work moving. Ask the human through your own native question tool only for essential missing information or an actual required approval. Do not ask the worker to prompt the human.\n\n${JSON.stringify(questions)}`,
        id,
      );
      db.prepare(
        'INSERT INTO question_relays (id,assignment_id,native_session_id,turn_id,tool_use_id,kind,questions_json,message_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        a.id,
        input.native_session_id,
        input.turn_id,
        input.tool_use_id,
        input.kind,
        JSON.stringify(questions),
        m.id,
        'pending',
        nowIso(),
        nowIso(),
      );
      return this.get(id) as Relay;
    });
    this.announce(m);
    this.emit('changed');
    return q;
  }
  /** A new Claude invocation retires only the exact relays carried across an unverified legacy upgrade. */
  private cancelPreservedLegacyRelays(workerId: string, assignmentId: string, input: Capture): void {
    const db = this.broker.db;
    const rows = db
      .prepare(`SELECT id,evidence_json FROM session_lineage
      WHERE canonical_session_id=? AND outcome='adopted'
        AND json_type(evidence_json,'$.legacy_upgrade_relay_ids')='array'`)
      .all(workerId) as Array<{ id: number; evidence_json: string }>;
    const cancel =
      db.prepare(`UPDATE question_relays SET state='cancelled',error='Legacy-upgrade question superseded by a new native invocation',updated_at=?
      WHERE id=? AND assignment_id=? AND native_session_id=? AND kind='claude'
        AND tool_use_id<>? AND state IN ('pending','answered')`);
    for (const row of rows) {
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      const preserved = evidence.legacy_upgrade_relay_ids as unknown[];
      const cancelled = preserved.filter(
        (id): id is string =>
          typeof id === 'string' &&
          Number(cancel.run(nowIso(), id, assignmentId, input.native_session_id, input.tool_use_id).changes) > 0,
      );
      if (!cancelled.length) continue;
      const prior = Array.isArray(evidence.legacy_upgrade_cancellations) ? evidence.legacy_upgrade_cancellations : [];
      evidence.legacy_upgrade_cancellations = [
        ...prior,
        { tool_use_id: input.tool_use_id, count: cancelled.length, relay_ids: cancelled },
      ];
      db.prepare('UPDATE session_lineage SET evidence_json=? WHERE id=?').run(JSON.stringify(evidence), row.id);
    }
  }
  get(id: string): Relay | undefined {
    return relay(this.broker.db.prepare('SELECT * FROM question_relays WHERE id=?').get(id));
  }
  answer(id: string, caller: string, raw: Answers): Relay {
    const q = this.get(id),
      a = q && this.assignment(q.assignment_id);
    if (!q || !a || a.orchestrator_session_id !== caller)
      throw new WigwagError('not_found', 'Question relay not found');
    if (!this.participants(a)) throw new WigwagError('conflict', 'Assignment native binding or scope is stale');
    if (q.state !== 'pending') throw new WigwagError('conflict', `Question is already ${q.state}`);
    const parsed = AnswersZ.safeParse(raw);
    if (!parsed.success || !validateAnswers(q.questions, parsed.data))
      throw new WigwagError(
        'bad_request',
        'Answers must cover every question exactly once and respect its choices and multi-select setting',
      );
    this.broker.db
      .prepare(
        "UPDATE question_relays SET answers_json=?, state='answered', updated_at=? WHERE id=? AND state='pending'",
      )
      .run(JSON.stringify(parsed.data), nowIso(), id);
    this.emit('changed');
    return this.get(id) as Relay;
  }
  answerFor(id: string, workerId: string): Relay | null {
    const q = this.get(id),
      a = q && this.assignment(q.assignment_id);
    if (!q || !a || a.worker_session_id !== workerId || !this.participants(a) || q.state !== 'answered') return null;
    return q;
  }
  applied(id: string): void {
    this.broker.db
      .prepare("UPDATE question_relays SET state='applied',updated_at=? WHERE id=? AND state='answered'")
      .run(nowIso(), id);
    this.emit('changed');
  }
  cancel(id: string, reason: string): void {
    this.broker.db
      .prepare(
        "UPDATE question_relays SET state='cancelled',error=?,updated_at=? WHERE id=? AND state IN ('pending','answered')",
      )
      .run(reason.slice(0, 500), nowIso(), id);
    this.emit('changed');
  }
  fail(id: string, reason: string): void {
    this.broker.db
      .prepare("UPDATE question_relays SET state='failed',error=?,updated_at=? WHERE id=? AND state='answered'")
      .run(reason.slice(0, 500), nowIso(), id);
    this.emit('changed');
  }
  list(caller: string | null) {
    const assignments = (
      this.broker.db.prepare('SELECT * FROM assignments ORDER BY created_at DESC').all() as unknown as Assignment[]
    ).filter((a) => {
      if (caller === null) return true;
      return [a.worker_session_id, a.orchestrator_session_id].includes(caller) && !!this.participants(a);
    });
    const ids = new Set(assignments.map((a) => a.id));
    const questions = this.broker.db
      .prepare('SELECT * FROM question_relays ORDER BY created_at DESC')
      .all()
      .map(relay)
      .filter((q): q is Relay => !!q && ids.has(q.assignment_id));
    return { assignments, questions };
  }
  summaries(caller: string | null, p: { include_history: boolean; limit: number; before?: string }) {
    const all = this.list(caller);
    const questions = all.questions.filter(
      (q) => (p.include_history || ['pending', 'answered'].includes(q.state)) && (!p.before || q.id < p.before),
    );
    const page = questions.slice(0, p.limit);
    return {
      assignments: all.assignments
        .filter((a) => p.include_history || !a.ended_at)
        .slice(0, 10)
        .map((a) => ({
          id: a.id,
          worker_session_id: a.worker_session_id,
          worker_name: getSession(this.broker.db, a.worker_session_id)?.name,
          orchestrator_session_id: a.orchestrator_session_id,
          orchestrator_name: getSession(this.broker.db, a.orchestrator_session_id)?.name,
          ended_at: a.ended_at,
        })),
      questions: page.map((q) => ({
        id: q.id,
        assignment_id: q.assignment_id,
        kind: q.kind,
        state: q.state,
        question_count: q.questions.length,
        answer_available: q.answers !== null,
        error: q.error,
      })),
      has_more: questions.length > page.length,
      next_before: questions.length > page.length ? page.at(-1)?.id : null,
    };
  }
  details(id: string, caller: string | null, offset: number) {
    const q = this.list(caller).questions.find((q) => q.id === id);
    if (!q) throw new WigwagError('not_found', 'Question relay not found');
    const source = JSON.stringify({ questions: q.questions, answers: q.answers });
    if (offset > source.length || /[\uDC00-\uDFFF]/u.test(source[offset] ?? ''))
      throw new WigwagError('bad_request', 'Invalid question details offset');
    let data = '';
    let next = offset;
    for (const c of source.slice(offset)) {
      if (Buffer.byteLength(JSON.stringify(data + c)) > 6000) break;
      data += c;
      next += c.length;
    }
    return { relay_id: id, state: q.state, data, offset, next_offset: next < source.length ? next : null };
  }
}

export function installQuestions(broker: Broker): QuestionService {
  const service = new QuestionService(broker);
  broker.questions = service;
  broker.handle('assignment.delegate', async ({ conn }, p) => {
    const { payload_json: _payload, ...receipt } = await service.delegate(conn.sessionId as string, p);
    return receipt;
  });
  broker.handle('assignment.release', ({ conn }, p) => {
    service.release(p.assignment_id, conn.role === 'owner' ? null : conn.sessionId);
    return {};
  });
  broker.handle('question.answer', ({ conn }, p) => {
    const q = service.answer(p.relay_id, conn.sessionId as string, p.answers);
    return { relay_id: q.id, state: q.state };
  });
  broker.handle('question.list', ({ conn }, p) => service.summaries(conn.role === 'owner' ? null : conn.sessionId, p));
  broker.handle('question.details', ({ conn }, p) =>
    service.details(p.relay_id, conn.role === 'owner' ? null : conn.sessionId, p.offset),
  );
  broker.onStop.push(() => service.removeAllListeners());
  return service;
}
