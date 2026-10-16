import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { type ErrorCode, WigwagError } from '../errors.js';
import { encode, LineDecoder } from '../protocol/frame.js';
import { assertPeerVersions, BROKER_OLDER, HANDSHAKE_VERSIONS, type Hello, type MethodName } from '../protocol/rpc.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Client extends EventEmitter {
  versionWarning: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    maxFrameBytes: number,
  ) {
    super();
    const decoder = new LineDecoder(maxFrameBytes);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      // Any malformed input, or a throwing 'event' listener, drops this connection (pending calls reject
      // with `transport`); it never escapes as an uncaught exception.
      try {
        for (const f of decoder.push(chunk)) {
          if (socket.destroyed) return;
          this.onFrame(f);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new WigwagError('transport', 'broker connection closed'));
      this.pending.clear();
      this.emit('close');
    });
  }

  private onFrame(f: unknown): void {
    if (!isObject(f)) throw new WigwagError('transport', 'broker sent a frame that is not a JSON object');
    if (typeof f.event === 'string') {
      this.emit('event', f.event, f.data);
      return;
    }
    if (typeof f.id !== 'number') return;
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    if (f.error !== undefined) {
      const err = isObject(f.error) ? f.error : {};
      const code = (typeof err.code === 'string' ? err.code : 'internal') as ErrorCode;
      p.reject(new WigwagError(code, typeof err.message === 'string' ? err.message : 'broker error', err.data));
    } else p.resolve(f.result);
  }

  /**
   * `onEvent` is attached before hello is sent: the broker may push in the same read as the hello
   * reply, before the caller could attach a listener to the returned client. Aborting `signal` destroys
   * the connection attempt (including one waiting for its hello reply) and rejects with `transport`.
   */
  static async connect(
    sockPath: string,
    hello: Hello,
    maxFrameBytes: number,
    onEvent?: (name: string, data: unknown) => void,
    signal?: AbortSignal,
  ): Promise<{ client: Client; welcome: unknown }> {
    const aborted = () => new WigwagError('transport', 'connection attempt cancelled');
    if (signal?.aborted) throw aborted();
    const socket = await new Promise<Socket>((res, rej) => {
      const s = createConnection(sockPath);
      const onAbort = () => {
        s.destroy();
        rej(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      s.once('connect', () => {
        signal?.removeEventListener('abort', onAbort);
        s.removeAllListeners('error');
        res(s);
      });
      s.once('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        rej(e);
      });
    });
    const client = new Client(socket, maxFrameBytes);
    if (onEvent) client.on('event', onEvent);
    const onAbort = () => client.destroy();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw aborted();
      const welcome = await client.raw('hello', { ...HANDSHAKE_VERSIONS, ...hello });
      client.versionWarning = assertPeerVersions(welcome, 'broker').warning;
      if (signal?.aborted) throw aborted();
      return { client, welcome };
    } catch (e) {
      client.destroy();
      if (
        !signal?.aborted &&
        e instanceof WigwagError &&
        e.code === 'bad_request' &&
        /unrecognized.*(?:schema_version|version)/is.test(e.message)
      )
        throw new WigwagError('schema', BROKER_OLDER, { kind: 'version-skew' });
      throw signal?.aborted ? aborted() : e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  call<T = unknown>(method: MethodName, params: unknown = {}): Promise<T> {
    return this.raw(method, params) as Promise<T>;
  }

  private raw(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new WigwagError('transport', 'broker connection closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encode({ id, method, params }));
    });
  }

  /** Graceful: ends our side; the broker then closes and 'close' fires. */
  close(): void {
    this.socket.end();
  }

  /** Immediate: drops the connection; pending calls reject with `transport`. */
  destroy(): void {
    this.socket.destroy();
  }
}
