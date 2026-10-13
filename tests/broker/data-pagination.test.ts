import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import type { Client } from '../../src/client/client.js';
import { kvCas } from '../../src/store/kv.js';
import { addLink, removeLink, scopeFor } from '../../src/store/links.js';
import { getSession } from '../../src/store/sessions.js';
import { appendRecord, createStream } from '../../src/store/streams.js';
import { mcpClient, ownerClient, startTestBroker } from '../helpers.js';

let home: string;
let broker: Broker;
let client: Client;
let workspace: string;
const clients: Client[] = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
  const peer = await mcpClient(home, { requested_name: 'alpha-one' });
  client = peer.client;
  clients.push(client);
  const session = getSession(broker.db, peer.welcome.session_id);
  if (!session) throw new Error('Test peer did not register');
  workspace = session.workspace;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await broker.stop();
});
const seedKey = (key: string, value: unknown, ws = workspace) =>
  kvCas(broker.db, scopeFor(broker.db, ws), key, null, value, 'alpha-one', 100000);
const seedStream = (values: unknown[]) => {
  const scope = scopeFor(broker.db, workspace);
  createStream(broker.db, scope, { name: 'build-log', json_schema: null, description: 'd', created_by: 'alpha-one' });
  for (const record of values) appendRecord(broker.db, scope, 'build-log', record, 'alpha-one');
};
type Entry = { key: string; workspace: string; value?: unknown; value_omitted?: boolean; blob_ref?: string };
type KvPage = { entries: Entry[]; has_more: boolean; next_cursor: string | null };
type StreamPage = {
  records: Array<{ seq: number; record?: unknown; record_omitted?: boolean; blob_ref?: string }>;
  has_more: boolean;
  next_after_seq: number | null;
};
const bounded = (page: unknown) => expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(12000);

