import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexNames, codexIndexPath, readIndexName, threadMeta } from '../../src/native/codex-names.js';

class FakeApp extends EventEmitter {
  calls: Array<{ method: string; params: { threadId?: string; includeTurns?: boolean; cursor?: string } }> = [];
  /** Pages returned by thread/loaded/list, in order. */
  loadedPages: string[][] = [[]];
  loadedResponses: unknown[] = [];
  constructor(
    readonly threads: Record<string, Record<string, unknown>>,
    readonly fail = false,
  ) {
    super();
  }
  async connect() {
    if (this.fail) throw new Error('connect ENOENT');
  }
  async call(method: string, params: { threadId?: string; cursor?: string }): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'thread/loaded/list') {
      if (this.loadedResponses.length)
        return this.loadedResponses.length > 1 ? this.loadedResponses.shift() : this.loadedResponses[0];
      const i = params.cursor ? Number(params.cursor) : 0;
      return { data: this.loadedPages[i], nextCursor: i + 1 < this.loadedPages.length ? String(i + 1) : null };
    }
    const t = this.threads[params.threadId ?? ''];
    if (!t) throw new Error('Codex app-server error -32600: thread not found');
    return { thread: t };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
const root = (id: string, name: string | null = null) => ({
  id,
  sessionId: id,
  parentThreadId: null,
  forkedFromId: null,
  source: 'cli',
  name,
});
const missingIndex = () => join(mkdtempSync(join(tmpdir(), 'ww-ci-')), 'missing-index.jsonl');
const indexFile = (lines: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'ww-ci-')), 'session_index.jsonl');
  writeFileSync(p, lines.join('\n'));
  return p;
};

describe('threadMeta', () => {
  it('a root thread is its own session id, has no parent and a non-sub-agent source', () => {
    expect(threadMeta({ thread: root('t1', 'Named') }, 't1')).toEqual({
      id: 't1',
      name: 'Named',
      root: true,
      forkedFromId: null,
    });
  });
  it.each([
    ['a descendant sharing the root session id', { ...root('t2'), sessionId: 't1' }],
    ['a sub-agent source', { ...root('t2'), source: { subAgent: 'review' } }],
    ['a parent thread', { ...root('t2'), parentThreadId: 't1' }],
    ['a missing source', { ...root('t2'), source: undefined }],
    ['an unknown source', { ...root('t2'), source: 'unknown' }],
  ])('is not root for %s', (_label, thread) => {
    expect(threadMeta({ thread }, 't2')?.root).toBe(false);
  });
  it('rejects a response for another thread and never uses title', () => {
    expect(threadMeta({ thread: root('other') }, 't1')).toBeNull();
    expect(threadMeta({ thread: { ...root('t1'), title: 'first prompt' } }, 't1')?.name).toBeNull();
  });
});

describe('readIndexName', () => {
  it('returns the newest entry for the thread and skips a torn last line', () => {
    const p = indexFile([
      '{"id":"t1","thread_name":"Old","updated_at":"1"}',
      '{"id":"t2","thread_name":"Other","updated_at":"2"}',
      '{"id":"t1","thread_name":"New name","updated_at":"3"}',
      '{"id":"t1","thread_na',
    ]);
    expect(readIndexName(p, 't1')).toBe('New name');
    expect(readIndexName(p, 't3')).toBeNull();
    expect(readIndexName(missingIndex(), 't1')).toBeNull();
  });
  it('derives the index path from the app-server socket location', () => {
    expect(codexIndexPath('/h/.codex/app-server-control/app-server-control.sock')).toBe(
      '/h/.codex/session_index.jsonl',
    );
  });
});

