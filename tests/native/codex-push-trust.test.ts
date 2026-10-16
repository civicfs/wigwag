import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import { tmpHome } from '../helpers.js';

const root = (id: string) => ({ id, sessionId: id, source: 'cli', parentThreadId: null });
class FakeApp extends EventEmitter {
  loaded = ['T'];
  threads: Record<string, unknown> = { T: root('T') };
  down = false;
  calls: string[] = [];
  async connect() {
    if (this.down) throw new Error('fixture unavailable');
  }
  async call(method: string, p: { threadId?: string }) {
    this.calls.push(method);
    if (this.down) throw new Error('fixture unavailable');
    return method === 'thread/loaded/list' ? { data: this.loaded } : { thread: this.threads[p.threadId ?? ''] };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
const reader = (app: FakeApp) => new CodexNames({ factory: () => app, indexPath: `${tmpHome()}/missing` });

describe('Codex push trust: metadata only', () => {
  it('trusts one loaded root, caches briefly, and fresh checks detect a descendant appearing', async () => {
    const app = new FakeApp(),
      names = reader(app);
    try {
      expect(await names.pushTrust('T')).toEqual({ trusted: true, reason: null });
      const count = app.calls.length;
      expect(await names.pushTrust('T')).toEqual({ trusted: true, reason: null });
      expect(app.calls).toHaveLength(count);
      app.loaded.push('child');
      app.threads.child = { ...root('child'), sessionId: 'T', parentThreadId: 'T', source: { subAgent: 'review' } };
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'descendant-loaded' });
      expect(app.calls.every((m) => m === 'thread/read' || m === 'thread/loaded/list')).toBe(true);
    } finally {
      names.stop();
    }
  });
  it.each(['root-not-loaded', 'shared-root', 'app-server-unavailable'] as const)('fails closed: %s', async (reason) => {
    const app = new FakeApp(),
      names = reader(app);
    if (reason === 'root-not-loaded') app.loaded = [];
    if (reason === 'shared-root') app.threads.T = { ...root('T'), sessionId: 'other' };
    if (reason === 'app-server-unavailable') app.down = true;
    try {
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason });
    } finally {
      names.stop();
    }
  });
  it('rejects unreadable loaded metadata and bounds the number of metadata reads', async () => {
    const app = new FakeApp(),
      names = reader(app);
    try {
      app.loaded.push('unknown');
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'app-server-unavailable' });
      app.loaded = Array.from({ length: 257 }, (_, i) => String(i));
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'app-server-unavailable' });
    } finally {
      names.stop();
    }
  });
});
