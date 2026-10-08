import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/store/db.js';
import {
  deliveriesFor,
  deliveriesOfMessage,
  feed,
  getMessage,
  insertMessage,
  transition,
} from '../../src/store/messages.js';
import { tmpHome } from '../helpers.js';

let db: Db;
beforeEach(() => {
  db = openDb(join(tmpHome(), 'state.db'));
});
const base = {
  from_name: 'claude',
  to_target: 'codex-merger',
  kind: 'message' as const,
  priority: 'normal' as const,
  subject: 's',
  body: 'b',
  attachments: [],
  reply_to: null,
  request_id: null,
  expires_at: null,
  stream: null,
};

describe('messages', () => {
  it('inserts a message with one pending delivery per recipient', () => {
    const m = insertMessage(db, base, ['codex-merger', 'codex-verify']);
    expect(m.id).toMatch(/^msg-/);
    expect(getMessage(db, m.id)?.body).toBe('b');
    expect(deliveriesOfMessage(db, m.id).map((d) => [d.recipient, d.state])).toEqual([
      ['codex-merger', 'pending'],
      ['codex-verify', 'pending'],
    ]);
  });
  it('is append-only: UPDATE and DELETE on messages are rejected', () => {
    const m = insertMessage(db, base, ['x-y']);
    expect(() => db.prepare('UPDATE messages SET body = ? WHERE id = ?').run('z', m.id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM messages WHERE id = ?').run(m.id)).toThrow(/append-only/);
  });
  it('rejects INSERT OR REPLACE over an existing message id', () => {
    const m = insertMessage(db, base, ['x-y']);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO messages (id, from_name, to_target, kind, priority, subject, body, attachments, created_at)
           VALUES (?, 'a', 'b', 'message', 'normal', 's', 'hacked', '[]', 't')`,
        )
        .run(m.id),
    ).toThrow(/append-only/);
    expect(getMessage(db, m.id)?.body).toBe('b');
  });
  it('rejects INSERT OR REPLACE over an existing delivery_events rowid', () => {
    const m = insertMessage(db, base, ['x-y']);
    const ev = db.prepare('SELECT rowid AS r FROM delivery_events WHERE message_id = ?').get(m.id) as { r: number };
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO delivery_events (rowid, message_id, recipient, from_state, to_state, detail, at)
           VALUES (?, ?, 'x-y', NULL, 'read', NULL, 't')`,
        )
        .run(ev.r, m.id),
    ).toThrow(/append-only/);
  });
  it('records every transition and treats read as terminal', () => {
    const m = insertMessage(db, base, ['codex-merger']);
    transition(db, m.id, 'codex-merger', 'held', { hold_reason: 'low' });
    transition(db, m.id, 'codex-merger', 'read');
    const after = transition(db, m.id, 'codex-merger', 'pushed');
    expect(after.state).toBe('read');
    const events = db
      .prepare('SELECT from_state, to_state FROM delivery_events WHERE message_id = ? ORDER BY rowid')
      .all(m.id);
    expect(events).toEqual([
      { from_state: null, to_state: 'pending' },
      { from_state: 'pending', to_state: 'held' },
      { from_state: 'held', to_state: 'read' },
    ]);
  });
  it('lists deliveries for a recipient by state with the message joined', () => {
    const m = insertMessage(db, base, ['codex-merger']);
    transition(db, m.id, 'codex-merger', 'held', { hold_reason: 'offline' });
    const rows = deliveriesFor(db, 'codex-merger', ['held']);
    expect(rows).toHaveLength(1);
    expect(rows[0].message.subject).toBe('s');
    expect(rows[0].hold_reason).toBe('offline');
  });
  it('feed is newest-first and filters by participant name', () => {
    const a = insertMessage(db, base, ['codex-merger']);
    const b = insertMessage(db, { ...base, from_name: 'owner', to_target: 'all' }, ['codex-merger']);
    insertMessage(db, { ...base, from_name: 'x-a', to_target: 'x-b' }, ['x-b']);
    expect(feed(db, { limit: 10, name: 'codex-merger' }).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(feed(db, { limit: 10, before: b.id }).map((m) => m.id)).toEqual([a.id]);
  });
});
