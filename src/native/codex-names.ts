import { dirname, join } from 'node:path';
import type { Broker } from '../broker/server.js';
import type { AppFrame } from '../questions/app-server.js';
import type { AppConnection } from '../questions/codex.js';
import { type CodexPushReason, listSessions, type SessionRow } from '../store/sessions.js';
import { tailLines } from './tail.js';

export const CODEX_INDEX_TAIL_BYTES = 65536;
export type CodexNameOrigin = 'codex-api' | 'codex-index';
export interface CodexThreadMeta {
  id: string;
  sessionId: string | null;
  name: string | null;
  /** The thread is its own tree root: sessionId === id, no parent, and a non-sub-agent source (fails closed). */
  root: boolean;
  forkedFromId: string | null;
}
export type CodexPushTrust = { trusted: true; reason: null } | { trusted: false; reason: CodexPushReason };
export type CodexReadResult = { available: true; meta: CodexThreadMeta | null } | { available: false };
export interface CodexMetadataSnapshot {
  loaded: Set<string> | null;
  reads: Map<string, CodexReadResult>;
}
interface MetadataConnection {
  app: AppConnection;
}

const ROOT_SOURCES = new Set(['cli', 'vscode', 'exec', 'appServer']);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Parses a thread/read result (Codex 0.162.1 v2 `Thread`). Never reads `title` (the first prompt, S-B). */
export function threadMeta(raw: unknown, threadId: string): CodexThreadMeta | null {
  const t = (raw as { thread?: Record<string, unknown> } | null)?.thread;
  if (!t || t.id !== threadId) return null;
  const root =
    t.sessionId === threadId &&
    (t.parentThreadId ?? null) === null &&
    typeof t.source === 'string' &&
    ROOT_SOURCES.has(t.source);
  return {
    id: threadId,
    sessionId: nonEmpty(t.sessionId),
    name: nonEmpty(t.name),
    root,
    forkedFromId: typeof t.forkedFromId === 'string' ? t.forkedFromId : null,
  };
}

/** Newest `{id, thread_name}` entry for the thread in the index's last `maxBytes` (append-only; newest wins). */
export function readIndexName(indexPath: string, threadId: string, maxBytes = CODEX_INDEX_TAIL_BYTES): string | null {
  const lines = tailLines(indexPath, maxBytes);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(threadId)) continue;
    try {
      const e = JSON.parse(lines[i]) as { id?: unknown; thread_name?: unknown };
      if (e.id === threadId) return nonEmpty(e.thread_name);
    } catch {
      // torn trailing line
    }
  }
  return null;
}

/** `$CODEX_HOME/session_index.jsonl`, with CODEX_HOME taken from the configured `<home>/app-server-control/<sock>`. */
export const codexIndexPath = (appServerSocket: string): string =>
  join(dirname(dirname(appServerSocket)), 'session_index.jsonl');

/**
 * W2 (S-B) and W7 (S-E): one lazily opened app-server connection that only issues metadata-only `thread/read`. It never
 * resumes, subscribes or loads a thread. `available` is the outcome of the last current-connection call: an error response
 * (e.g. thread not found) counts as available; a transport failure does not and drops the connection.
 */
export class CodexNames {
  onName: (threadId: string, name: string, origin: CodexNameOrigin) => void = () => {};
  available: boolean | null = null;
  private app: MetadataConnection | null = null;
  private connecting: Promise<MetadataConnection> | null = null;
  private stopped = false;
  private readonly trustCache = new Map<string, { at: number; value: CodexPushTrust }>();
  private readonly snapshots = new Set<AbortController>();
  private readonly snapshotOwners = new WeakMap<CodexMetadataSnapshot, MetadataConnection>();

  constructor(
    private readonly opts: { factory: () => AppConnection; indexPath: string; log?: (line: string) => void },
  ) {}

  private connection(): Promise<MetadataConnection> {
    if (this.connecting) return this.connecting;
    if (this.app) return Promise.resolve(this.app);
    if (this.stopped) return Promise.reject(new Error('Codex name reader stopped'));
    const pending = (async () => {
      const app = this.opts.factory();
      const owner = { app };
      this.app = owner;
      app.on('message', (f: AppFrame) => {
        if (this.app === owner && !this.stopped) this.receive(f);
      });
      app.on('disconnected', () => {
        if (this.app !== owner) return;
        this.trustCache.clear();
        this.available = false;
        this.app = null;
      });
      try {
        await app.connect();
      } catch (e) {
        this.drop(owner);
        throw e;
      }
      if (this.stopped || this.app !== owner) {
        this.drop(owner);
        throw new Error('Codex name reader stopped');
      }
      return owner;
    })().finally(() => {
      if (this.connecting === pending) this.connecting = null;
    });
    this.connecting = pending;
    return pending;
  }

