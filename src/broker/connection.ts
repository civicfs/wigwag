import type { Socket } from 'node:net';
import type { ProcessIdentity } from '../proc/identity.js';
import { encode } from '../protocol/frame.js';
import type { Hello, WireError } from '../protocol/rpc.js';

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
  /**
   * E-3: whether this MCP client can take channel pushes (hello.channel); undefined for a peer that did not say. Set during
   * hello, before the session is announced: `hello` itself is published only after the welcome is written.
   */
  channel: boolean | undefined;
  ownerSubscribed = false;
  private failedFlag = false;

  constructor(private readonly socket: Socket) {}

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

  event(name: 'push' | 'feed', data: unknown): boolean {
    return this.write({ event: name, data });
  }

  close(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  /**
   * Gives up on the connection: stops reading at once, sends `error` as the last frame, and destroys the
   * socket as soon as that frame is flushed (or immediately if it cannot be written).
   */
  fail(id: number | null, error: WireError): void {
    if (this.failedFlag) return;
    this.failedFlag = true;
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
