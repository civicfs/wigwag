import type { Connection } from '../broker/connection.js';
import { type RenderItem, renderClaude } from '../broker/render.js';
import { WigwagError } from '../errors.js';
import type { SessionRow } from '../store/sessions.js';
import type { Transport } from './types.js';

export class ClaudeChannelTransport implements Transport {
  readonly kind = 'claude-channel' as const;

  constructor(private readonly connectionFor: (sessionId: string) => Connection | undefined) {}

  /** A Claude MCP server reports `channel: false` at hello when neither the client nor its launch flags enable the channel. */
  hasChannel(session: SessionRow): boolean {
    return this.connectionFor(session.id)?.channel !== false;
  }

  async push(
    session: SessionRow,
    items: RenderItem[],
    options: { signal?: AbortSignal; onPushed?: (items: RenderItem[]) => void } = {},
  ): Promise<void> {
    const conn = this.connectionFor(session.id);
    if (conn && !this.hasChannel(session)) {
      throw new WigwagError('transport', `Session ${session.name ?? session.id} has no usable Claude channel`);
    }
    let batch: RenderItem[] = [];
    let originals: RenderItem[] = [];
    const fits = (part: RenderItem[]) => Buffer.byteLength(JSON.stringify(renderClaude(part))) <= 12000;
    const flush = () => {
      if (!batch.length) return;
      if (options.signal?.aborted) throw new WigwagError('transport', 'Claude push cancelled during shutdown');
      if (!conn?.event('push', renderClaude(batch)))
        throw new WigwagError('transport', `No live connection for session ${session.name ?? session.id}`);
      options.onPushed?.(originals);
      batch = [];
      originals = [];
    };
    for (const original of items) {
      const item = fits([original])
        ? original
        : {
            nativeQuestion: original.nativeQuestion,
            msg: {
              ...original.msg,
              body: `[Full stored message available with read_message, msg_id ${original.msg.id}; follow its offsets to read in chunks. Existing clients can retrieve the same stored message through inbox with include_read=true.]`,
              attachments: [],
            },
            attachments: [],
          };
      if (batch.length && !fits([...batch, item])) flush();
      if (!fits([item]))
        throw new WigwagError('transport', 'Message metadata exceeds the Claude channel payload budget');
      batch.push(item);
      originals.push(original);
    }
    flush();
  }
}
