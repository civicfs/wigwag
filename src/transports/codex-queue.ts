import { type ExecFileException, execFile } from 'node:child_process';
import { type RenderItem, renderCodex } from '../broker/render.js';
import { WigwagError } from '../errors.js';
import type { SessionRow } from '../store/sessions.js';
import type { Transport } from './types.js';

/** Below Linux's 128 KiB single-argument ceiling (including NUL), with room for rendering. Not a tunable. */
export const CODEX_ARG_BUDGET_BYTES = 96 * 1024;

function chunk(items: RenderItem[]): RenderItem[][] {
  const out: RenderItem[][] = [];
  let cur: RenderItem[] = [];
  for (const it of items) {
    const next = [...cur, it];
    if (cur.length && Buffer.byteLength(renderCodex(next), 'utf8') > CODEX_ARG_BUDGET_BYTES) {
      out.push(cur);
      cur = [it];
    } else cur = next;
  }
  if (cur.length) out.push(cur);
  return out;
}

export class CodexQueueTransport implements Transport {
  readonly kind = 'codex-queue' as const;

  constructor(
    private readonly binary: string,
    private readonly timeoutMs: number,
  ) {}

  tooLarge(it: RenderItem): string | null {
    const n = Buffer.byteLength(renderCodex([it]), 'utf8');
    if (n <= CODEX_ARG_BUDGET_BYTES) return null;
    return `message ${it.msg.id} renders to ${n} bytes, over the codex argv budget of ${CODEX_ARG_BUDGET_BYTES} bytes`;
  }

  async push(
    session: SessionRow,
    items: RenderItem[],
    options: { signal?: AbortSignal; onPushed?: (items: RenderItem[]) => void } = {},
  ): Promise<void> {
    const thread = session.agent_session_id;
    if (!thread) throw new WigwagError('unbound', `Codex session ${session.name ?? session.id} has no thread id yet`);
    for (const it of items) {
      const why = this.tooLarge(it);
      if (why) throw new WigwagError('transport', why);
    }
    for (const part of chunk(items)) {
      if (options.signal?.aborted) throw new WigwagError('transport', 'codex queue cancelled during shutdown');
      await this.queue(thread, renderCodex(part), options.signal);
      options.onPushed?.(part);
    }
  }

  private queue(thread: string, message: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        execFile(
          this.binary,
          ['queue', '--thread', thread, '--message', message],
          { timeout: this.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1048576, signal },
          (err, _stdout, stderr) => {
            if (!err) return resolve();
            reject(new WigwagError('transport', this.describe(err, String(stderr ?? ''))));
          },
        );
      } catch (e) {
        // A synchronous throw (for example a NUL byte in an argument) can quote the argument: keep only its code.
        const code = (e as NodeJS.ErrnoException).code;
        reject(
          new WigwagError(
            'transport',
            `codex queue failed (${this.binary}): could not start${code ? `: ${code}` : ''}`,
          ),
        );
      }
    });
  }

  /**
   * Final review I-1: execFile's `err.message` quotes the whole argv, including the rendered message text and its
   * ride-along items. stderr can echo the same input, so keep metadata only for both error sources.
   */
  private describe(err: ExecFileException, stderr: string): string {
    let why: string;
    if (typeof err.code === 'string') why = err.code;
    else if (err.killed && err.signal) why = `timed out after ${this.timeoutMs} ms (${err.signal})`;
    else if (err.signal) why = `killed by ${err.signal}`;
    else if (typeof err.code === 'number') why = `exit code ${err.code}`;
    else why = 'unknown error';
    const bytes = Buffer.byteLength(stderr, 'utf8');
    return `codex queue failed (${this.binary}): ${why}${bytes ? `; stderr omitted (${bytes} bytes)` : ''}`;
  }
}
