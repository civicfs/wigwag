import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canConnect, sockPath } from '../client/autospawn.js';
import { Client } from '../client/client.js';
import { loadConfig, resolveHome } from '../config.js';
import { agentAncestor, processChain } from '../proc/ancestors.js';
import { frameLimit } from '../protocol/frame.js';

export type ClaudeHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';
const CONTEXT_EVENTS = new Set<ClaudeHookEvent>(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);

class StdinTooLarge extends Error {}

/** Bounded read: rejects past `maxBytes`; resolves early (with what it has) if stdin is destroyed by the deadline. */
function readStdin(maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        process.stdin.destroy();
        reject(new StdinTooLarge(`stdin exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.once('error', reject);
    process.stdin.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function logError(home: string, event: string, e: unknown): void {
  try {
    mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
    appendFileSync(
      join(home, 'logs', 'hooks.log'),
      `${new Date().toISOString()} claude ${event}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  } catch {
    // never fail the agent session
  }
}

/** Never throws, never starts the broker, exits 0. The whole hook runs under hooks.deadline_ms. */
export async function runClaudeHook(event: ClaudeHookEvent): Promise<void> {
  const home = resolveHome();
  const ac = new AbortController();
  let client: Client | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const config = loadConfig(home);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        client?.destroy();
        process.stdin.destroy();
        reject(new Error('deadline exceeded'));
      }, config.hooks.deadline_ms);
    });
    const work = (async () => {
      const raw = await readStdin(config.hooks.max_stdin_bytes);
      if (raw.trim() === '') throw new Error('empty hook input');
      const input = JSON.parse(raw) as {
        session_id?: string;
        cwd?: string;
        session_title?: unknown;
        transcript_path?: unknown;
        source?: unknown;
      };
      if (!input.session_id) throw new Error('hook input has no session_id');
      if (!(await canConnect(sockPath(home), ac.signal))) return;
      const connected = await Client.connect(
        sockPath(home),
        { protocol: 1, role: 'hook' },
        frameLimit(config),
        undefined,
        ac.signal,
      );
      client = connected.client;
      const chain = processChain(process.pid);
      const r = await client.call<{ additional_context: string | null }>('hook.event', {
        agent: 'claude',
        event,
        agent_session_id: input.session_id,
        cwd: input.cwd ?? process.cwd(),
        pid_chain: chain.map((x) => x.pid),
        // Spec §4: the hook's own agent is its nearest ancestor that is not a shell or launcher; an outer claude
        // further up (a nested `claude -p` run from a session's shell tool) is never this hook's session.
        agent_pid: agentAncestor(chain),
        ...(typeof input.session_title === 'string' && input.session_title.trim()
          ? { session_title: input.session_title.trim().slice(0, 200) }
          : {}),
        ...(typeof input.transcript_path === 'string' &&
        input.transcript_path.startsWith('/') &&
        input.transcript_path.length <= 4096
          ? { transcript_path: input.transcript_path }
          : {}),
        ...(typeof input.source === 'string' ? { source: input.source.slice(0, 32) } : {}),
      });
      if (r.additional_context && CONTEXT_EVENTS.has(event)) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: r.additional_context } }),
        );
      }
    })();
    work.catch(() => {}); // the race below reports the outcome; avoid an unhandled rejection after the deadline
    await Promise.race([work, deadline]);
  } catch (e) {
    logError(home, event, e);
  } finally {
    clearTimeout(timer);
    const c = client as Client | null;
    c?.destroy();
  }
}
