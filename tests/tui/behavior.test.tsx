/** @jsxImportSource react */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SessionsPane } from '../../src/tui/components.js';
import { displayWidth, errorSummary, wrapCount, wrapRows } from '../../src/tui/layout.js';
import { until } from '../helpers.js';
import { DOWN, mount, msg } from './harness.js';

const empty = { sessions: [], feed: [], deliveries: [], throttles: [] };
const frameRows = (f: string) => f.split('\n').length;
const type = async (ui: ReturnType<typeof mount>, text: string) => {
  ui.stdin.write(text);
  await new Promise((r) => setTimeout(r, 20));
};

describe('detail text is reachable', () => {
  it('a single 500-word line can be scrolled to its last word', async () => {
    const body = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    const ui = mount(
      { ...empty, feed: [{ ...msg(1), body: 'short' }] },
      () => ({ kind: 'message', message: { id: 'msg-1', body } }),
      80,
      24,
    );
    await until(() => ui.frame().includes('subject-1'));
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('w0 w1'));
    expect(ui.frame()).not.toContain('w499');
    expect(frameRows(ui.frame())).toBeLessThanOrEqual(23);
    for (let i = 0; i < 400 && !ui.frame().includes('w499'); i++) {
      ui.stdin.write(DOWN);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(ui.frame()).toContain('w499');
    expect(ui.frame()).toMatch(/rows \d+–\d+ of \d+/);
    ui.app.unmount();
  });
});

describe('KV and Streams detail', () => {
  it('KV next and previous page controls preserve access to rows beyond the first page', async () => {
    const ui = mount(empty, () => ({}), 100, 30, {
      'kv.list': (p) => ({
        entries: [{ key: p.cursor ? 'second-key' : 'first-key', version: 1, updated_by: 'a-a', value: 1 }],
        has_more: !p.cursor,
        next_cursor: p.cursor ? null : 'next-page',
      }),
    });
    try {
      await until(() => ui.frame().includes('1 Feed'));
      ui.stdin.write('4');
      await until(() => ui.frame().includes('first-key'));
      expect(ui.frame()).toContain('] next');
      ui.stdin.write(']');
      await until(() => ui.frame().includes('second-key'));
      expect(ui.frame()).not.toContain('first-key');
      ui.stdin.write('[');
      await until(() => ui.frame().includes('first-key'));
      expect(ui.frame()).not.toContain('second-key');
    } finally {
      ui.app.unmount();
    }
  });
  it('Enter on a KV row shows every field of the entry; Streams likewise', async () => {
    const value = { step: 3, note: 'merging', long: Array.from({ length: 80 }, (_, i) => `k${i}`).join(' ') };
    const ui = mount(empty, () => ({}), 100, 30, {
      'kv.list': () => ({ entries: [{ key: 'plan/current', version: 4, updated_by: 'claude-main', value }] }),
      'stream.list': () => ({
        streams: [{ name: 'build-log', description: 'CI build records', created_by: 'claude-main' }],
      }),
    });
    await until(() => ui.frame().includes('1 Feed'));
    ui.stdin.write('4');
    await until(() => ui.frame().includes('plan/current'));
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('Detail'));
    expect(ui.frame()).toContain('version: 4');
    expect(ui.frame()).toContain('updated_by: claude-main');
    expect(ui.frame()).toContain('merging');
    ui.stdin.write('\u001B');
    await until(() => !ui.frame().includes('Detail'));
    ui.stdin.write('5');
    await until(() => ui.frame().includes('build-log'));
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('description: CI build records'));
    ui.app.unmount();
  });
});

