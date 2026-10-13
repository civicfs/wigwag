import type { Broker } from '../broker/server.js';
import { WigwagError } from '../errors.js';
import type { Params } from '../protocol/rpc.js';
import { listSessions } from '../store/sessions.js';
import { normalizeNative } from './native.js';
import type { QuestionService, Relay } from './service.js';

export function installQuestionHooks(broker: Broker, service: QuestionService): void {
  const workerFor = async (p: Params<'hook.question_ready'>) => {
    const workspace = await broker.workspaces.resolve(p.cwd);
    const candidates = listSessions(broker.db).filter(
      (s) =>
        s.agent === p.agent &&
        s.agent_session_id === p.native_session_id &&
        s.state !== 'offline' &&
        s.workspace === workspace,
    );
    const s = candidates.length === 1 ? candidates[0] : undefined;
    if (
      !s ||
      (p.agent === 'claude' &&
        (p.agent_pid === null || s.mcp_ppid !== p.agent_pid || !p.pid_chain.includes(p.agent_pid)))
    )
      throw new WigwagError('not_found', 'Bound native hook session not found');
    return s;
  };
  const result = (q: Relay) => {
    const a = service.assignment(q.assignment_id);
    const pair = a && service.participants(a);
    if (!pair) throw new WigwagError('conflict', 'Question assignment is stale');
    return {
      supervised: true,
      relay_id: q.id,
      state: q.state,
      answers: q.answers,
      orchestrator_name: pair.leader.name,
      error: q.error,
    };
  };
  broker.handle('hook.question_ready', async (_ctx, p) => {
    const s = await workerFor(p);
    service.markReady(s.id, p.native_session_id);
    return {};
  });
  broker.handle('hook.question_capture', async (_ctx, p) => {
    const native = normalizeNative(p.agent, p.tool_name, p.tool_input);
    if (!native) return { supervised: false };
    const s = await workerFor(p);
    const q = service.capture(s.id, {
      native_session_id: p.native_session_id,
      turn_id: p.turn_id,
      tool_use_id: p.tool_use_id,
      ...native,
    });
    return q ? result(q) : { supervised: false };
  });
  broker.handle('hook.question_poll', async (_ctx, p) => {
    const s = await workerFor(p);
    const q = service.get(p.relay_id);
    const a = q && service.assignment(q.assignment_id);
    if (!q || !a || a.worker_session_id !== s.id) throw new WigwagError('not_found', 'Question relay not found');
    return result(q);
  });
  broker.handle('hook.question_applied', async (_ctx, p) => {
    const s = await workerFor(p);
    if (!service.answerFor(p.relay_id, s.id)) throw new WigwagError('conflict', 'Question answer is not applicable');
    service.applied(p.relay_id);
    return {};
  });
}
