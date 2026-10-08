/** @jsxImportSource react */
import { describe, expect, it } from 'vitest';
import { windowOf, wrapCount } from '../../src/tui/layout.js';
import { until } from '../helpers.js';
import { DOWN, mount, msg, tick } from './harness.js';

describe('layout helpers', () => {
  it('counts wrapped rows like Ink does for plain text', () => {
    expect(wrapCount('', 10)).toBe(0);
    expect(wrapCount('one two', 10)).toBe(1);
    expect(wrapCount('one two three', 8)).toBe(2);
    expect(wrapCount('a'.repeat(25), 10)).toBe(3);
    expect(wrapCount('a\nb', 10)).toBe(2);
  });
  it('windows around the selection', () => {
    const h = [1, 1, 1, 1, 1, 1];
    expect(windowOf(h, 0, 3)).toEqual({ start: 0, end: 3 });
    expect(windowOf(h, 5, 3)).toEqual({ start: 3, end: 6 });
    expect(windowOf([5, 1], 0, 3)).toEqual({ start: 0, end: 1 });
  });
});

describe('TUI sizing', () => {
  const snapshot = {
    sessions: [],
    feed: Array.from({ length: 60 }, (_, i) => msg(i)),
    deliveries: [],
    throttles: [],
  };

  it('a 60-item feed at 20 rows keeps chrome visible and the selection in view while scrolling', async () => {
    const ui = mount(snapshot, () => ({}), 100, 20);
    await until(() => ui.frame().includes('subject-0'));
    const first = ui.frame();
    expect(first).toContain('1 Feed');
    expect(first).toMatch(/items 1–\d+ of 60 \(↑\/↓ to scroll\)/);
    expect(first.split('\n').length).toBeLessThanOrEqual(19);
    expect(first).toContain('Enter open');
    for (let i = 0; i < 30; i++) {
      ui.stdin.write(DOWN);
      await tick();
    }
    await until(() => ui.frame().includes('subject-30'));
    const later = ui.frame();
    expect(later).toContain('1 Feed');
    expect(later).toMatch(/items \d+–\d+ of 60/);
    expect(later).toContain('Enter open');
    expect(later.split('\n').length).toBeLessThanOrEqual(19);
    ui.app.unmount();
  });

  it('an item taller than the pane is cut at the pane edge with a visible Enter affordance', async () => {
    const big = { ...msg(1), body: Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ') };
    const ui = mount({ sessions: [], feed: [big, msg(2)], deliveries: [], throttles: [] }, () => ({}), 80, 20);
    await until(() => ui.frame().includes('subject-1'));
    expect(ui.frame()).toContain('Enter:');
    expect(ui.frame()).toContain('full text');
    expect(ui.frame()).toContain('items 1–1 of 2');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(19);
    ui.app.unmount();
  });

  it('below 120 columns the detail replaces the feed; Esc returns', async () => {
    const ui = mount(snapshot, (id) => ({ kind: 'message', message: { id, subject: 'detail-body-marker' } }), 80, 30);
    await until(() => ui.frame().includes('subject-0'));
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('detail-body-marker'));
    expect(ui.frame()).not.toContain('subject-1');
    expect(ui.frame()).not.toContain('Sessions');
    ui.stdin.write('\u001B');
    await until(() => ui.frame().includes('subject-1'));
    ui.app.unmount();
  });

  it('at 120 columns or more the detail sits beside the feed', async () => {
    const ui = mount(snapshot, (id) => ({ kind: 'message', message: { id, subject: 'detail-body-marker' } }), 140, 30);
    await until(() => ui.frame().includes('subject-0'));
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('detail-body-marker'));
    expect(ui.frame()).toContain('subject-1');
    ui.app.unmount();
  });

  it('a stuck delivery shows its first error line with an affordance; Enter shows the whole error', async () => {
    const err = Array.from({ length: 20 }, (_, i) => `error line ${i + 1}`).join('\n');
    const delivery = {
      message_id: 'msg-9',
      recipient: 'codex-merger',
      state: 'stuck',
      hold_reason: null,
      attempts: 8,
      last_error: err,
      transport: 'codex-queue',
      next_attempt_at: null,
      updated_at: '',
      subject: 'x',
      from_name: 'claude-main',
      priority: 'normal',
    };
    const ui = mount(
      { sessions: [], feed: [msg(9)], deliveries: [delivery], throttles: [] },
      () => ({ kind: 'message', events: [{ recipient: 'codex-merger', to_state: 'stuck' }] }),
      80,
      60,
    );
    await until(() => ui.frame().includes('subject-9'));
    ui.stdin.write('2');
    await until(() => ui.frame().includes('msg-9'));
    expect(ui.frame()).toContain('error line 1');
    expect(ui.frame()).toContain('Enter: full error');
    expect(ui.frame()).not.toContain('error line 2');
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('error line 20'));
    expect(ui.frame()).toContain('error line 2');
    ui.app.unmount();
  });
});