  private drop(owner: MetadataConnection): void {
    if (this.app !== owner) return;
    this.available = false;
    this.trustCache.clear();
    this.app = null;
    owner.app.close();
  }

  private receive(f: AppFrame): void {
    if (f.method !== 'thread/name/updated') return;
    const threadId = f.params?.threadId;
    const name = nonEmpty(f.params?.threadName);
    if (typeof threadId === 'string' && name) this.onName(threadId, name, 'codex-api');
  }

  async read(threadId: string): Promise<CodexReadResult> {
    let owner: MetadataConnection | undefined;
    try {
      owner = await this.connection();
      const raw = await owner.app.call('thread/read', { threadId, includeTurns: false });
      if (this.stopped || this.app !== owner) return { available: false };
      this.available = true;
      return { available: true, meta: threadMeta(raw, threadId) };
    } catch (e) {
      if (!owner || this.stopped || this.app !== owner) return { available: false };
      const answered = e instanceof Error && e.message.startsWith('Codex app-server error');
      this.available = answered;
      if (!answered) {
        this.opts.log?.(`codex names: app-server unavailable: ${e instanceof Error ? e.message : String(e)}`);
        this.drop(owner);
      }
      return answered ? { available: true, meta: null } : { available: false };
    }
  }

  /** One bounded pass; concrete recipients need only their own reads. Re-list after reads to confirm loading. */
  async metadataSnapshot(deadlineMs = 10000, threadIds?: Iterable<string>): Promise<CodexMetadataSnapshot> {
    const unknown = (): CodexMetadataSnapshot => ({ loaded: null, reads: new Map() });
    if (this.stopped || deadlineMs <= 0) return unknown();
    const controller = new AbortController();
    this.snapshots.add(controller);
    const cancelled = new Promise<CodexMetadataSnapshot>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(unknown()), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    timer.unref();
    const work = (async (): Promise<CodexMetadataSnapshot> => {
      const loaded = await this.loadedThreads();
      if (controller.signal.aborted || this.stopped || loaded === null) return unknown();
      const owner = this.app;
      if (!owner) return unknown();
      const reads = new Map<string, CodexReadResult>();
      const finish = (current: Set<string> | null) => {
        const snapshot = { loaded: current, reads };
        this.snapshotOwners.set(snapshot, owner);
        return snapshot;
      };
      if (!threadIds && loaded.size > 256) return finish(loaded);
      const ids = threadIds ? [...new Set(threadIds)].filter((id) => loaded.has(id)) : [...loaded];
      for (let i = 0; i < ids.length; i += 8) {
        const batch = ids.slice(i, i + 8);
        const results = await Promise.all(batch.map((id) => this.read(id)));
        if (controller.signal.aborted || this.stopped || this.app !== owner) return unknown();
        batch.forEach((id, j) => {
          reads.set(id, results[j]);
        });
      }
      const current = await this.loadedThreads();
      if (controller.signal.aborted || this.stopped || this.app !== owner) return unknown();
      return finish(current);
    })();
    try {
      return await Promise.race([work.catch(unknown), cancelled]);
    } finally {
      clearTimeout(timer);
      this.snapshots.delete(controller);
    }
  }

  /** A completed snapshot becomes unknown as soon as its metadata connection is replaced or stopped. */
  loadedIn(snapshot: CodexMetadataSnapshot): Set<string> | null {
    const owner = this.snapshotOwners.get(snapshot);
    return !this.stopped && owner && this.app === owner ? snapshot.loaded : null;
  }