describe('CodexNames', () => {
  it.each([
    ['non-array data', { data: 't1', nextCursor: null }],
    ['non-string thread id', { data: ['t1', 42], nextCursor: null }],
    ['invalid next cursor', { data: ['t1'], nextCursor: 42 }],
  ])('treats %s as unknown without returning a partial loaded-thread list', async (_label, response) => {
    const app = new FakeApp({});
    app.loadedResponses = [response];
    const names = new CodexNames({ factory: () => app, indexPath: missingIndex() });
    expect(await names.loadedThreads()).toBeNull();
    names.stop();
  });

  it.each([{ data: ['t1'], nextCursor: null }, { data: ['t1'] }])(
    'accepts null or absent cursors at the end of a valid listing',
    async (response) => {
      const app = new FakeApp({});
      app.loadedResponses = [response];
      const names = new CodexNames({ factory: () => app, indexPath: missingIndex() });
      expect(await names.loadedThreads()).toEqual(new Set(['t1']));
      names.stop();
    },
  );

  it('stops a repeated paging cursor and returns unknown without a partial list', async () => {
    const app = new FakeApp({});
    app.loadedResponses = [
      { data: ['t1'], nextCursor: 'again' },
      { data: ['t2'], nextCursor: 'again' },
    ];
    const names = new CodexNames({ factory: () => app, indexPath: missingIndex() });
    expect(await names.loadedThreads()).toBeNull();
    expect(app.calls).toEqual([
      { method: 'thread/loaded/list', params: {} },
      { method: 'thread/loaded/list', params: { cursor: 'again' } },
    ]);
    names.stop();
  });

  it('reads names with metadata-only thread/read and never thread/resume', async () => {
    const app = new FakeApp({ t1: root('t1', 'Initialize Wigwag session') });
    const names = new CodexNames({ factory: () => app, indexPath: missingIndex() });
    const seen: unknown[] = [];
    names.onName = (...a) => seen.push(a);
    await names.refresh('t1');
    expect(seen).toEqual([['t1', 'Initialize Wigwag session', 'codex-api']]);
    expect(app.calls).toEqual([{ method: 'thread/read', params: { threadId: 't1', includeTurns: false } }]);
    expect(names.available).toBe(true);
    names.stop();
  });

  it('follows thread/name/updated notifications on its connection', async () => {
    const app = new FakeApp({ t1: root('t1') });
    const names = new CodexNames({ factory: () => app, indexPath: missingIndex() });
    const seen: unknown[] = [];
    names.onName = (...a) => seen.push(a);
    await names.read('t1');
    app.emit('message', { method: 'thread/name/updated', params: { threadId: 't1', threadName: 'Renamed' } });
    app.emit('message', { method: 'thread/name/updated', params: { threadId: 't1', threadName: null } });
    expect(seen).toEqual([['t1', 'Renamed', 'codex-api']]);
    names.stop();
  });

  it('falls back to the index tail only when the app-server is unavailable', async () => {
    const p = indexFile(['{"id":"t1","thread_name":"From index","updated_at":"1"}']);
    const down = new CodexNames({ factory: () => new FakeApp({}, true), indexPath: p });
    const seen: unknown[] = [];
    down.onName = (...a) => seen.push(a);
    await down.refresh('t1');
    expect(seen).toEqual([['t1', 'From index', 'codex-index']]);
    expect(down.available).toBe(false);
    expect(await down.verifyRoot('t1')).toBe(false);
    const up = new CodexNames({ factory: () => new FakeApp({}), indexPath: p });
    up.onName = (...a) => seen.push(a);
    await up.refresh('t1'); // answered "thread not found": available, so no index fallback
    expect(seen).toHaveLength(1);
    expect(up.available).toBe(true);
  });

  it('verifies roots and reconnects after a disconnect', async () => {
    let made = 0;
    const app = new FakeApp({ t1: root('t1'), c1: { ...root('c1'), sessionId: 't1', parentThreadId: 't1' } });
    const names = new CodexNames({
      factory: () => {
        made++;
        return app;
      },
      indexPath: missingIndex(),
    });
    expect(await names.verifyRoot('t1')).toBe(true);
    expect(await names.verifyRoot('c1')).toBe(false);
    app.emit('disconnected');
    await names.read('t1');
    expect(made).toBe(2);
    names.stop();
  });

  it('lists loaded threads across pages (W8); null when the app-server is unreachable', async () => {
    const app = new FakeApp({});
    app.loadedPages = [['t1', 't2'], ['t3']];
    const names = new CodexNames({ factory: () => app, indexPath: missingIndex() });
    expect(await names.loadedThreads()).toEqual(new Set(['t1', 't2', 't3']));
    expect(app.calls.filter((c) => c.method === 'thread/loaded/list').map((c) => c.params)).toEqual([
      {},
      { cursor: '1' },
    ]);
    names.stop();
    const down = new CodexNames({ factory: () => new FakeApp({}, true), indexPath: missingIndex() });
    expect(await down.loadedThreads()).toBeNull();
    expect(down.available).toBe(false);
  });
});