describe('byte-bounded data pages', () => {
  it('pages KV by key and workspace, including duplicate linked names, hiding tombstones and foreign keys', async () => {
    seedKey('lane/a', 1);
    seedKey('lane/a', 2, '/w/linked');
    seedKey('lane/b', 3);
    seedKey('lane/c', 4);
    seedKey('lane/secret', 5, '/w/foreign');
    seedKey('other/key', 6);
    kvCas(broker.db, scopeFor(broker.db, workspace), 'lane/c', 1, null, 'alpha-one', 100000);
    addLink(broker.db, workspace, '/w/linked');
    const seen: Entry[] = [];
    let cursor: string | null = null;
    do {
      const page: KvPage = await client.call('kv.list', { prefix: 'lane/', limit: 1, cursor: cursor ?? undefined });
      bounded(page);
      expect(page.entries).toHaveLength(1);
      expect(page.has_more).toBe(page.next_cursor !== null);
      seen.push(...page.entries);
      cursor = page.next_cursor;
      expect(seen.length).toBeLessThanOrEqual(3);
    } while (cursor !== null);
    expect(seen.map((e) => [e.key, e.value])).toEqual([
      ['lane/a', 2],
      ['lane/a', 1],
      ['lane/b', 3],
    ]);
  });

  it('uses a byte budget for escaped Unicode KV values, preserving every entry across pages', async () => {
    for (let i = 0; i < 9; i++) seedKey(`key/${i}`, '\n"😀'.repeat(300));
    const seen: Entry[] = [];
    let cursor: string | null = null;
    do {
      const page: KvPage = await client.call('kv.list', { limit: 1000, cursor: cursor ?? undefined });
      bounded(page);
      expect(page.entries.length).toBeGreaterThan(0);
      seen.push(...page.entries);
      cursor = page.next_cursor;
      expect(seen.length).toBeLessThanOrEqual(9);
    } while (cursor !== null);
    expect(seen.map((e) => e.key)).toEqual(Array.from({ length: 9 }, (_, i) => `key/${i}`));
    expect(seen.every((e) => e.value === '\n"😀'.repeat(300))).toBe(true);
  });

  it('continues after deletion of the last returned key and rejects malformed or mismatched cursors', async () => {
    seedKey('lane/a', 1);
    seedKey('lane/b', 2);
    const page = await client.call<KvPage>('kv.list', { prefix: 'lane/', limit: 1 });
    expect(page.next_cursor).toEqual(expect.any(String));
    kvCas(broker.db, scopeFor(broker.db, workspace), 'lane/a', 1, null, 'alpha-one', 100000);
    expect(await client.call('kv.list', { prefix: 'lane/', cursor: page.next_cursor })).toMatchObject({
      entries: [{ key: 'lane/b' }],
      has_more: false,
      next_cursor: null,
    });
    for (const params of [{ cursor: 'garbage' }, { prefix: 'other/', cursor: page.next_cursor }]) {
      await expect(client.call('kv.list', params)).rejects.toMatchObject({ code: 'bad_request' });
    }
    addLink(broker.db, workspace, '/w/linked');
    await expect(client.call('kv.list', { prefix: 'lane/', cursor: page.next_cursor })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('exports an oversized KV entry losslessly and keeps its blob in the owning workspace', async () => {
    const value = { text: '😀\n"'.repeat(7000) };
    seedKey('large', value, '/w/linked');
    addLink(broker.db, workspace, '/w/linked');
    const page = await client.call<KvPage>('kv.list', {});
    bounded(page);
    expect(page).toMatchObject({
      entries: [{ key: 'large', value_omitted: true, blob_ref: expect.any(String) }],
      has_more: false,
      next_cursor: null,
    });
    const ref = page.entries[0].blob_ref;
    const dest = join(home, 'entry.json');
    await client.call('blob.get', { ref, dest_path: dest });
    expect(JSON.parse(readFileSync(dest, 'utf8'))).toMatchObject({ key: 'large', workspace: '/w/linked', value });
    removeLink(broker.db, workspace, '/w/linked');
    await expect(client.call('blob.get', { ref, dest_path: join(home, 'forbidden.json') })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('pages streams by record count and bytes without skipping the first record that did not fit', async () => {
    seedStream(Array.from({ length: 9 }, (_, i) => ({ i, text: '\n"😀'.repeat(300) })));
    const seqs: number[] = [];
    let after = 0;
    do {
      const page = await client.call<StreamPage>('stream.read', { name: 'build-log', after_seq: after, limit: 2 });
      bounded(page);
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.records.length).toBeLessThanOrEqual(2);
      seqs.push(...page.records.map((r) => r.seq));
      expect(page.has_more).toBe(page.next_after_seq !== null);
      after = page.next_after_seq ?? 0;
      expect(seqs.length).toBeLessThanOrEqual(9);
    } while (after !== 0);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await client.call('stream.read', { name: 'build-log', after_seq: 9 })).toEqual({
      records: [],
      has_more: false,
      next_after_seq: null,
    });
  });

  it('uses the byte budget even with a large stream count limit and gives oversized records a retrievable reference', async () => {
    const record = { text: '😀\n"'.repeat(7000) };
    seedStream([record, ...Array.from({ length: 8 }, (_, i) => ({ i, text: '\n"😀'.repeat(300) }))]);
    const first = await client.call<StreamPage>('stream.read', { name: 'build-log', limit: 1 });
    bounded(first);
    expect(first).toMatchObject({
      records: [{ seq: 1, record_omitted: true, blob_ref: expect.any(String) }],
      has_more: true,
      next_after_seq: 1,
    });
    const dest = join(home, 'record.json');
    await client.call('blob.get', { ref: first.records[0].blob_ref, dest_path: dest });
    expect(JSON.parse(readFileSync(dest, 'utf8'))).toMatchObject({ seq: 1, record });
    const next = await client.call<StreamPage>('stream.read', { name: 'build-log', after_seq: 1, limit: 1000 });
    bounded(next);
    expect(next.records[0].seq).toBe(2);
    expect(next.records.length).toBeLessThan(8);
    expect(next.next_after_seq).toBe(next.records.at(-1)?.seq);
  });

  it('bounds owner pages too and validates page limits', async () => {
    for (let i = 0; i < 55; i++) seedKey(`key/${String(i).padStart(2, '0')}`, i);
    const owner = await ownerClient(home);
    clients.push(owner);
    const page = await owner.call<KvPage>('kv.list', {});
    bounded(page);
    expect(page.entries).toHaveLength(50);
    expect(page.has_more).toBe(true);
    for (const limit of [0, 1001, 1.5])
      await expect(client.call('kv.list', { limit })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await client.call('kv.list', { prefix: 'missing/' })).toEqual({
      entries: [],
      has_more: false,
      next_cursor: null,
    });
  });

  it('counts the final-page envelope when a stream record exactly fills the continuation envelope', async () => {
    const row = { seq: 1, record: '', appended_by: 'alpha-one', at: '2026-10-13T00:00:00.000Z' };
    const overhead = Buffer.byteLength(JSON.stringify({ records: [row], has_more: true, next_after_seq: 1 }, null, 2));
    const record = 'x'.repeat(12000 - overhead);
    seedStream([record]);
    const page = await client.call<StreamPage>('stream.read', { name: 'build-log' });
    bounded(page);
    expect(page.has_more).toBe(false);
    expect(page.next_after_seq).toBeNull();
    expect(page.records[0]).toMatchObject({ seq: 1, record_omitted: true, blob_ref: expect.any(String) });
  });
});
