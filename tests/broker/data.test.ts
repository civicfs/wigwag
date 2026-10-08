import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markRead } from '../../src/broker/handlers/messages.js';
import type { Broker } from '../../src/broker/server.js';
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
const join2 = async (name: string) => {
  const c = await mcpClient(home, { requested_name: name });
  closers.push(() => c.client.close());
  return c;
};

describe('data handlers', () => {
  it('blob.get to a dangling symlink is a conflict and never writes through it (T9 pin: EEXIST -> conflict)', async () => {
    const a = await join2('alpha-one');
    const dir = mkdtempSync(join(tmpdir(), 'ww-b-'));
    const { ref } = await a.client.call<{ ref: string }>('blob.put', { text: 'x', media_type: 'text/plain' });
    const target = join(dir, 'target.txt');
    const dest = join(dir, 'link.txt');
    symlinkSync(target, dest); // existsSync(dest) is false; the exclusive create fails with EEXIST
    await expect(a.client.call('blob.get', { ref, dest_path: dest })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/Refusing to overwrite/),
    });
    expect(existsSync(target)).toBe(false);
  });

  it('markRead swallows only not_found (T9 pin)', async () => {
    expect(markRead(broker, 'msg-01j0000000000000000000000z', 'alpha-one')).toBe(false);
    await broker.stop(); // closed db: a real failure must surface
    expect(() => markRead(broker, 'msg-01j0000000000000000000000z', 'alpha-one')).toThrow();
  });

  it('blob put by path, get inline and to a destination (no overwrite)', async () => {
    const a = await join2('alpha-one');
    const dir = mkdtempSync(join(tmpdir(), 'ww-b-'));
    writeFileSync(join(dir, 'ci.json'), '{"ok":true}');
    const meta = await a.client.call<{ ref: string; size: number }>('blob.put', {
      path: join(dir, 'ci.json'),
      media_type: 'application/json',
    });
    expect(meta.size).toBe(11);
    expect(await a.client.call('blob.get', { ref: meta.ref })).toMatchObject({ text: '{"ok":true}' });
    const dest = join(dir, 'out.json');
    expect(await a.client.call('blob.get', { ref: meta.ref, dest_path: dest })).toMatchObject({ written_to: dest });
    expect(readFileSync(dest, 'utf8')).toBe('{"ok":true}');
    await expect(a.client.call('blob.get', { ref: meta.ref, dest_path: dest })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(a.client.call('blob.put', { path: 'relative.txt', media_type: 'text/plain' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('concurrent create-only CAS on one key: exactly one wins (success criterion 3)', async () => {
    const a = await join2('alpha-one');
    const b = await join2('beta-one');
    const [ra, rb] = await Promise.all([
      a.client.call<{ ok: boolean }>('kv.cas', { key: 'migrations/next', expected_version: null, value: 724 }),
      b.client.call<{ ok: boolean }>('kv.cas', { key: 'migrations/next', expected_version: null, value: 725 }),
    ]);
    expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
    const loser = ra.ok ? rb : ra;
    expect(loser).toMatchObject({ ok: false, current: { version: 1 } });
  });

  it('kv.watch pushes changes to watchers (not the writer) at the watch priority', async () => {
    const a = await join2('alpha-one');
    const b = await join2('beta-one');
    await b.client.call('kv.watch', { prefix: 'lane/', priority: 'normal' });
    await a.client.call('kv.cas', { key: 'lane/es', expected_version: null, value: { owner: 'alpha-one' } });
    await until(() => b.pushes.length === 1);
    expect(b.pushes[0].content).toMatch(/lane\/es/);
    expect(a.pushes).toHaveLength(0);
    await expect(a.client.call('kv.cas', { key: 'lane/es', expected_version: 1, value: null })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(a.client.call('kv.delete', { key: 'lane/es', expected_version: 1 })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('stream subscribe with filter delivers matching records as low digests', async () => {
    const a = await join2('alpha-one');
    const b = await join2('beta-one');
    await a.client.call('stream.create', {
      name: 'ci-results',
      json_schema: {
        type: 'object',
        required: ['pr', 'ok'],
        properties: { pr: { type: 'integer' }, ok: { type: 'boolean' } },
      },
      description: 'CI verdicts',
    });
    await b.client.call('stream.subscribe', { name: 'ci-results', filter: { ok: false } });
    await a.client.call('stream.append', { name: 'ci-results', record: { pr: 1, ok: true } });
    await a.client.call('stream.append', { name: 'ci-results', record: { pr: 2, ok: false } });
    await expect(a.client.call('stream.append', { name: 'ci-results', record: { pr: 'x' } })).rejects.toMatchObject({
      code: 'schema',
    });
    const digest = broker.engine?.takeDigest('beta-one') ?? '';
    expect(digest).toMatch(/"pr": 2/);
    expect(digest).not.toMatch(/"pr": 1/);
    expect(await b.client.call('stream.read', { name: 'ci-results', after_seq: 1 })).toMatchObject({
      records: [{ seq: 2 }],
    });
    await expect(b.client.call('stream.subscribe', { name: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('data handler hardening', () => {
  it('stream filters ignore object key order', async () => {
    const a = await join2('alpha-one');
    const b = await join2('beta-one');
    await a.client.call('stream.create', { name: 'order-test', json_schema: { type: 'object' }, description: 'd' });
    await b.client.call('stream.subscribe', { name: 'order-test', filter: { meta: { b: 2, a: 1 } } });
    await a.client.call('stream.append', { name: 'order-test', record: { meta: { a: 1, b: 2 } } });
    expect(broker.engine?.takeDigest('beta-one') ?? '').toMatch(/"a": 1/);
  });

  it('isTextual is strict', async () => {
    const { isTextual } = await import('../../src/mime.js');
    expect(isTextual('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isTextual('application/ld+json')).toBe(true);
    expect(isTextual('text/plain; charset=utf-8')).toBe(true);
    expect(isTextual('image/png')).toBe(false);
  });
});

describe('post-commit fan-out isolation', () => {
  it('kv.cas succeeds even when the watcher notice cannot be prepared', async () => {
    await broker.stop();
    const { configPath } = await import('../../src/config.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
    cfg.limits.inline_body_bytes = 10;
    cfg.limits.max_blob_bytes = 10;
    writeFileSync(configPath(home), JSON.stringify(cfg, null, 2));
    const { startBroker } = await import('../../src/broker/assemble.js');
    broker = await startBroker(home);
    const a = await join2('alpha-one');
    const b = await join2('beta-one');
    await b.client.call('kv.watch', { prefix: 'x/', priority: 'normal' });
    await expect(
      a.client.call('kv.cas', { key: 'x/y', expected_version: null, value: 'a long enough value' }),
    ).resolves.toMatchObject({ ok: true });
    expect(await a.client.call('kv.get', { key: 'x/y' })).toMatchObject({ entry: { value: 'a long enough value' } });
  });
});
