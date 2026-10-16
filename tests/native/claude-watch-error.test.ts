import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeTitleWatcher } from '../../src/native/claude-watch.js';
import { bindAgentSession, createSession, getSession, setNativeRef } from '../../src/store/sessions.js';
import { startTestBroker } from '../helpers.js';

const { fakeWatch } = vi.hoisted(() => ({ fakeWatch: vi.fn() }));
vi.mock('node:fs', async () => ({ ...(await vi.importActual('node:fs')), watch: fakeWatch }));
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of cleanup.splice(0).reverse()) await f();
  fakeWatch.mockReset();
});

it('a stale watcher error leaves its replacement watching for native title changes', async () => {
  const handles: Array<EventEmitter & { close(): void; change(): void }> = [];
  fakeWatch.mockImplementation((_dir, _opts, callback) => {
    let active = true;
    const handle = Object.assign(new EventEmitter(), {
      close() {
        active = false;
      },
      change() {
        if (active) callback();
      },
    });
    handles.push(handle);
    return handle;
  });
  const { broker } = await startTestBroker();
  cleanup.push(() => broker.stop());
  const dir = mkdtempSync(join(tmpdir(), 'ww-watch-error-'));
  const sid = '5d7c100a-7597-483c-bc8c-88a81970184d';
  const s = createSession(broker.db, { agent: 'claude', cwd: dir, workspace: dir, pid_chain: [], mcp_ppid: null });
  bindAgentSession(broker.db, s.id, sid);
  setNativeRef(broker.db, s.id, join(dir, `${sid}.jsonl`));
  vi.useFakeTimers();
  const watcher = new ClaudeTitleWatcher(broker, 3_600_000);
  cleanup.push(() => watcher.stop());
  watcher.reconcile();
  mkdirSync(join(dir, sid));
  watcher.reconcile();
  expect(handles).toHaveLength(2);
  handles[0].emit('error', new Error('late old-watcher error'));
  writeFileSync(join(dir, sid, 'custom-title.json'), JSON.stringify({ customTitle: 'Replacement still watches' }));
  handles[1].change();
  await vi.advanceTimersByTimeAsync(200);
  expect(getSession(broker.db, s.id)?.name).toBe('replacement-still-watches');
});
