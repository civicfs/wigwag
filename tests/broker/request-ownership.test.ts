import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, ownerClient, startTestBroker, until } from '../helpers.js';

let home: string;
let broker: Broker;
const closers: Array<() => unknown> = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await broker.stop();
});
async function connect(name: string, agent: 'claude' | 'codex' = 'claude', cwd = '/w/myproject') {
  const c = await mcpClient(home, { requested_name: name, agent, cwd });
  closers.push(() => c.client.close());
  return c;
}
const list = (c: Awaited<ReturnType<typeof connect>>) =>
  c.client.call<{ requests: Array<{ request_id: string }> }>('req.list', {});

describe('durable request and reply participants', () => {
  it('pins a previously out-of-scope destination when its workspace becomes eligible', async () => {
    const sender = await connect('sender-one', 'claude', '/w/sender');
    const req = await sender.client.call<{ request_id: string; message_id: string }>('req.request', {
      to: 'future-worker',
      subject: 'review',
      body: 'private question',
    });
    const worker = await connect('future-worker', 'codex', '/w/worker');
    expect(deliveriesOfMessage(broker.db, req.message_id)[0].state).toBe('stuck');
    const owner = await ownerClient(home);
    closers.push(() => owner.close());
    await owner.call('owner.link', { a: 'sender-one', b: 'future-worker' });
    expect(deliveriesOfMessage(broker.db, req.message_id)[0].recipient_session_id).toBe(worker.welcome.session_id);
    await worker.client.call('msg.inbox', {});
    await worker.client.call('session.register', { name: 'worker-two' });
    const replacement = await connect('future-worker', 'codex', '/w/worker');
    expect((await list(replacement)).requests).toEqual([]);
    expect(JSON.stringify(await replacement.client.call('msg.inbox', { include_read: true }))).not.toContain(
      'private question',
    );
    await worker.client.call('req.respond', {
      request_id: req.request_id,
      body: 'original eligible owner',
      status: 'ok',
    });
    expect(await sender.client.call('req.await', { request_id: req.request_id, wait_s: 0 })).toMatchObject({
      response: { body: 'original eligible owner' },
    });
  });
  it.each([
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const)('keeps the responder after rename and old-name reuse (%s to %s)', async (from, to) => {
    const sender = await connect('sender-one', from);
    const worker = await connect('worker-one', to);
    const req = await sender.client.call<{ request_id: string; message_id: string }>('req.request', {
      to: 'worker-one',
      subject: 'review',
      body: 'private question',
    });
    await worker.client.call('session.register', { name: 'worker-two' });
    const replacement = await connect('worker-one', to);
    expect((await list(worker)).requests.map((r) => r.request_id)).toContain(req.request_id);
    expect((await list(replacement)).requests).toEqual([]);
    await expect(
      replacement.client.call('req.respond', {
        request_id: req.request_id,
        body: 'wrong session',
        status: 'ok',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await worker.client.call('req.respond', { request_id: req.request_id, body: 'right session', status: 'ok' });
    expect(await sender.client.call('req.await', { request_id: req.request_id, wait_s: 0 })).toMatchObject({
      status: 'answered',
      response: { body: 'right session' },
    });
  });

  it.each(['claude', 'codex'] as const)(
    'routes responses and an active await to the renamed %s requester',
    async (agent) => {
      const sender = await connect('sender-one', agent);
      const worker = await connect('worker-one', agent === 'codex' ? 'claude' : 'codex');
      const req = await sender.client.call<{ request_id: string }>('req.request', {
        to: 'worker-one',
        subject: 'review',
        body: 'private question',
      });
      const waiting = sender.client.call('req.await', { request_id: req.request_id, wait_s: 5 });
      await sender.client.call('session.register', { name: 'sender-two' });
      const replacement = await connect('sender-one', agent);
      const response = await worker.client.call<{ message_id: string }>('req.respond', {
        request_id: req.request_id,
        body: 'private response',
        status: 'ok',
      });
      expect(await waiting).toMatchObject({ status: 'answered', response: { body: 'private response' } });
      expect((await list(replacement)).requests).toEqual([]);
      await expect(
        replacement.client.call('req.await', { request_id: req.request_id, wait_s: 0 }),
      ).rejects.toMatchObject({ code: 'bad_request' });
      expect(JSON.stringify(await replacement.client.call('msg.inbox', { include_read: true }))).not.toContain(
        'private response',
      );
      expect(deliveriesOfMessage(broker.db, response.message_id)[0].recipient).toBe('sender-two');
    },
  );

  it('routes ordinary replies to their original session after sender rename', async () => {
    const sender = await connect('sender-one');
    const worker = await connect('worker-one', 'codex');
    const orig = await sender.client.call<{ id: string }>('msg.send', {
      to: 'worker-one',
      subject: 'review',
      body: 'private message',
      priority: 'low',
    });
    await sender.client.call('session.register', { name: 'sender-two' });
    const replacement = await connect('sender-one');
    await expect(replacement.client.call('msg.read', { msg_id: orig.id })).rejects.toMatchObject({ code: 'not_found' });
    const reply = await worker.client.call<{ id: string }>('msg.reply', { msg_id: orig.id, body: 'private reply' });
    expect(deliveriesOfMessage(broker.db, reply.id)[0].recipient).toBe('sender-two');
    expect(JSON.stringify(await replacement.client.call('msg.inbox', { include_read: true }))).not.toContain(
      'private reply',
    );
    expect(JSON.stringify(await sender.client.call('msg.inbox', { include_read: true }))).toContain('private reply');
  });

  it('gives a never-registered destination to its first claimant once, across rename', async () => {
    const sender = await connect('sender-one');
    const req = await sender.client.call<{ request_id: string }>('req.request', {
      to: 'future-worker',
      subject: 'review',
      body: 'private question',
    });
    const worker = await connect('future-worker', 'codex');
    await worker.client.call('session.register', { name: 'worker-two' });
    const replacement = await connect('future-worker');
    expect((await list(replacement)).requests).toEqual([]);
    await worker.client.call('req.respond', { request_id: req.request_id, body: 'first owner', status: 'ok' });
    expect(await sender.client.call('req.await', { request_id: req.request_id, wait_s: 0 })).toMatchObject({
      response: { body: 'first owner' },
    });
  });

  it.each(['req.respond', 'msg.reply'] as const)(
    'holds %s for a nameless offline sender until its slot returns',
    async (method) => {
      const sender = await connect('sender-one');
      const worker = await connect('worker-one', 'codex');
      const req = await sender.client.call<{ request_id: string; message_id: string }>('req.request', {
        to: 'worker-one',
        subject: 'review',
        body: 'private question',
      });
      sender.client.close();
      await until(() => getSession(broker.db, sender.welcome.session_id)?.state === 'offline');
      const replacement = await connect('sender-one');
      expect(getSession(broker.db, sender.welcome.session_id)?.name).toBeNull();
      const reply =
        method === 'req.respond'
          ? await worker.client
              .call<{ message_id: string }>('req.respond', {
                request_id: req.request_id,
                body: 'private answer',
                status: 'ok',
              })
              .then((r) => r.message_id)
          : await worker.client
              .call<{ id: string }>('msg.reply', { msg_id: req.message_id, body: 'private answer' })
              .then((r) => r.id);
      expect(deliveriesOfMessage(broker.db, reply)[0]).toMatchObject({
        recipient_session_id: sender.welcome.session_id,
      });
      expect(JSON.stringify(await replacement.client.call('msg.inbox', { include_read: true }))).not.toContain(
        'private answer',
      );
      const resumed = await mcpClient(home, {
        resume_session_id: sender.welcome.session_id,
        requested_name: 'sender-two',
      });
      closers.push(() => resumed.client.close());
      expect(resumed.welcome.session_id).toBe(sender.welcome.session_id);
      expect(JSON.stringify(await resumed.client.call('msg.inbox', { include_read: true }))).toContain(
        'private answer',
      );
    },
  );

  it('recovers a committed response after restart without granting it to a replacement name holder', async () => {
    const sender = await connect('sender-one');
    const worker = await connect('worker-one', 'codex');
    const req = await sender.client.call<{ request_id: string }>('req.request', {
      to: 'worker-one',
      subject: 'review',
      body: 'private question',
    });
    await sender.client.call('session.register', { name: 'sender-two' });
    await connect('sender-one');
    await worker.client.call('req.respond', { request_id: req.request_id, body: 'committed answer', status: 'ok' });
    for (const close of closers.splice(0)) await close();
    await broker.stop();
    ({ broker } = await startTestBroker(home));
    const replacement = await connect('sender-one');
    await expect(replacement.client.call('req.await', { request_id: req.request_id, wait_s: 0 })).rejects.toMatchObject(
      { code: 'bad_request' },
    );
    const resumed = await mcpClient(home, { resume_session_id: sender.welcome.session_id });
    closers.push(() => resumed.client.close());
    expect(await resumed.client.call('req.await', { request_id: req.request_id, wait_s: 0 })).toMatchObject({
      response: { body: 'committed answer' },
    });
  });
});
