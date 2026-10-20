import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Connection } from '../../src/broker/connection.js';
import type { RenderItem } from '../../src/broker/render.js';
import type { Hello } from '../../src/protocol/rpc.js';
import type { SessionRow } from '../../src/store/sessions.js';
import { ClaudeChannelTransport } from '../../src/transports/claude-channel.js';

const session = { id: 'ses-claude', name: 'claude-recipient', agent: 'claude' } as SessionRow;
const items = (body = 'from codex'): RenderItem[] => [
  {
    msg: {
      id: 'msg-claude',
      from_name: 'codex-sender',
      to_target: 'claude-recipient',
      kind: 'message',
      priority: 'normal',
      subject: 'delivery',
      body,
      attachments: [],
      reply_to: null,
      request_id: null,
      expires_at: null,
      stream: null,
      from_workspace: 'ws-test',
      created_at: '2026-10-20T00:00:00.000Z',
    } as RenderItem['msg'],
    attachments: [],
  },
];

function fixture(timeoutMs = 1000) {
  const socket = new PassThrough();
  const frames: Array<{ data: { receipt_id: string; content: string } }> = [];
  socket.on('data', (chunk) => frames.push(JSON.parse(String(chunk))));
  const conn = new Connection(socket as unknown as Socket, timeoutMs);
  conn.hello = { protocol: 1, role: 'mcp', agent: 'claude', channel_receipts: true } as Hello;
  conn.channel = true;
  conn.channelReceipts = true;
  conn.sessionId = session.id;
  const transport = new ClaudeChannelTransport(() => conn);
  return { conn, socket, frames, transport };
}

// Returning socket.write success before the host notification completes must not remove unread recovery.
describe('Claude channel notification receipts', () => {
  it('does not acknowledge a queued broker frame before the MCP notification receipt', async () => {
    const { socket, frames, transport } = fixture();
    let acknowledged = 0;
    const pending = transport.push(session, items(), {
      onPushed: (part) => {
        acknowledged += part.length;
      },
    });
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(acknowledged).toBe(0);
    socket.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'transport' });
  });

  it('accepts exactly one matching receipt on the connection that owns the push', async () => {
    const { conn, socket, frames, transport } = fixture();
    const other = fixture();
    const acknowledged: RenderItem[] = [];
    const pending = transport.push(session, items(), { onPushed: (part) => acknowledged.push(...part) });
    const id = frames[0].data.receipt_id;
    expect(other.conn.channelReceipt(id, true)).toBe(false);
    expect(conn.channelReceipt('00000000-0000-4000-8000-000000000000', true)).toBe(false);
    expect(acknowledged).toEqual([]);
    expect(conn.channelReceipt(id, true)).toBe(true);
    await pending;
    expect(acknowledged.map((item) => item.msg.id)).toEqual(['msg-claude']);
    expect(conn.channelReceipt(id, true)).toBe(false);
    socket.destroy();
    other.socket.destroy();
  });

  it('leaves originals unacknowledged when the host notification write fails', async () => {
    const { conn, socket, frames, transport } = fixture();
    const acknowledged: RenderItem[] = [];
    const pending = transport.push(session, items(), { onPushed: (part) => acknowledged.push(...part) });
    conn.channelReceipt(frames[0].data.receipt_id, false);
    await expect(pending).rejects.toMatchObject({
      code: 'transport',
      message: 'Claude channel notification write failed',
    });
    expect(acknowledged).toEqual([]);
    expect(conn.channel).toBe(false);
    socket.destroy();
  });

  it('rejects a late receipt after the connection changes slot generation', async () => {
    const { conn, socket, frames, transport } = fixture();
    const pending = transport.push(session, items());
    conn.generation++;
    expect(conn.channelReceipt(frames[0].data.receipt_id, true)).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: 'transport' });
    expect(conn.channel).toBe(true); // An old generation must not downgrade the replacement conversation.
    socket.destroy();
  });

  it('does not acknowledge a replaced connection after a successful receipt resolves its await', async () => {
    const { conn, socket, frames, transport } = fixture();
    const acknowledged: RenderItem[] = [];
    const pending = transport.push(session, items(), { onPushed: (part) => acknowledged.push(...part) });
    expect(conn.channelReceipt(frames[0].data.receipt_id, true)).toBe(true);
    conn.generation++;
    await expect(pending).rejects.toMatchObject({ code: 'transport' });
    expect(acknowledged).toEqual([]);
    socket.destroy();
  });

  it('bounds an absent notification receipt by the configured connection deadline', async () => {
    const { conn, socket, transport } = fixture(10);
    await expect(transport.push(session, items())).rejects.toMatchObject({
      code: 'transport',
      message: 'Claude channel notification receipt timed out',
    });
    expect(conn.channel).toBe(false);
    socket.destroy();
  });

  it('rejects an aborted write and ignores its late success receipt', async () => {
    const { conn, socket, frames, transport } = fixture();
    const abort = new AbortController();
    const pending = transport.push(session, items(), { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'transport' });
    expect(conn.channelReceipt(frames[0].data.receipt_id, true)).toBe(false);
    socket.destroy();
  });

  it('acknowledges only completed batches and preserves oversized stored-message references', async () => {
    const { conn, socket, frames, transport } = fixture();
    const original = Array.from({ length: 3 }, (_, index) => {
      const [item] = items('x'.repeat(index === 2 ? 30000 : 6000));
      return { ...item, msg: { ...item.msg, id: `msg-${index}` } };
    });
    const acknowledged: RenderItem[] = [];
    const pending = transport.push(session, original, { onPushed: (part) => acknowledged.push(...part) });
    expect(frames).toHaveLength(1);
    conn.channelReceipt(frames[0].data.receipt_id, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveLength(2);
    expect(acknowledged.map((item) => item.msg.id)).toEqual(['msg-0']);
    expect(frames[1].data.content).toContain('read_message, msg_id msg-2');
    conn.channelReceipt(frames[1].data.receipt_id, false);
    await expect(pending).rejects.toMatchObject({ code: 'transport' });
    expect(acknowledged.map((item) => item.msg.id)).toEqual(['msg-0']);
    socket.destroy();
  });
});
