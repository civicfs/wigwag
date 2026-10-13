import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { activeThrottles, addThrottle } from '../../src/store/subs.js';
import { mcpClient, startTestBroker, until } from '../helpers.js';

let broker: Broker;
let home: string;
const closers: Array<() => void> = [];
beforeEach(async () => {
  ({ broker, home } = await startTestBroker());
});
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await broker.stop();
});
async function join(name: string, cwd = '/w/myproject') {
  const c = await mcpClient(home, { requested_name: name, cwd });
  closers.push(() => c.client.close());
  return c;
}
function message(body: string, from = 'owner', priority: 'low' | 'normal' | 'urgent' = 'low') {
  return insertMessage(
    broker.db,
    {
      from_name: from,
      from_workspace: from === 'owner' ? null : '/w/myproject',
      to_target: 'recipient-one',
      kind: 'message',
      priority,
      subject: 'Inbox regression',
      body,
      attachments: [],
      reply_to: null,
      request_id: null,
      expires_at: null,
      stream: null,
    },
    ['recipient-one'],
  );
}
describe('bounded inbox and delivery recovery', () => {
  it('bounds the actual formatted response and does not mark omitted messages read', async () => {
    const r = await join('recipient-one');
    const ids = Array.from({ length: 46 }, () => message('body '.repeat(200)).id);
    const page = await r.client.call<any>('msg.inbox', { limit: 500 });
    expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(12000);
    expect(page.has_more).toBe(true);
    expect(page.messages.length).toBeGreaterThan(0);
    const read = ids.filter((id) => deliveriesOfMessage(broker.db, id)[0].state === 'read');
    expect(read.sort()).toEqual(page.messages.map((x: any) => x.message.id).sort());
    const all = new Set(read);
    for (let n = 0; n < 46; n++) {
      const next = await r.client.call<any>('msg.inbox', {});
      for (const row of next.messages) all.add(row.message.id);
      if (!next.has_more) break;
    }
    expect(all.size).toBe(46);
  });
  it('pages read history with a stable cursor instead of repeating the newest messages', async () => {
    const r = await join('recipient-one');
    const ids = Array.from({ length: 15 }, () => message('small').id);
    const seen: string[] = [];
    let before: string | undefined;
    for (let n = 0; n < 10; n++) {
      const page = await r.client.call<any>('msg.inbox', { include_read: true, limit: 3, before });
      seen.push(...page.messages.map((x: any) => x.message.id));
      if (!page.has_more) break;
      before = page.next_before;
    }
    expect(new Set(seen).size).toBe(15);
    expect(seen.sort()).toEqual(ids.sort());
  });
  it('uses an explicit body reference for an oversized message and makes its complete text readable in bounded chunks', async () => {
    const r = await join('recipient-one');
    const body = 'a🙂\\"\n'.repeat(6000);
    const m = message(body);
    const page = await r.client.call<any>('msg.inbox', {});
    expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(12000);
    expect(page.messages[0].message.body).toContain('read_message');
    let offset = 0;
    let reconstructed = '';
    for (let n = 0; n < 100; n++) {
      const part = await r.client.call<any>('msg.read', { msg_id: m.id, body_offset: offset });
      expect(Buffer.byteLength(JSON.stringify(part, null, 2))).toBeLessThanOrEqual(12000);
      reconstructed += part.body;
      if (part.next_body_offset === null) break;
      offset = part.next_body_offset;
    }
    expect(reconstructed).toBe(body);
    const other = await join('other-one', '/elsewhere');
    await expect(other.client.call('msg.read', { msg_id: m.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('shows a held delivery in the sender receipt', async () => {
    const sender = await join('sender-one');
    await join('recipient-one');
    addThrottle(broker.db, 'sender-one', 'recipient-one');
    const result = await sender.client.call<any>('msg.send', {
      to: 'recipient-one',
      subject: 's',
      body: 'b',
      priority: 'urgent',
    });
    expect(result.deliveries).toEqual([{ recipient: 'recipient-one', state: 'held', hold_reason: 'throttled' }]);
  });
  it('automatically releases a throttle after its window and pushes the held backlog', async () => {
    const r = await join('recipient-one');
    broker.config.rate.window_s = 1;
    for (let n = 0; n < broker.config.rate.wake_pushes; n++)
      await broker.engine?.dispatchMessage(message(`wake ${n}`, 'sender-one', 'normal').id);
    const held = message('urgent after limit', 'sender-one', 'urgent');
    await broker.engine?.dispatchMessage(held.id);
    expect(deliveriesOfMessage(broker.db, held.id)[0]).toMatchObject({ state: 'held', hold_reason: 'throttled' });
    await until(() => r.pushes.some((p) => p.content.includes('urgent after limit')), 4000);
    expect(activeThrottles(broker.db)).toHaveLength(0);
  });
  it('recovers expired persistent throttles when the broker resumes', async () => {
    const r = await join('recipient-one');
    broker.config.rate.window_s = 1;
    addThrottle(broker.db, 'sender-one', 'recipient-one');
    broker.db.prepare('UPDATE throttles SET created_at=?').run(new Date(Date.now() - 5000).toISOString());
    const held = message('survives old throttle', 'sender-one', 'normal');
    await broker.engine?.dispatchMessage(held.id);
    await broker.engine?.resumeAll();
    await until(() => r.pushes.some((p) => p.content.includes('survives old throttle')), 3000);
    expect(activeThrottles(broker.db)).toHaveLength(0);
  });
});
