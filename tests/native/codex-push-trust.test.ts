import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import { tmpHome } from '../helpers.js';

const root = (id: string) => ({ id, sessionId: id, source: 'cli', parentThreadId: null });
class FakeApp extends EventEmitter {
  loaded = ['T'];
  threads: Record<string, unknown> = { T: root('T') };
  down = false;
  readErrors = new Set<string>();
  calls: string[] = [];
  async connect() {
    if (this.down) throw new Error('fixture unavailable');
  }
  async call(method: string, p: { threadId?: string }) {
    this.calls.push(method);
    if (this.down) throw new Error('fixture unavailable');
    if (method === 'thread/read' && this.readErrors.has(p.threadId ?? ''))
      throw new Error('Codex app-server error: fixture unreadable');
    return method === 'thread/loaded/list' ? { data: this.loaded } : { thread: this.threads[p.threadId ?? ''] };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
const reader = (app: FakeApp) => new CodexNames({ factory: () => app, indexPath: `${tmpHome()}/missing` });

describe('Codex push trust: metadata only', () => {
  it('does not replace recovered trust with an old failed metadata snapshot', async () => {
    let enter = () => {},
      rejectOld = (_error: Error) => {};
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      old = new Promise<never>((_resolve, reject) => {
        rejectOld = reject;
      });
    const a = new FakeApp(),
      b = new FakeApp();
    a.call = async () => {
      enter();
      return old;
    };
    let made = 0;
    const names = new CodexNames({ factory: () => (++made === 1 ? a : b), indexPath: `${tmpHome()}/missing` });
    const checking = names.pushTrust('T', true);
    try {
      await entered;
      a.emit('disconnected');
      expect(await names.pushTrust('T', true)).toEqual({ trusted: true, reason: null });
      rejectOld(new Error('late failure on old connection'));
      await checking;
      const calls = b.calls.length;
      expect(await names.pushTrust('T')).toEqual({ trusted: true, reason: null });
      expect(b.calls).toHaveLength(calls);
    } finally {
      rejectOld(new Error('fixture cleanup'));
      await checking;
      names.stop();
    }
  });

  it.each(['unreadable', 'large'])(
    'checks only a verified concrete recipient with %s unrelated metadata',
    async (kind) => {
      const app = new FakeApp(),
        names = reader(app);
      app.loaded.push(...(kind === 'large' ? Array.from({ length: 256 }, (_, i) => `other-${i}`) : ['other']));
      try {
        expect(await names.pushTrust('T', true, undefined, true)).toEqual({ trusted: true, reason: null });
        expect(app.calls.filter((method) => method === 'thread/read')).toHaveLength(1);
        // Recipient-specific evidence must not populate the conservative callers' cache.
        expect(await names.pushTrust('T')).toEqual({
          trusted: false,
          reason: kind === 'large' ? 'too-many-loaded' : 'unreadable-loaded',
        });
      } finally {
        names.stop();
      }
    },
  );

  it.each(['unreadable', 'missing-session', 'non-root'])(
    'still holds a concrete recipient with %s own metadata',
    async (kind) => {
      const app = new FakeApp(),
        names = reader(app);
      if (kind === 'unreadable') app.readErrors.add('T');
      if (kind === 'missing-session') app.threads.T = { ...root('T'), sessionId: null };
      if (kind === 'non-root') app.threads.T = { ...root('T'), parentThreadId: 'parent' };
      try {
        expect(await names.pushTrust('T', true, undefined, true)).toEqual({
          trusted: false,
          reason: kind === 'non-root' ? 'shared-root' : 'unreadable-loaded',
        });
      } finally {
        names.stop();
      }
    },
  );

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
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'unreadable-loaded' });
      app.loaded = Array.from({ length: 257 }, (_, i) => String(i));
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'too-many-loaded' });
    } finally {
      names.stop();
    }
  });
  it.each(['T', 'other'])('identifies a loaded %s whose metadata read errors or omits sessionId', async (id) => {
    const app = new FakeApp(),
      names = reader(app);
    app.loaded = ['T', 'other'];
    app.threads.other = root('other');
    try {
      app.readErrors.add(id);
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'unreadable-loaded' });
      app.readErrors.clear();
      app.threads[id] = { ...root(id), sessionId: null };
      expect(await names.pushTrust('T', true)).toEqual({ trusted: false, reason: 'unreadable-loaded' });
    } finally {
      names.stop();
    }
  });
});
