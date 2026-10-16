import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { WigwagError } from '../errors.js';
import type { CodexNames } from '../native/codex-names.js';
import { type ProcessProbe, systemProbe } from '../proc/identity.js';
import { frameLimit, LineDecoder } from '../protocol/frame.js';
import {
  type Access,
  type FeedData,
  type Hello,
  HelloZ,
  METHODS,
  type MethodName,
  type Params,
  type WireError,
} from '../protocol/rpc.js';
import type { QuestionService } from '../questions/service.js';
import { type Db, openDb } from '../store/db.js';
import type { SessionRow } from '../store/sessions.js';
import { WorkspaceResolver } from '../workspace.js';
import { Connection } from './connection.js';
import type { DeliveryEngine } from './delivery.js';
import type { Liveness } from './liveness.js';
import { BrokerLock } from './lock.js';
import type { NameService } from './naming.js';

export interface HandlerCtx {
  conn: Connection;
  broker: Broker;
}
type Handler = (ctx: HandlerCtx, params: never) => unknown;

export function toWire(e: unknown): WireError {
  if (e instanceof WigwagError) return { code: e.code, message: e.message, data: e.data };
  if (e instanceof z.ZodError) return { code: 'bad_request', message: z.prettifyError(e) };
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
};

export class Broker {
  readonly db: Db;
  readonly bus = new EventEmitter();
  readonly connections = new Set<Connection>();
  readonly sockPath: string;
  /** cwd → workspace id, git bounded and cached for this broker's lifetime (final review I-5). */
  readonly workspaces = new WorkspaceResolver((line) => this.log(line));
  onHello: (conn: Connection, hello: Hello) => unknown = (_conn, hello) => {
    if (hello.role === 'mcp') throw new WigwagError('not_implemented', 'mcp sessions require the identity module');
    return { role: hello.role };
  };
  onDisconnect: Array<(conn: Connection) => void> = [];
  onStart: Array<() => void> = [];
  onStop: Array<() => void> = [];
  engine: DeliveryEngine | null = null;
  questions!: QuestionService;
  naming!: NameService;
  codexNames: CodexNames | null = null;
  checkCodexPush: (
    s: SessionRow,
    fresh?: boolean,
    announce?: boolean,
  ) => Promise<import('../store/sessions.js').CodexPushReason | null> = async () => 'app-server-unavailable';
  processProbe: ProcessProbe = systemProbe;
  /** No trusted concrete Codex thread ID is available from the shipped hooks yet. */
  trustedThreadId: (session: SessionRow) => string | null = () => null;
  liveness: Liveness | null = null;
  digestProvider: ((name: string) => string | null) | null = null;
  /** Identity's announce (sweep the name's backlog, owner broadcast, session.available); set by installIdentity. */
  announce: (sessionId: string) => void = () => {};
  private readonly handlers = new Map<string, Handler>();
  private readonly logPath: string;
  /** In-flight hello per connection; frames that arrive behind it wait for its outcome. */
  private readonly handshakes = new WeakMap<Connection, Promise<boolean>>();
  // Resources this instance acquired and still owns. stop() releases exactly these, once.
  private lock: BrokerLock | null = null;
  private server: Server | null = null;
  private ownsSocket = false;
  private dbOpen = true;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    readonly home: string,
    readonly config: Config,
  ) {
    mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
    this.sockPath = join(home, 'broker.sock');
    this.logPath = join(home, 'logs', 'broker.log');
    this.db = openDb(join(home, 'state.db'));
  }

  handle<M extends MethodName>(method: M, h: (ctx: HandlerCtx, params: Params<M>) => unknown): void {
    this.handlers.set(method, h as Handler);
  }

  /** Best-effort: a failed log write (full disk, removed home) is ignored and never fails the caller. */
  log(line: string): void {
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // ignored by design (ruling R34)
    }
  }

  connectionFor(sessionId: string): Connection | undefined {
    for (const c of this.connections) if (c.sessionId === sessionId && !c.failed && !c.closed) return c;
    return undefined;
  }

  broadcastOwner(type: FeedData['type'], payload: unknown): void {
    for (const c of this.connections) if (c.role === 'owner' && c.ownerSubscribed) c.event('feed', { type, payload });
  }

  /**
   * onStart hooks run after the lock is held and before connections are accepted. Any failure after the
   * lock is taken releases everything acquired so far (and closes the db) before rethrowing; the instance
   * is then spent. start() may be called once.
   */
  start(): Promise<void> {
    if (this.startPromise || this.stopPromise) {
      return Promise.reject(new WigwagError('internal', 'Broker.start() may only be called once, before stop()'));
    }
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    try {
      this.lock = BrokerLock.acquire(this.home);
      for (const f of this.onStart) f();
      // We hold the lock, so whatever sits at the socket path was left by a dead broker.
      unlinkIfPresent(this.sockPath);
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(this.sockPath, () => {
          server.off('error', rej);
          res();
        });
      });
      this.ownsSocket = true;
      server.on('error', (e) => this.log(`server error: ${e.message}`));
      chmodSync(this.sockPath, 0o600);
      this.started = true;
      this.log(`broker started pid=${process.pid}`);
    } catch (e) {
      await this.release();
      throw e;
    }
  }

  /** Idempotent; safe on an instance that never started or failed to start. Waits for an in-flight start. */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      const starting = this.startPromise;
      this.stopPromise = (async () => {
        for (const f of this.onStop) this.attempt('onStop hook', f);
        if (starting) await starting.catch(() => {});
        // Final review I-10: in-flight pushes record their outcome before the db closes (bounded).
        await this.engine?.drain(this.config.codex.queue_timeout_ms).catch(() => {});
        await this.release();
      })();
    }
    return this.stopPromise;
  }

  /** Runs one shutdown step; a throw is logged (best-effort) so the remaining steps still run. */
  private attempt(step: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log(`${step} failed during shutdown: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Releases only what this instance acquired and still owns, in an order that keeps the lock until the
   * socket is gone: no other broker can bind the path while we may still remove it. Never throws: each
   * step is isolated so the mutex is released and the db closed even if an earlier step fails (R34).
   */
  private async release(): Promise<void> {
    for (const c of this.connections) this.attempt('connection destroy', () => c.destroy());
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((res) => server.close(() => res()));
    if (this.ownsSocket) {
      this.ownsSocket = false;
      this.attempt('socket unlink', () => unlinkIfPresent(this.sockPath));
    }
    if (this.started) {
      this.started = false;
      this.log('broker stopped');
    }
    const lock = this.lock;
    this.lock = null;
    if (lock) this.attempt('lock release', () => lock.release());
    this.attempt('bus cleanup', () => this.bus.removeAllListeners());
    if (this.dbOpen) {
      this.dbOpen = false;
      this.attempt('db close', () => this.db.close());
    }
  }

  private accept(socket: Socket): void {
    const conn = new Connection(socket);
    const decoder = new LineDecoder(frameLimit(this.config));
    this.connections.add(conn);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (conn.failed) return;
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (e) {
        conn.fail(null, toWire(e));
        return;
      }
      for (const f of frames) {
        this.onFrame(conn, f).catch((e: unknown) => {
          this.log(`frame handling failed on connection ${conn.id}: ${(e as Error)?.stack ?? String(e)}`);
          conn.destroy();
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.connections.delete(conn);
      for (const f of this.onDisconnect) {
        try {
          f(conn);
        } catch (e) {
          this.log(`onDisconnect error: ${(e as Error).message}`);
        }
      }
    });
  }

  private checkAccess(conn: Connection, access: Access, method: string): void {
    const ok =
      access === 'any' ||
      (access === 'owner' && conn.role === 'owner') ||
      (access === 'hook' && conn.role === 'hook') ||
      (access === 'session' && conn.role === 'mcp' && conn.sessionId !== null) ||
      (access === 'session+owner' && (conn.role === 'owner' || (conn.role === 'mcp' && conn.sessionId !== null)));
    if (!ok) throw new WigwagError('bad_request', `${method} is not allowed for role ${conn.role}`);
  }

  private async onFrame(conn: Connection, frame: unknown): Promise<void> {
    if (conn.failed) return;
    if (!isObject(frame)) {
      conn.write({ id: null, error: { code: 'bad_request', message: 'frame must be a JSON object' } });
      return;
    }
    const { id, method, params } = frame;
    if (typeof id !== 'number' || typeof method !== 'string') {
      conn.write({ id: null, error: { code: 'bad_request', message: 'frame needs numeric id and string method' } });
      return;
    }
    if (!conn.hello) {
      const pending = this.handshakes.get(conn);
      if (!pending) {
        if (method !== 'hello') {
          conn.replyError(id, { code: 'bad_request', message: 'first call must be hello' });
          return;
        }
        const handshake = this.handshake(conn, id, params);
        this.handshakes.set(conn, handshake);
        await handshake;
        return;
      }
      // Frames sent behind an unfinished hello wait for it, in arrival order, and die with it.
      if (!(await pending) || conn.failed) return;
    }
    try {
      const def = (METHODS as Record<string, { access: Access; params: z.ZodType }>)[method];
      if (!def) throw new WigwagError('bad_request', `Unknown method ${method}`);
      this.checkAccess(conn, def.access, method);
      const parsed = def.params.safeParse(params ?? {});
      if (!parsed.success) throw new WigwagError('bad_request', z.prettifyError(parsed.error));
      const h = this.handlers.get(method);
      if (!h) throw new WigwagError('not_implemented', `${method} is not implemented in this version`);
      conn.reply(id, await h({ conn, broker: this }, parsed.data as never));
    } catch (e) {
      const wire = toWire(e);
      if (wire.code === 'internal') this.log(`internal error in ${method}: ${(e as Error)?.stack ?? String(e)}`);
      conn.replyError(id, wire);
    }
  }

  /**
   * Runs onHello and publishes the identity (conn.hello, hence conn.role) only once it succeeded and the
   * welcome was written. On failure the connection is failed: the error is the last frame and the socket
   * is destroyed, so nothing queued behind the hello is ever authorized.
   */
  private async handshake(conn: Connection, id: number, params: unknown): Promise<boolean> {
    try {
      const hello = HelloZ.parse(params);
      const welcome = await this.onHello(conn, hello);
      // The peer may have gone away while onHello ran: frames queued behind it must not run.
      if (conn.failed || conn.closed) return false;
      conn.reply(id, welcome);
      conn.hello = hello;
      return true;
    } catch (e) {
      const wire = toWire(e);
      if (wire.code === 'internal') this.log(`internal error in hello: ${(e as Error)?.stack ?? String(e)}`);
      conn.fail(id, wire);
      return false;
    }
  }
}
