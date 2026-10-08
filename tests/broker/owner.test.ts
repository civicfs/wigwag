import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { mcpClient, startTestBroker, until } from '../helpers.js';

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

async function owner() {
  const feed: Array<{ type: string }> = [];
  const { client } = await Client.connect(
    sockPath(home),
    { protocol: 1, role: 'owner' },
    frameLimit(loadConfig(home)),
    (n, d) => {
      if (n === 'feed') feed.push(d as { type: string });
    },
  );
  closers.push(() => client.close());
  await client.call('owner.subscribe');
  return { client, feed };
}

describe('owner handlers', () => {
  it('owner.send with an attachment pushes as owner; the feed streams message and delivery events', async () => {
    const o = await owner();
    const a = await mcpClient(home, { requested_name: 'alpha-one' });
    closers.push(() => a.client.close());
    const dir = mkdtempSync(join(tmpdir(), 'ww-o-'));
    writeFileSync(join(dir, 'notes.md'), '# notes');
    const { id } = await o.client.call<{ id: string }>('owner.send', {
      to: 'alpha-one',
      subject: 'please review',
      body: 'see attached',
      priority: 'normal',
      attach_paths: [join(dir, 'notes.md')],
    });
    await until(() => a.pushes.length === 1);
    expect(a.pushes[0].meta.from).toBe('owner');
    expect(a.pushes[0].content).toMatch(/text\/markdown/);
    await until(() => o.feed.some((f) => f.type === 'message') && o.feed.some((f) => f.type === 'delivery'));
    const shown = await o.client.call<{ kind: string; deliveries: Array<{ state: string }> }>('owner.show', { id });
    expect(shown.kind).toBe('message');
    expect(shown.deliveries[0].state).toBe('read');
    const { blobs } = await o.client.call<{ blobs: Array<{ name: string }> }>('owner.blobs', {});
    expect(blobs.map((b) => b.name)).toContain('notes.md');
  });

  it('snapshot lists sessions, feed, open deliveries and throttles; release_throttle flushes', async () => {
    const o = await owner();
    const a = await mcpClient(home, { requested_name: 'alpha-one' });
    const b = await mcpClient(home, { requested_name: 'beta-one' });
    closers.push(
      () => a.client.close(),
      () => b.client.close(),
    );
    for (let i = 0; i <= broker.config.rate.wake_pushes; i++) {
      await a.client.call('msg.send', { to: 'beta-one', subject: `n${i}`, body: 'x', priority: 'normal' });
    }
    const snap = await o.client.call<{
      sessions: unknown[];
      throttles: unknown[];
      deliveries: Array<{ hold_reason: string }>;
    }>('owner.snapshot', {});
    expect(snap.sessions.length).toBeGreaterThanOrEqual(2);
    expect(snap.throttles).toEqual([expect.objectContaining({ from_name: 'alpha-one', to_name: 'beta-one' })]);
    expect(snap.deliveries.some((d) => d.hold_reason === 'throttled')).toBe(true);
    await o.client.call('owner.release_throttle', { from: 'alpha-one', to: 'beta-one' });
    await until(() => b.pushes.length === broker.config.rate.wake_pushes + 1);
  });

  it('owner.show resolves blob refs and request ids; unknown ids are not_found', async () => {
    const o = await owner();
    await expect(o.client.call('owner.show', { id: 'msg-nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(o.client.call('owner.show', { id: 'req-nope' })).rejects.toMatchObject({ code: 'not_found' });
    const dir = mkdtempSync(join(tmpdir(), 'ww-o-'));
    writeFileSync(join(dir, 'n.md'), '# hi');
    const a = await mcpClient(home, { requested_name: 'alpha-one' });
    closers.push(() => a.client.close());
    await o.client.call('owner.send', {
      to: 'alpha-one',
      subject: 's',
      body: 'b',
      priority: 'normal',
      attach_paths: [join(dir, 'n.md')],
    });
    const { blobs } = await o.client.call<{ blobs: Array<{ ref: string }> }>('owner.blobs', {});
    const blob = await o.client.call<{ kind: string; text: string | null }>('owner.show', { id: blobs[0].ref });
    expect(blob).toMatchObject({ kind: 'blob', text: '# hi' });
  });
});
