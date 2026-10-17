import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sockPath } from '../client/autospawn.js';
import { Client } from '../client/client.js';
import { loadConfig, resolveHome } from '../config.js';
import { WigwagError } from '../errors.js';
import { agentAncestor, processChain } from '../proc/ancestors.js';
import { frameLimit } from '../protocol/frame.js';
import { claudeAnswer, normalizeNative, peerNote } from './native.js';
import type { Answers } from './schema.js';

type HookResult = {
  supervised: boolean;
  relay_id?: string;
  state?: string;
  answers?: Answers;
  orchestrator_name?: string;
  error?: string;
};
type HookInput = {
  session_id?: string;
  cwd?: string;
  turn_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: { questions: Array<{ question: string }> };
};
function supervisedOnDisk(home: string, native: string): boolean {
  const file = join(home, 'state.db');
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const v = db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number };
    if (v.v < 2) return false;
    return !!db.prepare('SELECT 1 FROM assignments WHERE worker_native_id=? AND ended_at IS NULL').get(native);
  } finally {
    db.close();
  }
}
const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/** A dedicated question hook: ordinary lifecycle hooks keep their short deadline. */
export async function runQuestionHook(agent: 'claude' | 'codex', event: 'QuestionReady' | 'PreToolUse'): Promise<void> {
  const home = resolveHome();
  let client: Client | null = null;
  let supervised = false;
  let native = '';
  let isQuestion = false;
  let relayId: string | undefined;
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const config = loadConfig(home);
    timer = setTimeout(
      () => {
        ac.abort();
        client?.destroy();
        process.stdin.destroy();
      },
      event === 'QuestionReady' || agent === 'codex' ? config.hooks.deadline_ms : config.questions.wait_ms,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > config.hooks.max_stdin_bytes) throw new Error('Native hook input exceeds configured limit');
      chunks.push(b);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
    native = input.session_id ?? '';
    if (!native) throw new Error('Native hook has no session_id');
    if (event === 'PreToolUse') {
      const normalized = normalizeNative(agent, input.tool_name ?? '', input.tool_input);
      if (!normalized) return;
      isQuestion = true;
      supervised = supervisedOnDisk(home, native);
      if (!supervised) return; // Preserve normal native human questions for unsupervised agents.
    }
    const chain = processChain(process.pid);
    const identity = {
      agent,
      native_session_id: native,
      cwd: input.cwd ?? process.cwd(),
      agent_pid: agentAncestor(chain),
      pid_chain: chain.map((p) => p.pid),
    };
    const connect = async () => {
      client?.destroy();
      const connected = await Client.connect(
        sockPath(home),
        { protocol: 1, role: 'hook' },
        frameLimit(config),
        undefined,
        ac.signal,
      );
      client = connected.client;
      ac.signal.addEventListener('abort', () => connected.client.destroy(), { once: true });
      return connected.client;
    };
    let c = await connect();
    if (event === 'QuestionReady') {
      while (!ac.signal.aborted) {
        try {
          await c.call('hook.question_ready', identity);
          return;
        } catch (e) {
          if ((e as { code?: string }).code !== 'not_found') throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      return;
    }
    if (!input.tool_use_id) throw new Error('Native hook has no tool_use_id');
    let r = await c.call<HookResult>('hook.question_capture', {
      ...identity,
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      turn_id: input.turn_id ?? input.tool_use_id,
      tool_input: input.tool_input,
    });
    if (!r.supervised) return;
    relayId = r.relay_id;
    if (agent === 'codex') return; // The native tool now emits the correlated app-server request/item.
    while (!ac.signal.aborted) {
      if (r.state === 'answered' && r.answers && input.tool_input) {
        const output = claudeAnswer(input.tool_input, r.answers);
        const withProvenance = {
          hookSpecificOutput: {
            ...output.hookSpecificOutput,
            additionalContext: peerNote(r.orchestrator_name ?? 'unknown'),
          },
        };
        await c.call('hook.question_applied', { ...identity, relay_id: relayId });
        process.stdout.write(JSON.stringify(withProvenance));
        return;
      }
      if (r.state !== 'pending') throw new Error(r.error ?? `Native question relay is ${r.state}`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          ac.signal.removeEventListener('abort', done);
          resolve();
        };
        const t = setTimeout(done, Math.min(config.questions.poll_ms, 1000));
        ac.signal.addEventListener('abort', done, { once: true });
      });
      if (ac.signal.aborted) break;
      try {
        r = await c.call<HookResult>('hook.question_poll', { ...identity, relay_id: relayId });
      } catch (e) {
        if (ac.signal.aborted) throw e;
        c = await connect();
        r = await c.call<HookResult>('hook.question_poll', { ...identity, relay_id: relayId });
      }
    }
    throw new Error('Native question wait deadline exceeded');
  } catch (e) {
    // A supervised worker never silently falls through to its own human prompt on a known failure.
    // If normalization itself failed, consult the durable route before deciding whether to block.
    if (!supervised && native && event === 'PreToolUse') {
      try {
        supervised = supervisedOnDisk(home, native);
      } catch {
        supervised = true;
      }
    }
    if (event === 'PreToolUse' && supervised)
      process.stdout.write(
        JSON.stringify(
          deny(
            `Wigwag question relay ${relayId ?? '(not submitted)'} is pending or unavailable: ${e instanceof Error ? e.message : String(e)}. Use the Wigwag questions tool for status/answers and continue independent work if possible. Your orchestrator decides whether to ask the human; do not repeat this as a human question.`,
          ),
        ),
      );
    else if (event === 'QuestionReady' || isQuestion)
      process.stderr.write(
        e instanceof WigwagError && (e.data as { kind?: string })?.kind === 'version-skew'
          ? `wigwag: ${e.message}\n`
          : 'wigwag: native question integration is not ready; inspect broker status and plugin trust.\n',
      );
  } finally {
    clearTimeout(timer);
    (client as Client | null)?.destroy();
  }
}
