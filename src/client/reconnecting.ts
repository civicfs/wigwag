import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.js';
import { WigwagError } from '../errors.js';
import { frameLimit } from '../protocol/frame.js';
import type { Hello, MethodName } from '../protocol/rpc.js';
import { ensureBroker, sockPath } from './autospawn.js';
import { Client } from './client.js';

type Waiter = { resolve: (c: Client) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const stoppedError = () => new WigwagError('transport', 'wigwag client stopped');

/**
 * A broker connection that reconnects with backoff after the broker goes away. stop() is final: it
 * cancels any in-flight connect (destroying a connection that completes late), any retry sleep, and
 * rejects every call waiting for a connection.
 */
export class ReconnectingClient extends EventEmitter {
  private client: Client | null = null;
  private stopped = false;
  private readonly waiters = new Set<Waiter>();
  private readonly abort = new AbortController();
  /** Why the last connection attempt failed; cleared on success. Reported to calls that time out waiting. */
  private lastError: string | null = null;

  constructor(private readonly o: { home: string; config: Config; entry: string | null; hello: () => Hello }) {
    super();
  }

  start(): Promise<unknown> {
    return this.connectOnce();
  }

  /** Final review I-6: after a failed start(), keep connecting with backoff; 'reconnected' fires on success. */
  retryInBackground(): void {
    if (!this.stopped && !this.client) void this.reconnect();
  }

  private async connectOnce(): Promise<unknown> {
    if (this.stopped) throw stoppedError();
    const signal = this.abort.signal;
    try {
      if (this.o.entry) await ensureBroker(this.o.home, this.o.config, this.o.entry, signal);
      if (this.stopped) throw stoppedError();
      // Final review I-6: the hello has its own budget, separate from ensureBroker's wait. A broker that accepts but
      // never answers cannot hang the attempt.
      // Building the hello reads the process table (a spawn that stalls under CPU load); that is local work, so it is
      // done before the budget starts and cannot be charged to the broker.
      const hello = this.o.hello();
      const budget = this.o.config.broker.start_timeout_ms;
      const helloTimeout = AbortSignal.timeout(budget);
      try {
        return this.install(
          await Client.connect(
            sockPath(this.o.home),
            hello,
            frameLimit(this.o.config),
            (name, data) => this.emit('event', name, data),
            AbortSignal.any([signal, helloTimeout]),
          ),
        );
      } catch (e) {
        if (helloTimeout.aborted && !this.stopped) {
          throw new WigwagError('transport', `broker did not answer hello within ${budget} ms`);
        }
        throw e;
      }
    } catch (e) {
      if (!this.stopped) this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  private install({ client, welcome }: { client: Client; welcome: unknown }): unknown {
    if (this.stopped) {
      client.destroy();
      throw stoppedError();
    }
    this.client = client;
    this.lastError = null;
    client.on('close', () => {
      if (this.client !== client) return;
      this.client = null;
      void this.reconnect();
    });
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(client);
    }
    this.waiters.clear();
    return welcome;
  }

  private async reconnect(): Promise<void> {
    let delay = this.o.config.retry.base_ms;
    while (!this.stopped) {
      try {
        const welcome = await this.connectOnce();
        this.emit('reconnected', welcome);
        return;
      } catch {
        if (this.stopped) return;
        try {
          await sleep(delay, undefined, { signal: this.abort.signal });
        } catch {
          return; // stop() aborted the sleep
        }
        delay = Math.min(delay * 2, this.o.config.retry.base_ms * 16);
      }
    }
  }

  async call<T = unknown>(method: MethodName, params: unknown = {}): Promise<T> {
    if (this.stopped) throw stoppedError();
    const client = this.client ?? (await this.waitConnected());
    return client.call<T>(method, params);
  }

  private waitConnected(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          reject(
            new WigwagError('transport', `wigwag broker unavailable${this.lastError ? `: ${this.lastError}` : ''}`),
          );
        }, this.o.config.broker.start_timeout_ms),
      };
      this.waiters.add(w);
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(stoppedError());
    }
    this.waiters.clear();
    const client = this.client;
    this.client = null;
    client?.close();
  }
}
