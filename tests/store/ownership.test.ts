import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/store/db.js';
import { deliveriesFor, insertMessage } from '../../src/store/messages.js';
import { messageAddressedTo, messageSender, messageSentBy } from '../../src/store/ownership.js';
import { adoptCanonical } from '../../src/store/recovery.js';
import { bindAgentSession, claimName, createSession, setState } from '../../src/store/sessions.js';
import { tmpHome } from '../helpers.js';

let db: Db;
beforeEach(() => {
  db = openDb(join(tmpHome(), 'state.db'));
});
afterEach(() => db.close());
const session = (name: string) => {
  const s = createSession(db, { agent: 'claude', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: null });
  claimName(db, s.id, name, 'custom');
  return s;
};

it('follows proven canonical adoption for both participants without granting a reused name any ownership', () => {
  const sender = session('fresh-sender');
  const worker = session('fresh-worker');
  const canonSender = session('canonical-sender');
  const canonWorker = session('canonical-worker');
  bindAgentSession(db, canonSender.id, 'sender-native');
  bindAgentSession(db, canonWorker.id, 'worker-native');
  setState(db, canonSender.id, 'offline');
  setState(db, canonWorker.id, 'offline');
  const m = insertMessage(
    db,
    {
      from_name: 'fresh-sender',
      from_workspace: '/w',
      to_target: 'fresh-worker',
      kind: 'request',
      priority: 'low',
      subject: 'private',
      body: 'question',
      attachments: [],
      reply_to: null,
      request_id: 'req-canonical',
      expires_at: null,
      stream: null,
    },
    ['fresh-worker'],
  );
  for (const [provisional, canonical, native] of [
    [sender, canonSender, 'sender-native'],
    [worker, canonWorker, 'worker-native'],
  ] as const)
    expect(
      adoptCanonical(db, {
        provisionalId: provisional.id,
        canonicalId: canonical.id,
        native,
        state: 'online-idle',
        evidence: { fixture: 'trusted recovery' },
      }),
    ).toMatchObject({ ok: true });
  const replacementSender = session('fresh-sender');
  const replacementWorker = session('fresh-worker');
  expect(messageSender(db, m.id)?.id).toBe(canonSender.id);
  expect(messageSentBy(db, m, canonSender.id)).toBe(true);
  expect(messageSentBy(db, m, replacementSender.id)).toBe(false);
  expect(messageAddressedTo(db, m.id, canonWorker.id)).toBe(true);
  expect(messageAddressedTo(db, m.id, replacementWorker.id)).toBe(false);
  expect(deliveriesFor(db, 'canonical-worker', ['pending']).map((d) => d.message_id)).toEqual([m.id]);
  expect(deliveriesFor(db, 'fresh-worker', ['pending'])).toEqual([]);
});
