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

  async push(session: SessionRow, items: RenderItem[]): Promise<void> {
    const conn = this.connectionFor(session.id);
    if (conn && !this.hasChannel(session)) {
      throw new WigwagError('transport', `Session ${session.name ?? session.id} has no usable Claude channel`);
    }
    if (!conn?.event('push', renderClaude(items))) {
      throw new WigwagError('transport', `No live connection for session ${session.name ?? session.id}`);
    }
  }
}
