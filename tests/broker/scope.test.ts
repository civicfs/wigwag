import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import { gitRepo, gitWorktree, mcpClient, startTestBroker, until } from '../helpers.js';

let home: string;
let broker: Broker;
const closers: Array<() => unknown> = [];
let repoA: string;
let repoB: string;
let repoC: string;
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
  repoA = gitRepo();
  repoB = gitRepo();
  repoC = gitRepo();
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await broker.stop();
});

const label = (repo: string) => realpathSync(repo);
const join2 = async (name: string, cwd: string) => {
  const c = await mcpClient(home, { requested_name: name, cwd });
  closers.push(() => c.client.close());
  return c;
};
async function owner() {
  const feed: Array<{ type: string; payload: unknown }> = [];
  const { client } = await Client.connect(
    sockPath(home),
    { protocol: 1, role: 'owner' },
    frameLimit(loadConfig(home)),
    (n, d) => {
      if (n === 'feed') feed.push(d as { type: string; payload: unknown });
    },
  );
  closers.push(() => client.close());
  await client.call('owner.subscribe');
  return { client, feed };
}
const send = (c: { client: Client }, to: string, extra: Record<string, unknown> = {}) =>
  c.client.call<{ id: string }>('msg.send', { to, subject: 's', body: 'b', priority: 'normal', ...extra });
const stateOf = (id: string, recipient: string) =>
  deliveriesOfMessage(broker.db, id).find((d) => d.recipient === recipient);

