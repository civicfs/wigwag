import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { WigwagError } from '../errors.js';
import { VERSION } from '../version.js';

export interface AppFrame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}
/** Connect only to the existing local daemon. Never start, restart or replace it. */
export class AppServer extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    readonly socketPath: string,
    readonly timeoutMs: number,
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (this.ws) throw new WigwagError('conflict', 'App-server client already connected');
    const ws = new WebSocket(`ws+unix://${this.socketPath}:/`, {
      maxPayload: 16777216,
      perMessageDeflate: false,
      handshakeTimeout: this.timeoutMs,
    });
    this.ws = ws;
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new WigwagError('transport', 'Codex app-server connection closed'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('binary app-server message');
        const f = JSON.parse(data.toString()) as AppFrame;
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('invalid frame');
        // Server requests can have the same ID as our client requests: method always wins.
        if (typeof f.method === 'string') {
          this.emit('message', f);
          return;
        }
        const p = typeof f.id === 'number' ? this.pending.get(f.id) : undefined;
        if (!p) return;
        this.pending.delete(f.id as number);
        clearTimeout(p.timer);
        if (f.error)
          p.reject(
            new WigwagError(
              'transport',
              `Codex app-server error ${f.error.code ?? 'unknown'}: ${f.error.message ?? 'request failed'}`,
            ),
          );
        else p.resolve(f.result);
      } catch {
        ws.terminate();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', () => reject(new WigwagError('transport', 'Codex app-server closed during handshake')));
      });
      await this.call('initialize', {
        clientInfo: { name: 'wigwag', title: 'Wigwag native question relay', version: VERSION },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: 'initialized', params: {} });
    } catch (e) {
      this.close();
      throw e;
    }
  }
  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WigwagError('transport', `Codex ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  send(frame: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new WigwagError('transport', 'Codex app-server is not connected');
    this.ws.send(JSON.stringify(frame));
  }
  close(): void {
    this.ws?.terminate();
    this.ws = null;
  }
}
