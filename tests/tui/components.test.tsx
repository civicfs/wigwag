/** @jsxImportSource react */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../src/store/messages.js';
import { DeliveriesPane, FeedPane, SessionsPane } from '../../src/tui/components.js';

const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
const msg: MessageRow = {
  id: 'msg-1',
  from_name: 'codex-merger',
  from_workspace: null,
  to_target: 'claude-main',
  kind: 'message',
  priority: 'urgent',
  subject: 'long one',
  body: words.join(' '),
  attachments: [],
  reply_to: null,
  request_id: null,
  expires_at: null,
  stream: null,
  created_at: '2026-10-07T00:00:00Z',
};

describe('tui components', () => {
  it('sessions pane shows name, state and unread for empty / one / many', () => {
    expect(render(<SessionsPane sessions={[]} selected={0} focused />).lastFrame()).toMatch(/no sessions yet/);
    const many = ['alpha-one', 'beta-one', 'gamma-one'].map((name, i) => ({
      id: `ses-${i}`,
      name,
      agent: 'codex' as const,
      state: i === 2 ? ('offline' as const) : ('online-busy' as const),
      cwd: '/',
      workspace: '/',
      workspace_label: '/',
      bound: true,
      unread: i,
      last_seen_at: '',
    }));
    const f = render(<SessionsPane sessions={many} selected={1} focused />).lastFrame() ?? '';
    for (const s of many) expect(f).toContain(s.name);
    expect(f).toMatch(/busy/);
    expect(f).toMatch(/offline/);
  });
  it('renders terminal commands as visible text, including in details', async () => {
    const { DetailPane } = await import('../../src/tui/components.js');
    const unsafe = 'review\u001b]52;c;YQ==\u0007';
    const feed =
      render(
        <FeedPane messages={[{ ...msg, subject: unsafe, body: unsafe }]} selected={0} focused filter={null} />,
      ).lastFrame() ?? '';
    const detail = render(<DetailPane detail={{ subject: unsafe }} width={80} />).lastFrame() ?? '';
    for (const f of [feed, detail]) {
      expect(f).toContain('review\\u001b]52;c;YQ==\\u0007');
      expect(f).not.toContain('\u0007');
      expect(f).not.toContain('\u001b]52;');
    }
  });

  it('feed shows the full body wrapped, never truncated', () => {
    const f = render(<FeedPane messages={[msg]} selected={0} focused filter={null} />).lastFrame() ?? '';
    for (const w of words) expect(f).toContain(w);
    expect(f).not.toMatch(/…|\.\.\./);
  });
  it('shows assigned roles and the worker’s lead without hiding binding warnings', () => {
    const base = {
      agent: 'codex' as const,
      state: 'online-idle' as const,
      cwd: '/',
      workspace: '/',
      workspace_label: 'demo',
      bound: false,
      unread: 0,
      last_seen_at: '',
    };
    const f =
      render(
        <SessionsPane
          sessions={[
            { ...base, id: 'ses-lead', name: 'review-lead', role: 'orchestrator' },
            {
              ...base,
              id: 'ses-worker',
              name: 'test-worker',
              role: 'worker',
              orchestration: {
                assignment_id: 'task-example',
                orchestrator_session_id: 'ses-lead',
                orchestrator_name: 'review-lead',
              },
            },
          ]}
          selected={0}
          focused
          width={50}
        />,
      ).lastFrame() ?? '';
    expect(f).toContain('codex · lead · unbound');
    expect(f).toContain('worker ← review-lead');
    expect(f).toContain('codex · worker');
  });
  it('deliveries pane lists throttles first, then stuck deliveries with their error', () => {
    const f =
      render(
        <DeliveriesPane
          throttles={[{ from_name: 'chatty-bot', to_name: 'claude-main', created_at: '' }]}
          deliveries={[
            {
              message_id: 'msg-9',
              recipient: 'codex-merger',
              state: 'stuck',
              hold_reason: null,
              attempts: 8,
              last_error: 'codex queue failed: boom',
              transport: 'codex-queue',
              next_attempt_at: null,
              updated_at: '',
              subject: 'x',
              from_name: 'claude-main',
              priority: 'normal',
            },
          ]}
          selected={0}
          focused
        />,
      ).lastFrame() ?? '';
    expect(f.indexOf('chatty-bot')).toBeLessThan(f.indexOf('msg-9'));
    expect(f).toContain('codex queue failed: boom');
    expect(f).toMatch(/press r to release/);
  });
});