describe('workspace scoping (spec §17)', () => {
  it('same repo (one session in a worktree) talks without a link; cross-repo send is forbidden', async () => {
    const a = await join2('alpha-one', repoA);
    const a2 = await join2('alpha-two', join(gitWorktree(repoA), 'sub'));
    await join2('beta-one', repoB);
    await send(a, 'alpha-two');
    await until(() => a2.pushes.length === 1);
    expect(await a.client.call('session.whoami')).toMatchObject({
      workspace: join(label(repoA), '.git'),
      workspace_label: label(repoA),
    });
    const err = await send(a, 'beta-one').catch((e) => e);
    expect(err).toMatchObject({ code: 'forbidden' });
    expect(err.message).toBe(
      `Session "beta-one" is in workspace ${label(repoB)}, not linked to ${label(repoA)}. ` +
        `The owner can run: wigwag link ${label(repoA)} ${label(repoB)}`,
    );
    await expect(a.client.call('req.request', { to: 'beta-one', subject: 's', body: 'b' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('to:all reaches only names in the sender scope; owner to:all reaches every workspace', async () => {
    const a = await join2('alpha-one', repoA);
    const a2 = await join2('alpha-two', gitWorktree(repoA));
    const b = await join2('beta-one', repoB);
    const { id } = await send(a, 'all');
    expect(deliveriesOfMessage(broker.db, id).map((d) => d.recipient)).toEqual(['alpha-two']);
    await until(() => a2.pushes.length === 1);
    const o = await owner();
    const sent = await o.client.call<{ id: string }>('owner.send', {
      to: 'all',
      subject: 'o',
      body: 'o',
      priority: 'normal',
    });
    expect(deliveriesOfMessage(broker.db, sent.id).map((d) => d.recipient)).toEqual([
      'alpha-one',
      'alpha-two',
      'beta-one',
    ]);
    await until(() => b.pushes.length === 1 && a.pushes.length === 1);
  });

  it('held message to a never-seen name later registered out of scope → stuck + sender notice; link then deliver', async () => {
    const a = await join2('alpha-one', repoA);
    const { id } = await send(a, 'late-one');
    expect(stateOf(id, 'late-one')).toMatchObject({ state: 'held', hold_reason: 'offline' });
    const late = await join2('late-one', repoB);
    await until(() => stateOf(id, 'late-one')?.state === 'stuck');
    expect(stateOf(id, 'late-one')?.last_error).toContain(`not linked to ${label(repoA)}`);
    expect(late.pushes).toHaveLength(0);
    await until(() => broker.db.prepare(`SELECT 1 FROM messages WHERE to_target = 'alpha-one'`).get() !== undefined);
    const inbox = await a.client.call<{ messages: Array<{ message: { subject: string; body: string } }> }>(
      'msg.inbox',
      {},
    );
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].message.subject).toMatch(/stuck/);
    expect(inbox.messages[0].message.body).toContain('wigwag link');

    const o = await owner();
    const linked = await o.client.call<{ links: Array<{ a_label: string; b_label: string }> }>('owner.link', {
      a: join(repoA, 'sub'),
      b: 'late-one',
    });
    expect(linked.links.map((l) => [l.a_label, l.b_label].sort())).toEqual([[label(repoA), label(repoB)].sort()]);
    await until(() => o.feed.some((f) => f.type === 'link'));
    expect(o.feed.find((f) => f.type === 'link')?.payload).toMatchObject({ active: true });
    const second = await send(a, 'late-one');
    await until(() => late.pushes.length === 1);
    expect(late.pushes[0].meta.msg_id).toBe(second.id);
    expect(stateOf(id, 'late-one')?.state).toBe('stuck');
  });

  it('links are transitive (A–B, B–C) and unlinking A–B cuts A off from C', async () => {
    const a = await join2('alpha-one', repoA);
    await join2('beta-one', repoB);
    const c = await join2('gamma-one', repoC);
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    await o.client.call('owner.link', { a: 'beta-one', b: 'gamma-one' });
    await send(a, 'gamma-one');
    await until(() => c.pushes.length === 1);
    const { links } = await o.client.call<{ links: unknown[] }>('owner.unlink', { a: repoB, b: repoA });
    expect(links).toHaveLength(1);
    await expect(send(a, 'gamma-one')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await o.client.call<{ links: unknown[] }>('owner.links', {})).links).toHaveLength(1);
    await until(() => o.feed.some((f) => f.type === 'link' && (f.payload as { active: boolean }).active === false));
  });

  it('owner.link rejects self-links (also via a worktree path) and unknown names', async () => {
    const o = await owner();
    await join2('alpha-one', repoA);
    await expect(o.client.call('owner.link', { a: repoA, b: gitWorktree(repoA) })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(o.client.call('owner.link', { a: 'alpha-one', b: join(repoA, 'sub') })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(o.client.call('owner.link', { a: 'nobody-here', b: repoB })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(o.client.call('owner.link', { a: 'relative/path', b: repoB })).rejects.toMatchObject({
      code: 'bad_request',
    });
    // final m-3: a path that does not exist would link a phantom workspace
    await expect(o.client.call('owner.link', { a: join(repoA, 'no-such-dir'), b: repoB })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await o.client.call<{ links: unknown[] }>('owner.links', {})).links).toHaveLength(0);
  });

  it('agents cannot call link methods', async () => {
    const a = await join2('alpha-one', repoA);
    for (const m of ['owner.link', 'owner.unlink'] as const) {
      await expect(a.client.call(m, { a: repoA, b: repoB })).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(a.client.call('owner.links', {})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('who from an agent lists only in-scope sessions; the owner sees all with workspace', async () => {
    const a = await join2('alpha-one', repoA);
    await join2('alpha-two', gitWorktree(repoA));
    await join2('beta-one', repoB);
    const mine = await a.client.call<Array<{ name: string }>>('session.who', {});
    expect(mine.map((s) => s.name).sort()).toEqual(['alpha-one', 'alpha-two']);
    const o = await owner();
    const all = await o.client.call<Array<{ name: string; workspace_label: string }>>('session.who', {});
    expect(all.map((s) => [s.name, s.workspace_label]).sort()).toEqual([
      ['alpha-one', label(repoA)],
      ['alpha-two', label(repoA)],
      ['beta-one', label(repoB)],
    ]);
  });

  it('KV: unlinked workspaces own the same key independently; linking makes it a conflict until one side deletes', async () => {
    const a = await join2('alpha-one', repoA);
    const b = await join2('beta-one', repoB);
    await expect(a.client.call('kv.cas', { key: 'lock', expected_version: null, value: 'a' })).resolves.toMatchObject({
      ok: true,
      version: 1,
    });
    await expect(b.client.call('kv.cas', { key: 'lock', expected_version: null, value: 'b' })).resolves.toMatchObject({
      ok: true,
      version: 1,
    });
    expect(await a.client.call('kv.get', { key: 'lock' })).toMatchObject({ entry: { value: 'a' } });
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const err = await a.client.call('kv.get', { key: 'lock' }).then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    expect(err).toMatchObject({ code: 'conflict' });
    expect(err.message).toContain(label(repoA));
    expect(err.message).toContain(label(repoB));
    await expect(b.client.call('kv.delete', { key: 'lock', expected_version: 1 })).resolves.toMatchObject({
      ok: true,
    });
    expect(await a.client.call('kv.get', { key: 'lock' })).toMatchObject({ entry: { value: 'a' } });
    expect(await b.client.call('kv.get', { key: 'lock' })).toMatchObject({ entry: { value: 'a' } });
    await b.client.call('kv.cas', { key: 'from-b', expected_version: null, value: 1 });
    expect(await a.client.call('kv.get', { key: 'from-b' })).toMatchObject({
      entry: { workspace: join(label(repoB), '.git') },
    });
  });

  it('KV watch fan-out reaches only watchers in the writer scope', async () => {
    const a = await join2('alpha-one', repoA);
    const a2 = await join2('alpha-two', gitWorktree(repoA));
    const b = await join2('beta-one', repoB);
    await a2.client.call('kv.watch', { prefix: 'lane/', priority: 'normal' });
    await b.client.call('kv.watch', { prefix: 'lane/', priority: 'normal' });
    await a.client.call('kv.cas', { key: 'lane/x', expected_version: null, value: 1 });
    await until(() => a2.pushes.length === 1);
    expect(broker.db.prepare(`SELECT count(*) AS n FROM messages WHERE to_target = 'beta-one'`).get()).toEqual({
      n: 0,
    });
  });

  it('streams: same name per workspace, conflict after link, fan-out within scope', async () => {
    const a = await join2('alpha-one', repoA);
    const a2 = await join2('alpha-two', gitWorktree(repoA));
    const b = await join2('beta-one', repoB);
    const mk = { name: 'ci', json_schema: null, description: 'd' };
    await a.client.call('stream.create', mk);
    await b.client.call('stream.create', mk);
    await a2.client.call('stream.subscribe', { name: 'ci' });
    await b.client.call('stream.subscribe', { name: 'ci' });
    await a.client.call('stream.append', { name: 'ci', record: { from: 'a' } });
    expect(broker.engine?.takeDigest('alpha-two')).toMatch(/"from": "a"/);
    expect(broker.engine?.takeDigest('beta-one')).toBeNull();
    expect(await b.client.call('stream.read', { name: 'ci' })).toMatchObject({ records: [] });
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    await expect(a.client.call('stream.append', { name: 'ci', record: {} })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(b.client.call('stream.read', { name: 'ci' })).rejects.toMatchObject({ code: 'conflict' });
    const { streams } = await a.client.call<{ streams: Array<{ name: string }> }>('stream.list', {});
    expect(streams.map((s) => s.name)).toEqual(['ci', 'ci']);
    await a.client.call('stream.create', { ...mk, name: 'only-a' });
    await expect(b.client.call('stream.create', { ...mk, name: 'only-a' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('blobs: readable only from a workspace that stored or received it', async () => {
    const a = await join2('alpha-one', repoA);
    const b = await join2('beta-one', repoB);
    const b2 = await join2('beta-two', repoB);
    const c = await join2('gamma-one', repoC);
    const { ref } = await a.client.call<{ ref: string }>('blob.put', { text: 'secret', media_type: 'text/plain' });
    await expect(b.client.call('blob.get', { ref })).rejects.toMatchObject({ code: 'not_found' });
    await expect(send(b, 'beta-two', { attachments: [ref] })).rejects.toMatchObject({ code: 'not_found' });
    const o = await owner();
    expect(await o.client.call('blob.get', { ref })).toMatchObject({ text: 'secret' });
    await o.client.call('owner.link', { a: repoA, b: repoB });
    await send(a, 'beta-one', { attachments: [ref] });
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    expect(await b.client.call('blob.get', { ref })).toMatchObject({ text: 'secret' });
    expect(await b2.client.call('blob.get', { ref })).toMatchObject({ text: 'secret' });
    await expect(c.client.call('blob.get', { ref })).rejects.toMatchObject({ code: 'not_found' });
    // storing the same content from C (dedup) makes it readable in C
    await c.client.call('blob.put', { text: 'secret', media_type: 'text/plain' });
    expect(await c.client.call('blob.get', { ref })).toMatchObject({ text: 'secret' });
  });
});

describe('workspace scoping fix round 1 (R42): provenance authorization, takeover, sweep', () => {
  const offline = (sessionId: string) => until(() => getSession(broker.db, sessionId)?.state === 'offline');
  const inboxIds = async (c: { client: Client }) =>
    (await c.client.call<{ messages: Array<{ message: { id: string } }> }>('msg.inbox', {})).messages.map(
      (m) => m.message.id,
    );

  it('C1: a never-held name claimed out of scope sees nothing: stuck, empty inbox, ack no-op, blob denied', async () => {
    const a = await join2('alpha-one', repoA);
    const { ref } = await a.client.call<{ ref: string }>('blob.put', { text: 'secret', media_type: 'text/plain' });
    const { id } = await send(a, 'never-one', { attachments: [ref] });
    const b = await join2('never-one', repoB);
    expect(stateOf(id, 'never-one')?.state).toBe('stuck');
    expect(await inboxIds(b)).toEqual([]);
    expect(await b.client.call('msg.ack', { ids: [id] })).toEqual({ acked: 0 });
    expect(stateOf(id, 'never-one')?.state).toBe('stuck');
    await expect(b.client.call('blob.get', { ref })).rejects.toMatchObject({ code: 'not_found' });
    expect(b.pushes).toHaveLength(0);
  });

  it('A: an offline name cannot be taken over from another scope (hello falls back, register refuses)', async () => {
    const w = await join2('worker-one', repoA);
    w.client.close();
    await offline(w.welcome.session_id);
    const text = `Name "worker-one" belongs to an offline session in workspace ${label(repoA)}; the owner can link workspaces or you can pick another name`;
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'worker-one', cwd: repoB });
    closers.push(() => c.client.close());
    expect(c.welcome.name).not.toBe('worker-one');
    expect((c.welcome as { warning?: string }).warning).toContain(text);
    const err = await c.client.call('session.register', { name: 'worker-one' }).then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    expect(err).toMatchObject({ code: 'name_taken', message: text });
    expect((err as { data?: unknown }).data).toBeUndefined(); // final m-5: no out-of-scope session id
    // same workspace (another worktree) may take it over
    const same = await join2('worker-one', gitWorktree(repoA));
    expect(same.welcome.name).toBe('worker-one');
  });

  it('a live name in another scope is refused without its session id or cwd; in scope they are shown (final m-5)', async () => {
    const w = await join2('worker-one', join(repoA, 'sub'));
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'worker-one', cwd: repoB });
    closers.push(() => c.client.close());
    const warning = (c.welcome as { warning?: string }).warning ?? '';
    expect(warning).toMatch(/held by a live session in another workspace/);
    expect(warning).not.toContain(w.welcome.session_id);
    const err = await c.client.call('session.register', { name: 'worker-one' }).then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    expect(err).toMatchObject({ code: 'name_taken' });
    expect(err.message).not.toContain(w.welcome.session_id);
    expect(err.message).not.toContain(repoA);
    expect((err as { data?: unknown }).data).toBeUndefined();
    const same = await mcpClient(home, { agent: 'codex', requested_name: 'other-one', cwd: gitWorktree(repoA) });
    closers.push(() => same.client.close());
    const inScope = await same.client.call('session.register', { name: 'worker-one' }).then(
      () => new Error('resolved'),
      (e: Error) => e,
    );
    expect(inScope).toMatchObject({ code: 'name_taken', data: { holder_session_id: w.welcome.session_id } });
    expect(inScope.message).toContain(w.welcome.session_id);
  });

  it('C2: a same-scope unbound Codex claim sweeps a cross-scope held message to stuck; blob denied', async () => {
    const w = await join2('worker-one', repoA);
    w.client.close();
    await offline(w.welcome.session_id);
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const b = await join2('beta-one', repoB);
    const { ref } = await b.client.call<{ ref: string }>('blob.put', { text: 'b-secret', media_type: 'text/plain' });
    const { id } = await send(b, 'worker-one', { attachments: [ref] });
    expect(stateOf(id, 'worker-one')).toMatchObject({ state: 'held', hold_reason: 'offline' });
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'worker-one', cwd: repoA });
    closers.push(() => c.client.close());
    expect(c.welcome.name).toBe('worker-one');
    expect(stateOf(id, 'worker-one')?.state).toBe('stuck');
    expect(await inboxIds(c)).toEqual([]);
    await expect(c.client.call('blob.get', { ref })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('C3: a KV notice queued while linked is not delivered to its holder after unlink', async () => {
    const w = await join2('watch-one', repoA);
    await w.client.call('kv.watch', { prefix: 'k/', priority: 'normal' });
    w.client.close();
    await offline(w.welcome.session_id);
    const early = await mcpClient(home, { requested_name: 'watch-one', cwd: repoB });
    closers.push(() => early.client.close());
    expect(early.welcome.name).not.toBe('watch-one');
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const b = await join2('watch-one', repoB);
    b.client.close();
    await offline(b.welcome.session_id);
    const a = await join2('alpha-one', repoA);
    await a.client.call('kv.cas', { key: 'k/x', expected_version: null, value: 1 });
    const notice = broker.db.prepare(`SELECT id, from_workspace FROM messages WHERE to_target = 'watch-one'`).get() as {
      id: string;
      from_workspace: string;
    };
    expect(notice.from_workspace).toBe(join(label(repoA), '.git'));
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    const again = await mcpClient(home, { cwd: repoB, resume_session_id: b.welcome.session_id });
    closers.push(() => again.client.close());
    expect(again.welcome.name).toBe('watch-one');
    expect(stateOf(notice.id, 'watch-one')?.state).toBe('stuck');
    expect(await inboxIds(again)).toEqual([]);
    expect(again.pushes).toHaveLength(0);
  });

  it('C4 + I1: an out-of-scope holder sees no requests; reply/respond on out-of-scope originals are not_found', async () => {
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const asker = await join2('asker-one', repoA);
    const helper = await join2('helper-one', repoB);
    const { request_id, message_id } = await asker.client.call<{ request_id: string; message_id: string }>(
      'req.request',
      { to: 'helper-one', subject: 'q', body: '?' },
    );
    asker.client.close();
    await offline(asker.welcome.session_id);
    const taker = await join2('asker-one', repoB); // in scope while linked
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    expect(await taker.client.call('req.list', {})).toEqual({ requests: [] });
    expect(await helper.client.call('req.list', {})).toEqual({ requests: [] });
    await expect(taker.client.call('req.await', { request_id, wait_s: 0 })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(helper.client.call('req.respond', { request_id, body: 'x', status: 'ok' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(helper.client.call('msg.reply', { msg_id: message_id, body: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(taker.pushes).toHaveLength(0);
  });
});

describe('workspace scoping security round 2 (R46)', () => {
  afterEach(() => {
    delete process.env.FAKE_CODEX_SLEEP_MS;
  });
  const offline = (sessionId: string) => until(() => getSession(broker.db, sessionId)?.state === 'offline');
  const inboxIds = async (c: { client: Client }) =>
    (await c.client.call<{ messages: Array<{ message: { id: string } }> }>('msg.inbox', {})).messages.map(
      (m) => m.message.id,
    );
  const grants = (ref: string) =>
    (
      broker.db.prepare('SELECT workspace FROM blob_scopes WHERE ref = ? ORDER BY workspace').all(ref) as Array<{
        workspace: string;
      }>
    ).map((r) => r.workspace);
  const ws = (repo: string) => join(label(repo), '.git');
  const codex = async (name: string, cwd: string, thread?: string) => {
    const c = await mcpClient(home, { agent: 'codex', requested_name: name, cwd });
    closers.push(() => c.client.close());
    if (thread) await c.client.call('session.bind', { agent_session_id: thread });
    return c;
  };
  const deliveryTo = (recipient: string) =>
    broker.db
      .prepare('SELECT message_id FROM deliveries WHERE recipient = ? ORDER BY message_id DESC')
      .get(recipient) as { message_id: string } | undefined;
  async function hookClient() {
    const { client } = await Client.connect(
      sockPath(home),
      { protocol: 1, role: 'hook' },
      frameLimit(loadConfig(home)),
    );
    closers.push(() => client.close());
    return client;
  }

  it('N1: a push that completes after its name changed hands stays stuck and grants nothing', async () => {
    process.env.FAKE_CODEX_SLEEP_MS = '1200';
    const w = await codex('worker-one', repoA, 'thread-a');
    const a = await join2('alpha-one', repoA);
    const { ref } = await a.client.call<{ ref: string }>('blob.put', { text: 'n1-secret', media_type: 'text/plain' });
    const sending = send(a, 'worker-one', { attachments: [ref] });
    await until(() => deliveryTo('worker-one') !== undefined);
    const id = (deliveryTo('worker-one') as { message_id: string }).message_id;
    await w.client.call('session.register', { name: 'worker-two' });
    const b = await join2('worker-one', repoB);
    expect(stateOf(id, 'worker-one')?.state).toBe('stuck');
    await sending;
    expect(stateOf(id, 'worker-one')?.state).toBe('stuck');
    expect(grants(ref)).toEqual([ws(repoA)]);
    await expect(b.client.call('blob.get', { ref })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('N2 (after final I-7): respond/reply return before the slow push, so a later unlink cannot interleave with them', async () => {
    // Before I-7, respond/reply awaited the push, and an unlink landing during that await had to be caught by
    // stillMine. Dispatch is now detached and sendMessage has no await, so the original is marked read in the same
    // turn as the response is committed, while the link still exists; the unlink can only come after.
    process.env.FAKE_CODEX_SLEEP_MS = '800';
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const asker = await codex('asker-one', repoA, 'thread-asker');
    const helper = await codex('helper-one', repoB); // unbound: its deliveries stay held
    const { ref } = await asker.client.call<{ ref: string }>('blob.put', { text: 'n2', media_type: 'text/plain' });
    const { request_id, message_id } = await asker.client.call<{ request_id: string; message_id: string }>(
      'req.request',
      { to: 'helper-one', subject: 'q', body: '?', attachments: [ref] },
    );
    expect(stateOf(message_id, 'helper-one')?.state).toBe('held');
    const t0 = Date.now();
    await helper.client.call('req.respond', { request_id, body: 'r', status: 'ok' });
    expect(Date.now() - t0).toBeLessThan(800); // did not wait for the 800 ms codex push
    expect(stateOf(message_id, 'helper-one')?.state).toBe('read');
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    expect(stateOf(message_id, 'helper-one')?.state).toBe('read');

    await o.client.call('owner.link', { a: repoA, b: repoB });
    const orig = await send(asker, 'helper-one');
    const t1 = Date.now();
    await helper.client.call('msg.reply', { msg_id: orig.id, body: 'r' });
    expect(Date.now() - t1).toBeLessThan(800);
    expect(stateOf(orig.id, 'helper-one')?.state).toBe('read');
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    expect(stateOf(orig.id, 'helper-one')?.state).toBe('read');
  });

  it('N3: stuck and expiry notices keep the original provenance; a reused sender name in B does not see them', async () => {
    const a = await join2('sender-one', repoA);
    await send(a, 'late-one');
    await a.client.call('req.request', { to: 'late-two', subject: 'q', body: '?', expires_in_s: 1 });
    await a.client.call('session.register', { name: 'sender-two' });
    const b = await join2('sender-one', repoB);
    await join2('late-one', repoC);
    const notices = () =>
      broker.db
        .prepare(`SELECT subject, from_workspace FROM messages WHERE from_name = 'wigwag' AND to_target = 'sender-one'`)
        .all() as Array<{ subject: string; from_workspace: string | null }>;
    await until(() => notices().length === 2);
    expect(notices().map((n) => n.from_workspace)).toEqual([ws(repoA), ws(repoA)]);
    expect(await inboxIds(b)).toEqual([]);
  });

  it('N4: a hook whose cwd is in another workspace is not bound and gets no digest', async () => {
    const a = await mcpClient(home, { requested_name: 'alpha-one', cwd: repoA, mcp_ppid: 4242, pid_chain: [4242, 1] });
    closers.push(() => a.client.close());
    const c = await mcpClient(home, { requested_name: 'gamma-one', cwd: repoA, mcp_ppid: 5151, pid_chain: [5151, 1] });
    closers.push(() => c.client.close());
    const s = await join2('sender-one', repoA);
    const h = await hookClient();
    // The hook runs under the session's claude process (agent_pid), so only the cwd check can refuse it.
    const ev = (agent_session_id: string, event: string, cwd: string, agent_pid: number) =>
      h.call<{ bound: boolean; additional_context: string | null }>('hook.event', {
        agent: 'claude',
        event,
        agent_session_id,
        cwd,
        pid_chain: [9, agent_pid],
        agent_pid,
      });
    expect(await ev('sess-a', 'SessionStart', join(repoA, 'sub'), 4242)).toMatchObject({ bound: true });
    await send(s, 'alpha-one', { priority: 'low', body: 'digest me' });
    expect(await ev('sess-a', 'UserPromptSubmit', repoB, 4242)).toEqual({ bound: false, additional_context: null });
    expect(await ev('sess-c', 'SessionStart', repoB, 5151)).toEqual({ bound: false, additional_context: null });
    expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBeNull();
    const ok = await ev('sess-a', 'UserPromptSubmit', repoA, 4242);
    expect(ok.additional_context).toContain('digest me');
  });

  it('N5: unread counts only deliveries the holder can see', async () => {
    const a = await join2('alpha-one', repoA);
    await send(a, 'never-one');
    const b = await join2('never-one', repoB);
    expect(await b.client.call('session.whoami')).toMatchObject({ unread: 0 });
    const o = await owner();
    const all = await o.client.call<Array<{ name: string; unread: number }>>('session.who', {});
    expect(all.find((s) => s.name === 'never-one')?.unread).toBe(0);
  });

  it('C4: req.list hides an out-of-scope response id', async () => {
    const o = await owner();
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const asker = await join2('asker-one', repoA);
    const helper = await join2('helper-one', repoB);
    const { request_id } = await asker.client.call<{ request_id: string }>('req.request', {
      to: 'helper-one',
      subject: 'q',
      body: '?',
    });
    await helper.client.call('req.respond', { request_id, body: 'r', status: 'ok' });
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    const { requests } = await asker.client.call<{ requests: Array<{ response_id: string | null }> }>('req.list', {});
    expect(requests).toHaveLength(1);
    expect(requests[0].response_id).toBeNull();
  });

  it('C4: req.await re-checks the request after waiting', async () => {
    const o = await owner();
    const asker2 = await join2('asker-two', repoA);
    await join2('helper-two', repoA);
    const second = await asker2.client.call<{ request_id: string }>('req.request', {
      to: 'helper-two',
      subject: 'q2',
      body: '?',
    });
    asker2.client.close();
    await offline(asker2.welcome.session_id);
    await o.client.call('owner.link', { a: repoA, b: repoB });
    const taker = await join2('asker-two', repoB);
    const waiting = taker.client.call('req.await', { request_id: second.request_id, wait_s: 2 });
    await new Promise((r) => setTimeout(r, 300));
    await o.client.call('owner.unlink', { a: repoA, b: repoB });
    await expect(waiting).rejects.toMatchObject({ code: 'not_found' });
  });
});