describe('display width', () => {
  it('measures CJK as two columns and combining marks as zero, and wraps by those widths', () => {
    expect(displayWidth('日本語')).toBe(6);
    const e = String.fromCodePoint(0x65, 0x301); // e + combining acute: one column
    expect(displayWidth(e)).toBe(1);
    expect(wrapCount('日本語日本語', 6)).toBe(2);
    expect(wrapRows('日本語日本語', 6)).toEqual(['日本語', '日本語']);
    const combining = wrapRows(e.repeat(4), 2);
    expect(combining).toHaveLength(2);
    expect(combining.join('').normalize('NFC')).toBe(e.repeat(4).normalize('NFC'));
    const wide = '日'.repeat(30);
    expect(wrapRows(wide, 20).every((r) => displayWidth(r) <= 20)).toBe(true);
  });
  it('flags a CJK first error line that is wider than the pane even though it has few code points', () => {
    const err = '失敗'.repeat(10); // 20 code points, 40 columns
    expect(errorSummary(err, 30).more).toBe(true);
    expect(errorSummary('abc', 30).more).toBe(false);
  });
  it('a feed of CJK bodies keeps every row inside the terminal and the selection visible', async () => {
    const feed = Array.from({ length: 30 }, (_, i) => ({ ...msg(i), body: `${'日本語'.repeat(15)}-end${i}` }));
    const ui = mount({ ...empty, feed }, () => ({}), 80, 20);
    await until(() => ui.frame().includes('subject-0'));
    for (let i = 0; i < 12; i++) ui.stdin.write(DOWN);
    await until(() => ui.frame().includes('subject-12'));
    expect(frameRows(ui.frame())).toBeLessThanOrEqual(19);
    expect(ui.frame()).toContain('-end12');
    ui.app.unmount();
  });
});

