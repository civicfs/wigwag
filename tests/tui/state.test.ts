import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../src/store/messages.js';
import { EMPTY, reduce } from '../../src/tui/state.js';

const m = (id: string): MessageRow => ({
  id,
  from_name: 'a-a',
  from_workspace: null,
  to_target: 'b-b',
  kind: 'message',
  priority: 'normal',
  subject: `s-${id}`,
  body: 'b',
  attachments: [],
  reply_to: null,
  request_id: null,
  expires_at: null,
  stream: null,
  created_at: '',
});
const session = {
  id: 'ses-1',
  name: 'b-b',
  agent: 'claude' as const,
  state: 'online-idle' as const,
  cwd: '/',
  workspace: '/',
  workspace_label: '/',
  bound: true,
  unread: 0,
  last_seen_at: '',
};

describe('tui reducer', () => {
  it('prepends new messages once', () => {
    let s = reduce(EMPTY, { type: 'feed', data: { type: 'message', payload: m('msg-1') } });
    s = reduce(s, { type: 'feed', data: { type: 'message', payload: m('msg-2') } });
    s = reduce(s, { type: 'feed', data: { type: 'message', payload: m('msg-2') } });
    expect(s.feed.map((x) => x.id)).toEqual(['msg-2', 'msg-1']);
  });
  it('tracks open deliveries with subject and updates recipient unread', () => {
    let s = reduce({ ...EMPTY, sessions: [session] }, { type: 'feed', data: { type: 'message', payload: m('msg-1') } });
    const d = {
      message_id: 'msg-1',
      recipient: 'b-b',
      forward_to: null,
      recipient_session_id: null,
      state: 'held',
      hold_reason: 'low',
      attempts: 0,
      last_error: null,
      transport: null,
      next_attempt_at: null,
      updated_at: '',
    };
    s = reduce(s, { type: 'feed', data: { type: 'delivery', payload: { ...d, recipient_unread: 1 } } });
    expect(s.deliveries).toEqual([expect.objectContaining({ message_id: 'msg-1', subject: 's-msg-1', state: 'held' })]);
    expect(s.sessions[0].unread).toBe(1);
    s = reduce(s, { type: 'feed', data: { type: 'delivery', payload: { ...d, state: 'read', recipient_unread: 0 } } });
    expect(s.deliveries).toEqual([]);
    expect(s.sessions[0].unread).toBe(0);
  });
  it('upserts sessions (live first) and toggles throttles', () => {
    let s = reduce(EMPTY, { type: 'feed', data: { type: 'session', payload: { ...session, state: 'offline' } } });
    s = reduce(s, { type: 'feed', data: { type: 'session', payload: { ...session, id: 'ses-2', name: 'a-a' } } });
    expect(s.sessions.map((x) => x.name)).toEqual(['a-a', 'b-b']);
    s = reduce(s, { type: 'feed', data: { type: 'throttle', payload: { from: 'a-a', to: 'b-b', active: true } } });
    expect(s.throttles).toHaveLength(1);
    s = reduce(s, { type: 'feed', data: { type: 'throttle', payload: { from: 'a-a', to: 'b-b', active: false } } });
    expect(s.throttles).toHaveLength(0);
  });
  it("keeps a delivery's message metadata when a later update arrives for a message outside the feed", () => {
    const d = {
      message_id: 'msg-old',
      recipient: 'b-b',
      forward_to: null,
      recipient_session_id: null,
      state: 'held' as const,
      hold_reason: 'low' as const,
      attempts: 0,
      last_error: null,
      transport: null,
      next_attempt_at: null,
      updated_at: '',
    };
    const first = {
      ...EMPTY,
      deliveries: [{ ...d, subject: 'older subject', from_name: 'a-a', priority: 'urgent' as const }],
    };
    const s = reduce(first, {
      type: 'feed',
      data: { type: 'delivery', payload: { ...d, state: 'failed', attempts: 1 } },
    });
    expect(s.deliveries).toEqual([
      expect.objectContaining({ state: 'failed', subject: 'older subject', from_name: 'a-a', priority: 'urgent' }),
    ]);
  });
  it('adds and removes links from feed events, once per pair, and takes a loaded list', () => {
    const ev = (active: boolean) => ({
      type: 'feed' as const,
      data: { type: 'link' as const, payload: { a: '/r/a/.git', b: '/r/b/.git', active } },
    });
    let s = reduce(EMPTY, ev(true));
    expect(s.links).toEqual([
      expect.objectContaining({ a: '/r/a/.git', b: '/r/b/.git', a_label: '/r/a', b_label: '/r/b' }),
    ]);
    s = reduce(s, ev(true));
    expect(s.links).toHaveLength(1);
    s = reduce(s, ev(false));
    expect(s.links).toEqual([]);
    const loaded = [{ a: '/x', b: '/y', a_label: '/x', b_label: '/y', created_at: 't' }];
    expect(reduce(EMPTY, { type: 'links', data: loaded }).links).toEqual(loaded);
    const snap = reduce(
      { ...EMPTY, links: loaded },
      { type: 'snapshot', data: { sessions: [], feed: [], deliveries: [], throttles: [] } },
    );
    expect(snap.links).toEqual(loaded);
  });
});
