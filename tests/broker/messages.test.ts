import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { mcpClient, ownerClient, startTestBroker, until, WAIT_MS } from '../helpers.js';

let home: string;
let broker: Broker;
const closers: Array<() => unknown> = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await broker.stop();
});
const join = async (name: string) => {
  const c = await mcpClient(home, { requested_name: name });
  closers.push(() => c.client.close());
  return c;
};

describe('message handlers', () => {
  it('send → push; sender identity comes from the session, not the payload', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const { id } = await a.client.call<{ id: string }>('msg.send', {
      to: 'beta-one',
      subject: 'hi',
      body: 'hello',
      priority: 'normal',
    });
    await until(() => b.pushes.length === 1);
    expect(b.pushes[0].meta).toMatchObject({ msg_id: id, from: 'alpha-one' });
  });

  it('to:all reaches every assigned name except the sender', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const c = await join('gamma-one');
    await a.client.call('msg.send', { to: 'all', subject: 'notice', body: 'x', priority: 'normal' });
    await until(() => b.pushes.length === 1 && c.pushes.length === 1);
    expect(a.pushes).toHaveLength(0);
  });

  it('moves an over-limit body into a blob and says so (review focus 5)', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const big = 'é'.repeat(broker.config.limits.inline_body_bytes); // 2 bytes each: over the byte limit
    await a.client.call('msg.send', { to: 'beta-one', subject: 'big', body: big, priority: 'normal' });
    await until(() => b.pushes.length === 1);
    expect(b.pushes[0].content).toMatch(
      /body stored as blob sha256:[0-9a-f]{64} \(\d+ bytes, text\/plain; charset=utf-8\)/,
    );
    const ref = /sha256:[0-9a-f]{64}/.exec(b.pushes[0].content)?.[0];
    const got = await b.client.call<{ text: string }>('blob.get', { ref });
    expect(got.text).toBe(big);
  });

  it('rejects unknown attachment refs', async () => {
    const a = await join('alpha-one');
    await expect(
      a.client.call('msg.send', {
        to: 'beta-one',
        subject: 's',
        body: 'b',
        priority: 'low',
        attachments: [`sha256:${'0'.repeat(64)}`],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reply threads to the original sender; inbox returns unread and marks read', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const { id } = await a.client.call<{ id: string }>('msg.send', {
      to: 'beta-one',
      subject: 'q',
      body: '?',
      priority: 'low',
    });
    const inbox = await b.client.call<{ messages: Array<{ message: { id: string }; delivery_state: string }> }>(
      'msg.inbox',
      {},
    );
    expect(inbox.messages.map((m) => [m.message.id, m.delivery_state])).toEqual([[id, 'held']]);
    expect((await b.client.call<{ messages: unknown[] }>('msg.inbox', {})).messages).toHaveLength(0);
    await b.client.call('msg.reply', { msg_id: id, body: 'answer' });
    await until(() => a.pushes.length === 1);
    expect(a.pushes[0].meta).toMatchObject({ from: 'beta-one', reply_to: id });
    expect(a.pushes[0].content).toContain('Subject: Re: q');
  });

  it('muting a sender holds its normal messages; urgent still pushes', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    await b.client.call('mute.add', { target: 'sender:alpha-one' });
    await a.client.call('msg.send', { to: 'beta-one', subject: 'n', body: 'n', priority: 'normal' });
    await a.client.call('msg.send', { to: 'beta-one', subject: 'u', body: 'u', priority: 'urgent' });
    await until(() => b.pushes.length === 1);
    expect(b.pushes[0].meta.priority).toBe('urgent');
  });

  it('a send without a subject is accepted and stored with the no-subject marker (spec §10)', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const { id } = await a.client.call<{ id: string }>('msg.send', {
      to: 'beta-one',
      body: 'no subject',
      priority: 'normal',
    });
    await until(() => b.pushes.length === 1);
    expect(b.pushes[0].content).toContain('Subject: (no subject)');
    const o = await ownerClient(home);
    closers.push(() => o.close());
    const shown = await o.call<{ message: { subject: string } }>('owner.show', { id });
    expect(shown.message.subject).toBe('(no subject)');
    await expect(
      a.client.call('msg.send', { to: 'beta-one', subject: '', body: 'x', priority: 'normal' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  describe('messages to the owner (spec §2/§6: the owner is not a session)', () => {
    const ownerConn = async () => {
      const client = await ownerClient(home);
      closers.push(() => client.close());
      return { client };
    };
    const stateOf = async (id: string) => {
      const o = await ownerConn();
      const shown = await o.client.call<{
        deliveries: Array<{ recipient: string; state: string; hold_reason: string | null; transport: string | null }>;
      }>('owner.show', { id });
      return shown.deliveries;
    };

    // The delivery leaves `pending` once the engine has run for it.
    const settled = (id: string) =>
      vi.waitFor(
        async () => {
          if ((await stateOf(id))[0].state === 'pending') throw new Error(`${id} still pending`);
        },
        { timeout: WAIT_MS },
      );

    it('an agent message to owner is delivered to the owner feed, not held offline', async () => {
      const a = await join('alpha-one');
      const { id } = await a.client.call<{ id: string }>('msg.send', {
        to: 'owner',
        subject: 'done',
        body: 'merged',
        priority: 'normal',
      });
      await settled(id);
      expect(await stateOf(id)).toMatchObject([
        { recipient: 'owner', state: 'pushed', hold_reason: null, transport: 'owner-feed' },
      ]);
    });

    it('priorities low and urgent reach the owner the same way, and a reply to an owner message does too', async () => {
      const a = await join('alpha-one');
      const o = await ownerConn();
      const { id: low } = await a.client.call<{ id: string }>('msg.send', {
        to: 'owner',
        subject: 'l',
        body: 'l',
        priority: 'low',
      });
      const { id: urgent } = await a.client.call<{ id: string }>('msg.send', {
        to: 'owner',
        subject: 'u',
        body: 'u',
        priority: 'urgent',
      });
      const { id: fromOwner } = await o.client.call<{ id: string }>('owner.send', {
        to: 'alpha-one',
        subject: 'q',
        body: 'q',
        priority: 'normal',
        attach_paths: [],
      });
      await until(() => a.pushes.length === 1);
      const { id: reply } = await a.client.call<{ id: string }>('msg.reply', { msg_id: fromOwner, body: 'answer' });
      for (const id of [low, urgent, reply]) await settled(id);
      for (const id of [low, urgent, reply]) {
        expect(await stateOf(id)).toMatchObject([{ recipient: 'owner', state: 'pushed' }]);
      }
    });

    it('rapid sends to owner are never throttled (the owner is not woken)', async () => {
      const a = await join('alpha-one');
      const ids: string[] = [];
      const n = broker.config.rate.wake_pushes + 3;
      for (let i = 0; i < n; i++) {
        ids.push(
          (
            await a.client.call<{ id: string }>('msg.send', {
              to: 'owner',
              subject: `s${i}`,
              body: 'b',
              priority: 'normal',
            })
          ).id,
        );
      }
      for (const id of ids) await settled(id);
      for (const id of ids) expect(await stateOf(id)).toMatchObject([{ state: 'pushed' }]);
    });

    it('the owner feed shows the message and the final delivery state', async () => {
      const o = await ownerConn();
      const feed: Array<{ type: string; payload: { state?: string; recipient?: string } }> = [];
      o.client.on('event', (n: string, d: unknown) => {
        if (n === 'feed') feed.push(d as never);
      });
      await o.client.call('owner.subscribe');
      const a = await join('alpha-one');
      await a.client.call('msg.send', { to: 'owner', subject: 'x', body: 'y', priority: 'normal' });
      await until(() =>
        feed.some((f) => f.type === 'delivery' && f.payload.recipient === 'owner' && f.payload.state === 'pushed'),
      );
    });
  });
});