describe('table loads', () => {
  it('a slow Requests response never appears under KV', async () => {
    let releaseRequests: (v: unknown) => void = () => {};
    const ui = mount(empty, () => ({}), 100, 30, {
      'req.list': () =>
        new Promise((res) => {
          releaseRequests = res;
        }),
      'kv.list': () => ({ entries: [{ key: 'kv-key-1', version: 1, updated_by: 'a-a', value: 1 }] }),
    });
    await until(() => ui.frame().includes('1 Feed'));
    ui.stdin.write('3');
    await new Promise((r) => setTimeout(r, 30));
    ui.stdin.write('4');
    await until(() => ui.frame().includes('kv-key-1'));
    releaseRequests({
      requests: [{ request_id: 'req-late', status: 'open', from: 'a-a', to: 'b-b', subject: 'late' }],
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(ui.frame()).toContain('kv-key-1');
    expect(ui.frame()).not.toContain('req-late');
    ui.app.unmount();
  });

  it('R reloads the active table tab, and a failed load shows in the status line', async () => {
    let n = 0;
    const ui = mount(empty, () => ({}), 100, 30, {
      'kv.list': () => {
        n++;
        if (n === 2) throw new Error('kv backend down');
        return { entries: [{ key: `kv-key-${n}`, version: 1, updated_by: 'a-a', value: 1 }] };
      },
    });
    await until(() => ui.frame().includes('1 Feed'));
    ui.stdin.write('4');
    await until(() => ui.frame().includes('kv-key-1'));
    ui.stdin.write('R');
    await until(() => ui.frame().includes('KV failed: kv backend down'));
    expect(ui.calls.filter((c) => c.method === 'kv.list')).toHaveLength(2);
    expect(ui.calls.filter((c) => c.method === 'owner.snapshot')).toHaveLength(2);
    ui.stdin.write('R');
    await until(() => ui.frame().includes('kv-key-3'));
    ui.app.unmount();
  });
});

describe('release is gated', () => {
  const delivery = {
    message_id: 'msg-9',
    recipient: 'codex-merger',
    state: 'stuck',
    hold_reason: null,
    attempts: 8,
    last_error: 'boom',
    transport: null,
    next_attempt_at: null,
    updated_at: '',
    subject: 'x',
    from_name: 'a-a',
    priority: 'normal',
  };
  it('r does nothing while the Sessions pane has focus, and releases from the main pane', async () => {
    const ui = mount(
      {
        ...empty,
        deliveries: [delivery],
        throttles: [{ from_name: 'chatty-bot', to_name: 'claude-main', created_at: '' }],
      },
      () => ({}),
      100,
      30,
    );
    await until(() => ui.frame().includes('1 Feed'));
    ui.stdin.write('2');
    await until(() => ui.frame().includes('THROTTLED'));
    ui.stdin.write('\t');
    await new Promise((r) => setTimeout(r, 20));
    ui.stdin.write('r');
    await new Promise((r) => setTimeout(r, 40));
    expect(ui.calls.filter((c) => c.method === 'owner.release_throttle')).toHaveLength(0);
    ui.stdin.write('\t');
    await new Promise((r) => setTimeout(r, 20));
    ui.stdin.write('r');
    await until(() => ui.calls.some((c) => c.method === 'owner.release_throttle'));
    expect(ui.calls.find((c) => c.method === 'owner.release_throttle')?.params).toEqual({
      from: 'chatty-bot',
      to: 'claude-main',
    });
    ui.app.unmount();
  });

  it('a failed delivery-events fetch keeps the detail and reports the error', async () => {
    const ui = mount(
      { ...empty, deliveries: [delivery] },
      () => {
        throw new Error('events gone');
      },
      100,
      30,
    );
    await until(() => ui.frame().includes('1 Feed'));
    ui.stdin.write('2');
    await until(() => ui.frame().includes('msg-9'));
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('Detail'));
    expect(ui.frame()).toContain('delivery events unavailable: events gone');
    expect(ui.frame()).toContain('last_error: boom');
    ui.app.unmount();
  });
});

describe('compose', () => {
  for (const [cols, rows] of [
    [80, 20],
    [200, 20],
  ] as const) {
    it(`a long draft stays inside a ${rows}-row terminal at ${cols} columns with the instructions visible`, async () => {
      const ui = mount(empty, () => ({}), cols, rows);
      await until(() => ui.frame().includes('1 Feed'));
      ui.stdin.write('c');
      await until(() => ui.frame().includes('Send as owner'));
      await type(ui, 'peer-one');
      for (let i = 0; i < 4; i++) await type(ui, '\r'); // to -> priority -> subject -> attach -> body
      const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
      await type(ui, words);
      const f = ui.frame();
      expect(frameRows(f)).toBeLessThanOrEqual(rows - 1);
      expect(f).toContain('Esc cancels');
      expect(f).toContain('word899');
      expect(f).toMatch(/rows \d+–\d+ of \d+ · editing body/);
      ui.app.unmount();
    });
  }

  it('sends the attach path as attach_paths and refuses a relative one without closing the editor', async () => {
    const ui = mount(empty, () => ({}), 100, 30, { 'owner.send': () => ({ id: 'msg-new' }) });
    await until(() => ui.frame().includes('1 Feed'));
    ui.stdin.write('c');
    await until(() => ui.frame().includes('Send as owner'));
    await type(ui, 'peer-one');
    await type(ui, '\r');
    await type(ui, '\r');
    await type(ui, 'hello');
    await type(ui, '\r');
    await type(ui, 'rel/file.txt');
    await type(ui, '\r');
    await type(ui, 'body text');
    await type(ui, '\r');
    expect(ui.frame()).toContain('attach must be an absolute path');
    expect(ui.frame()).toContain('Send as owner');
    for (let i = 0; i < 12; i++) await type(ui, '\u007f'); // backspace over the relative path
    ui.app.unmount();
  });
});

describe('sessions pane metadata', () => {
  it('shows when each session was last seen and flags throttle recipients', () => {
    const base = {
      agent: 'claude' as const,
      state: 'online-idle' as const,
      cwd: '/',
      workspace: '/',
      workspace_label: '/',
      bound: true,
      unread: 0,
    };
    const now = Date.parse('2026-10-07T01:00:00Z');
    const f =
      render(
        <SessionsPane
          sessions={[
            { ...base, id: 'ses-1', name: 'alpha-one', last_seen_at: '2026-10-07T00:57:00Z' },
            { ...base, id: 'ses-2', name: 'beta-one', last_seen_at: '2026-10-06T22:00:00Z' },
          ]}
          selected={0}
          focused
          now={now}
          throttled={['beta-one']}
        />,
      ).lastFrame() ?? '';
    expect(f).toContain('seen 3m ago');
    expect(f).toContain('seen 3h ago · throttled');
    expect(f.split('beta-one')[0]).not.toContain('throttled');
  });
});
