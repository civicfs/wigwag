/** @jsxImportSource react */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SessionsPane } from '../../src/tui/components.js';
import { until } from '../helpers.js';
import { mount } from './harness.js';

const empty = { sessions: [], feed: [], deliveries: [], throttles: [] };
const link = (n: number) => ({
  a: `/r/a${n}/.git`,
  b: `/r/b${n}/.git`,
  a_label: `/r/a${n}`,
  b_label: `/r/b${n}`,
  created_at: `2026-10-07T00:00:0${n}Z`,
});
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const unlinkCalls = (ui: ReturnType<typeof mount>) => ui.calls.filter((c) => c.method === 'owner.unlink');

describe('Links tab', () => {
  it('renders empty, one and many links with labels and since', async () => {
    const none = mount(empty, () => ({}), 100, 30, { 'owner.links': () => ({ links: [] }) });
    await until(() => none.frame().includes('7 Links'));
    none.stdin.write('7');
    await until(() => none.frame().includes('no links'));
    none.app.unmount();

    const many = mount(empty, () => ({}), 100, 30, { 'owner.links': () => ({ links: [link(1), link(2)] }) });
    await until(() => many.frame().includes('7 Links'));
    many.stdin.write('7');
    await until(() => many.frame().includes('/r/a2'));
    expect(many.frame()).toContain('/r/a1 ↔ /r/b1');
    expect(many.frame()).toContain('since 2026-10-07T00:00:01Z');
    many.app.unmount();
  });

  it('a link feed event adds and removes a row live', async () => {
    const ui = mount(empty, () => ({}), 100, 30, { 'owner.links': () => ({ links: [] }) });
    await until(() => ui.frame().includes('7 Links'));
    ui.stdin.write('7');
    await until(() => ui.frame().includes('no links'));
    ui.client.emit('event', 'feed', { type: 'link', payload: { a: '/q/x/.git', b: '/q/y/.git', active: true } });
    await until(() => ui.frame().includes('/q/x ↔ /q/y'));
    ui.client.emit('event', 'feed', { type: 'link', payload: { a: '/q/x/.git', b: '/q/y/.git', active: false } });
    await until(() => ui.frame().includes('no links'));
    ui.app.unmount();
  });

  it('u twice unlinks the selected link; a single u then Esc does not', async () => {
    const ui = mount(empty, () => ({}), 100, 30, {
      'owner.links': () => ({ links: [link(1), link(2)] }),
      'owner.unlink': () => ({ links: [link(2)] }),
    });
    await until(() => ui.frame().includes('7 Links'));
    ui.stdin.write('7');
    await until(() => ui.frame().includes('/r/a2'));
    ui.stdin.write('u');
    await until(() => ui.frame().includes('press u again to unlink /r/a1 ↔ /r/b1'));
    ui.stdin.write('\u001B');
    await pause();
    expect(ui.frame()).not.toContain('press u again');
    ui.stdin.write('u');
    await until(() => ui.frame().includes('press u again'));
    ui.stdin.write('j');
    await pause();
    expect(ui.frame()).not.toContain('press u again');
    expect(unlinkCalls(ui)).toHaveLength(0);
    ui.stdin.write('u');
    await until(() => ui.frame().includes('press u again to unlink /r/a2 ↔ /r/b2'));
    ui.stdin.write('u');
    await until(() => unlinkCalls(ui).length === 1);
    expect(unlinkCalls(ui)[0].params).toEqual({ a: '/r/a2/.git', b: '/r/b2/.git' });
    await until(() => ui.frame().includes('unlinked /r/a2 ↔ /r/b2'));
    expect(ui.frame()).not.toContain('press u again');
    ui.app.unmount();
  });

  it('l opens a two-field form; Enter moves to B then submits owner.link with both values; Esc cancels', async () => {
    const ui = mount(empty, () => ({}), 100, 30, {
      'owner.links': () => ({ links: [] }),
      'owner.link': () => ({ links: [link(1)] }),
    });
    await until(() => ui.frame().includes('7 Links'));
    ui.stdin.write('7');
    await until(() => ui.frame().includes('no links'));
    ui.stdin.write('l');
    await until(() => ui.frame().includes('Link two workspaces'));
    ui.stdin.write('\u001B');
    await until(() => !ui.frame().includes('Link two workspaces'));
    expect(ui.calls.filter((c) => c.method === 'owner.link')).toHaveLength(0);

    ui.stdin.write('l');
    await until(() => ui.frame().includes('Link two workspaces'));
    ui.stdin.write('alpha-one');
    await pause();
    ui.stdin.write('\r');
    await pause();
    ui.stdin.write('/tmp/some repo');
    await pause();
    expect(ui.frame()).toContain('b: /tmp/some repo');
    ui.stdin.write('\r');
    await until(() => ui.calls.some((c) => c.method === 'owner.link'));
    expect(ui.calls.find((c) => c.method === 'owner.link')?.params).toEqual({ a: 'alpha-one', b: '/tmp/some repo' });
    await until(() => ui.frame().includes('/r/a1 ↔ /r/b1'));
    ui.app.unmount();
  });

  it('submitting with an empty field keeps the form open and says what is missing', async () => {
    const ui = mount(empty, () => ({}), 100, 30, { 'owner.links': () => ({ links: [] }) });
    await until(() => ui.frame().includes('7 Links'));
    ui.stdin.write('l');
    await until(() => ui.frame().includes('Link two workspaces'));
    ui.stdin.write('alpha-one');
    await pause();
    ui.stdin.write('\r');
    await pause();
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('both A and B are required'));
    expect(ui.frame()).toContain('Link two workspaces');
    expect(ui.calls.filter((c) => c.method === 'owner.link')).toHaveLength(0);
    ui.app.unmount();
  });

  it('Enter on a link opens it in the scrollable detail pane (15a)', async () => {
    const ui = mount(empty, () => ({}), 100, 30, { 'owner.links': () => ({ links: [link(1), link(2)] }) });
    await until(() => ui.frame().includes('7 Links'));
    ui.stdin.write('7');
    await until(() => ui.frame().includes('/r/a2'));
    ui.stdin.write('j');
    await pause();
    ui.stdin.write('\r');
    await until(() => ui.frame().includes('Detail'));
    expect(ui.frame()).toContain('/r/a2/.git');
    expect(ui.frame()).toContain('/r/b2/.git');
    expect(ui.frame()).toContain('Esc back to the list');
    ui.stdin.write('\u001B');
    await until(() => !ui.frame().includes('/r/a2/.git'));
    ui.app.unmount();
  });

  const fill = async (ui: ReturnType<typeof mount>, a: string, b: string) => {
    ui.stdin.write('l');
    await until(() => ui.frame().includes('Link two workspaces'));
    ui.stdin.write(a);
    await pause();
    ui.stdin.write('\r');
    await pause();
    ui.stdin.write(b);
    await pause();
    ui.stdin.write('\r');
  };

  it('a relative path or an invalid name keeps the form and the draft open with the reason (15b)', async () => {
    const ui = mount(empty, () => ({}), 100, 30, { 'owner.links': () => ({ links: [] }) });
    await until(() => ui.frame().includes('7 Links'));
    await fill(ui, 'alpha-one', 'some/repo');
    await until(() => ui.frame().includes('must be an absolute path'));
    expect(ui.frame()).toContain('Link two workspaces');
    expect(ui.frame()).toContain('b: some/repo');
    ui.stdin.write('\u001B');
    await until(() => !ui.frame().includes('Link two workspaces'));
    await fill(ui, 'Bad Name', '/tmp/x');
    await until(() => ui.frame().includes('not a session name'));
    expect(ui.frame()).toContain('a: Bad Name');
    expect(ui.calls.filter((c) => c.method === 'owner.link')).toHaveLength(0);
    ui.app.unmount();
  });

  it('a broker error keeps the form open with the error; it closes only on success (15b)', async () => {
    let fail = true;
    const ui = mount(empty, () => ({}), 100, 30, {
      'owner.links': () => ({ links: [] }),
      'owner.link': () => {
        if (fail) throw new Error('not_found: No session named "ghost-one"');
        return { links: [link(1)] };
      },
    });
    await until(() => ui.frame().includes('7 Links'));
    await fill(ui, 'ghost-one', '/tmp/x');
    await until(() => ui.frame().includes('link failed: not_found'));
    expect(ui.frame()).toContain('Link two workspaces');
    expect(ui.frame()).toContain('a: ghost-one');
    fail = false;
    ui.stdin.write('\r');
    await until(() => !ui.frame().includes('Link two workspaces'));
    expect(ui.frame()).toContain('linked ghost-one');
    ui.app.unmount();
  });

  it('the form stays within a small terminal and keeps the edited line visible', async () => {
    const ui = mount(empty, () => ({}), 60, 16, { 'owner.links': () => ({ links: [] }) });
    await until(() => ui.frame().includes('7 Links'));
    ui.stdin.write('l');
    await until(() => ui.frame().includes('Link two workspaces'));
    ui.stdin.write('\r');
    await pause();
    ui.stdin.write('/very/long/path/'.repeat(8));
    await pause();
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(15);
    expect(ui.frame()).toContain('editing b');
    ui.app.unmount();
  });
});

describe('sessions pane workspace label', () => {
  it('shows the workspace label under the name line', () => {
    const f =
      render(
        <SessionsPane
          sessions={[
            {
              id: 'ses-1',
              name: 'alpha-one',
              agent: 'claude',
              state: 'online-idle',
              cwd: '/w/myproject/sub',
              workspace: '/w/myproject/.git',
              workspace_label: '/w/myproject',
              bound: true,
              unread: 0,
              last_seen_at: '2026-10-07T00:57:00Z',
            },
          ]}
          selected={0}
          focused
        />,
      ).lastFrame() ?? '';
    const lines = f.split('\n');
    const i = lines.findIndex((l) => l.includes('alpha-one'));
    expect(lines[i + 1]).toContain('/w/myproject');
  });
});
