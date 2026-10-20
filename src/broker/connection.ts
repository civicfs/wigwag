import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { WigwagError } from '../errors.js';
import type { ProcessIdentity } from '../proc/identity.js';
import { encode } from '../protocol/frame.js';
import type { Hello, PushData, WireError } from '../protocol/rpc.js';

let seq = 0;

export class Connection {
  readonly id = ++seq;
  /** Set only once the hello handshake has fully succeeded; `role` (and so all access) derives from it. */
  hello: Hello | null = null;
  sessionId: string | null = null;
  /** W7: the slot's conn_generation when this connection took it; a stale connection's close leaves the slot alone. */
  generation = 0;
  /** Captured at hello; an older connected MCP may be replaced only after this process is gone. */
  mcpIdentity: ProcessIdentity | null = null;
  /** An unstamped client retains 0.2 messaging but cannot provide new identity/recovery evidence. */
  legacy = false;
  /**
   * E-3: whether this MCP client can take channel pushes (hello.channel); undefined for a peer that did not say. Set during
   * hello, before the session is announced: `hello` itself is published only after the welcome is written.
   */
  channel: boolean | undefined;
  /** Negotiated before onHello can announce a backlog; never inherited by a replacement connection. */
  channelReceipts = false;
  ownerSubscribed = false;
  private failedFlag = false;
  private readonly channelWrites = new Map<
    string,
    { sessionId: string | null; generation: number; finish: (error?: Error) => void }
  >();

  constructor(
    private readonly socket: Socket,
    private readonly receiptTimeoutMs = 10000,
  ) {
    socket.on('close', () => this.rejectChannelWrites('Claude channel connection closed'));
  }

  get role(): Hello['role'] | null {
    return this.hello?.role ?? null;
  }

  /** True once the broker has given up on this connection; no further frames are processed. */
  get failed(): boolean {
    return this.failedFlag;
  }

  /** True once the socket is gone (peer closed, failed, or destroyed). */
  get closed(): boolean {
    return this.socket.destroyed;
  }

  write(obj: unknown, onFlushed?: (err?: Error | null) => void): boolean {
    if (this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(encode(obj), onFlushed);
    return true;
  }

  reply(id: number, result: unknown): void {
    this.write({ id, result: result ?? null });
  }

  replyError(id: number, error: WireError): void {
    this.write({ id, error });
  }

  event(name: 'push' | 'feed' | 'session.identity', data: unknown): boolean {
    return this.write({ event: name, data });
  }

  /** Await only the local MCP notification write, never provider/model consumption. */
  channelPush(data: PushData, signal?: AbortSignal): Promise<void> {
    if (!this.channelReceipts) {
      return this.event('push', data)
        ? Promise.resolve()
        : Promise.reject(new WigwagError('transport', 'No live Claude channel connection'));
    }
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted || this.failed || this.closed) {
        reject(new WigwagError('transport', 'Claude channel push cancelled or disconnected'));
        return;
      }
      const receiptId = randomUUID();
      const onAbort = () => finish(new WigwagError('transport', 'Claude channel push cancelled'));
      const timer = setTimeout(
        () => finish(new WigwagError('transport', 'Claude channel notification receipt timed out')),
        this.receiptTimeoutMs,
      );
      timer.unref();
      const finish = (error?: Error) => {
        const pending = this.channelWrites.get(receiptId);
        if (!pending) return;
        this.channelWrites.delete(receiptId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          // Do not announce a broken bridge as ready on every hook turn. Only a fresh connection re-enables it.
          // A failure from a conversation that has since changed cannot downgrade that replacement slot.
          if (pending.sessionId === this.sessionId && pending.generation === this.generation) this.channel = false;
          reject(error);
        } else resolve();
      };
      this.channelWrites.set(receiptId, { sessionId: this.sessionId, generation: this.generation, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (
          !this.write({ event: 'push', data: { ...data, receipt_id: receiptId } }, (error) => {
            if (error) finish(new WigwagError('transport', 'Claude channel socket write failed'));
          })
        )
          finish(new WigwagError('transport', 'No live Claude channel connection'));
      } catch {
        finish(new WigwagError('transport', 'Claude channel socket write failed'));
      }
    });
  }

  channelReceipt(receiptId: string, ok: boolean): boolean {
    const pending = this.channelWrites.get(receiptId);
    if (!pending) return false;
    if (pending.sessionId !== this.sessionId || pending.generation !== this.generation || this.failed || this.closed) {
      pending.finish(new WigwagError('transport', 'Claude channel receipt belongs to a superseded session connection'));
      return false;
    }
    pending.finish(ok ? undefined : new WigwagError('transport', 'Claude channel notification write failed'));
    return true;
  }

  private rejectChannelWrites(message: string): void {
    for (const pending of this.channelWrites.values()) pending.finish(new WigwagError('transport', message));
  }

  close(): void {
    this.rejectChannelWrites('Claude channel connection closed');
    this.socket.end();
  }

  destroy(): void {
    this.rejectChannelWrites('Claude channel connection destroyed');
    this.socket.destroy();
  }

  /**
   * Gives up on the connection: stops reading at once, sends `error` as the last frame, and destroys the
   * socket as soon as that frame is flushed (or immediately if it cannot be written).
   */
  fail(id: number | null, error: WireError): void {
    if (this.failedFlag) return;
    this.failedFlag = true;
    this.rejectChannelWrites('Claude channel connection failed');
    this.socket.pause();
    let queued = false;
    try {
      queued = this.write({ id, error }, () => this.socket.destroy());
    } catch {
      queued = false;
    }
    if (!queued) this.socket.destroy();
  }
}