  /**
   * Bounded metadata-only evidence; fresh checks bypass cached trust. `concreteRoot` is reserved for a supported host's
   * hook-verified concrete binding. It still requires that recipient's loaded/root metadata; defaults stay conservative.
   */
  async pushTrust(
    threadId: string,
    fresh = false,
    snapshot?: CodexMetadataSnapshot,
    concreteRoot = false,
  ): Promise<CodexPushTrust> {
    const cacheKey = `${concreteRoot ? 'concrete' : 'conservative'}:${threadId}`;
    const cached = this.trustCache.get(cacheKey);
    if (!snapshot && !fresh && cached && Date.now() - cached.at < 2000) return cached.value;
    let reason: CodexPushReason | null = 'app-server-unavailable';
    const data = snapshot ?? (await this.metadataSnapshot(10000, concreteRoot ? [threadId] : undefined));
    const loaded = this.loadedIn(data);
    if (loaded && !concreteRoot && loaded.size > 256) reason = 'too-many-loaded';
    else if (loaded) {
      if (!loaded.has(threadId)) reason = 'root-not-loaded';
      else {
        const own = data.reads.get(threadId);
        if (!own?.available || !own.meta?.sessionId) reason = 'unreadable-loaded';
        else {
          if (!own.meta.root) reason = 'shared-root';
          else {
            reason = null;
            if (!concreteRoot) {
              const others = [...loaded].filter((id) => id !== threadId).map((id) => data.reads.get(id));
              if (others.some((r) => !r?.available || !r.meta?.sessionId)) reason = 'unreadable-loaded';
              else if (others.some((r) => r?.available && r.meta?.sessionId === threadId)) reason = 'descendant-loaded';
            }
          }
        }
      }
    }
    const value: CodexPushTrust = reason === null ? { trusted: true, reason: null } : { trusted: false, reason };
    if (loaded !== null) this.trustCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  async verifyRoot(threadId: string): Promise<boolean> {
    const r = await this.read(threadId);
    return r.available && r.meta?.root === true;
  }

  async refresh(threadId: string): Promise<void> {
    const r = await this.read(threadId);
    if (this.stopped || (!r.available && this.available === true)) return;
    if (r.available) {
      if (r.meta?.name) this.onName(threadId, r.meta.name, 'codex-api');
      return;
    }
    const n = readIndexName(this.opts.indexPath, threadId);
    if (n) this.onName(threadId, n, 'codex-index');
  }

  /**
   * W8: ids of the threads the daemon has loaded (metadata only; never loads or subscribes). Null when the app-server
   * is unreachable or the listing is malformed or longer than 50 pages, so callers treat liveness as unknown.
   */
  async loadedThreads(): Promise<Set<string> | null> {
    let owner: MetadataConnection | undefined;
    try {
      owner = await this.connection();
      const out = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r = (await owner.app.call('thread/loaded/list', cursor ? { cursor } : {})) as {
          data?: unknown;
          nextCursor?: unknown;
        };
        if (this.stopped || this.app !== owner) return null;
        if (!Array.isArray(r?.data) || r.data.some((id) => typeof id !== 'string'))
          throw new Error('malformed thread/loaded/list data');
        if (r.nextCursor != null && typeof r.nextCursor !== 'string')
          throw new Error('malformed thread/loaded/list cursor');
        for (const id of r.data) out.add(id);
        cursor = typeof r.nextCursor === 'string' ? r.nextCursor : null;
        if (!cursor) break;
        if (cursors.has(cursor)) throw new Error('thread/loaded/list repeated a cursor');
        cursors.add(cursor);
      }
      if (cursor) throw new Error('thread/loaded/list exceeded 50 pages');
      this.available = true;
      return out;
    } catch (e) {
      if (!owner || this.stopped || this.app !== owner) return null;
      const answered = e instanceof Error && e.message.startsWith('Codex app-server error');
      this.available = answered;
      this.opts.log?.(`codex names: loaded-thread listing failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!answered) {
        this.drop(owner);
      }
      return null;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.snapshots) controller.abort();
    this.snapshots.clear();
    this.trustCache.clear();
    if (this.app) this.drop(this.app);
  }
}

export const CODEX_NAME_REFRESH_MS = 30000;

/** W2: Codex names refresh on bind, on name notifications, and every `intervalMs` for live bound Codex sessions. */
export function installCodexNames(broker: Broker, names: CodexNames, intervalMs = CODEX_NAME_REFRESH_MS): void {
  broker.codexNames = names;
  names.onName = (threadId, name, origin) => {
    const live = listSessions(broker.db).filter(
      (s) => s.agent === 'codex' && s.state !== 'offline' && s.agent_session_id === threadId,
    );
    if (live.length === 1 && (origin !== 'codex-index' || live[0].native_name === null))
      broker.naming.adoptNative(live[0].id, name, origin);
  };
  const refreshOne = (s: SessionRow | undefined) => {
    if (s?.agent !== 'codex' || !s.agent_session_id || s.state === 'offline') return;
    names.refresh(s.agent_session_id).catch((e) => broker.log(`codex names: ${(e as Error).message}`));
  };
  broker.bus.on('session.bound', refreshOne);
  const timer = setInterval(() => {
    for (const s of listSessions(broker.db)) refreshOne(s);
  }, intervalMs);
  timer.unref();
  broker.onStop.push(() => {
    clearInterval(timer);
    broker.bus.off('session.bound', refreshOne);
    names.stop();
  });
}
