import { existsSync, type FSWatcher, statSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import type { Broker } from '../broker/server.js';
import { getSession, listSessions, type SessionRow } from '../store/sessions.js';
import { readSidecarTitle, sidecarPath, validTranscriptPath } from './claude-title.js';

export const CLAUDE_TITLE_RECONCILE_MS = 15000;
const DEBOUNCE_MS = 200;

type Watched = SessionRow & { native_ref: string; agent_session_id: string };
const watchable = (s: SessionRow | undefined): s is Watched =>
  !!s &&
  s.agent === 'claude' &&
  s.state !== 'offline' &&
  !!s.agent_session_id &&
  validTranscriptPath(s.native_ref, s.agent_session_id);

/**
 * W2 (S-B): a Claude /rename while idle fires no hook. Live bound Claude sessions with a known transcript get their
 * title sidecar re-read when its directory changes (best effort) and on every reconcile (mtime-gated). Sidecar only:
 * the transcript scan stays at SessionStart.
 */
export class ClaudeTitleWatcher {
  private readonly mtimes = new Map<string, number>();
  private readonly watchers = new Map<string, { dir: string; watcher: FSWatcher }>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly broker: Broker,
    intervalMs = CLAUDE_TITLE_RECONCILE_MS,
  ) {
    this.timer = setInterval(() => this.reconcile(), intervalMs);
    this.timer.unref();
  }

  reconcile(): void {
    try {
      const live = listSessions(this.broker.db).filter(watchable);
      const ids = new Set(live.map((s) => s.id));
      for (const id of [...this.watchers.keys()]) if (!ids.has(id)) this.unwatch(id);
      for (const id of [...this.mtimes.keys()]) if (!ids.has(id)) this.mtimes.delete(id);
      for (const s of live) {
        this.ensureWatch(s);
        this.check(s);
      }
    } catch (e) {
      this.broker.log(`claude title reconcile: ${(e as Error).message}`);
    }
  }

  private check(s: Watched): void {
    let mtime: number;
    try {
      mtime = statSync(sidecarPath(s.native_ref, s.agent_session_id)).mtimeMs;
    } catch {
      return;
    }
    if (this.mtimes.get(s.id) === mtime) return;
    this.mtimes.set(s.id, mtime);
    const t = readSidecarTitle(s.native_ref, s.agent_session_id);
    if (t) this.broker.naming.adoptNative(s.id, t, 'claude-sidecar');
  }

  private ensureWatch(s: Watched): void {
    const sidecarDir = dirname(sidecarPath(s.native_ref, s.agent_session_id));
    const dir = existsSync(sidecarDir) ? sidecarDir : dirname(s.native_ref);
    if (this.watchers.get(s.id)?.dir === dir) return;
    this.unwatch(s.id);
    try {
      const watcher = watch(dir, { persistent: false }, () => this.schedule(s.id));
      watcher.on('error', () => this.unwatch(s.id));
      this.watchers.set(s.id, { dir, watcher });
    } catch {
      // The periodic reconcile still covers this session.
    }
  }

  private schedule(id: string): void {
    clearTimeout(this.debounce.get(id));
    const t = setTimeout(() => {
      this.debounce.delete(id);
      try {
        const s = getSession(this.broker.db, id);
        if (!watchable(s)) return;
        this.ensureWatch(s);
        this.check(s);
      } catch (e) {
        this.broker.log(`claude title watch: ${(e as Error).message}`);
      }
    }, DEBOUNCE_MS);
    t.unref();
    this.debounce.set(id, t);
  }

  private unwatch(id: string): void {
    this.watchers.get(id)?.watcher.close();
    this.watchers.delete(id);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}
