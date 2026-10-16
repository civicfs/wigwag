import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Connection } from '../../src/broker/connection.js';
import type { RenderItem } from '../../src/broker/render.js';
import type { SessionRow } from '../../src/store/sessions.js';
import { ClaudeChannelTransport } from '../../src/transports/claude-channel.js';
import { CODEX_ARG_BUDGET_BYTES, CodexQueueTransport } from '../../src/transports/codex-queue.js';
import { FAKE_CODEX, tmpHome } from '../helpers.js';

const session = (o: Partial<SessionRow> = {}): SessionRow => ({
  id: 'ses-01j0000000000000000000000a',
  name: 'codex-merger',
  agent: 'codex',
  agent_session_id: 'thread-1',
  cwd: '/w',
  workspace: '/w',
  pid_chain: [],
  mcp_ppid: null,
  state: 'online-idle',
  transport: 'codex-queue',
  spawned_by: null,
  launch_json: null,
  created_at: '',
  last_seen_at: '',
  name_source: 'custom',
  native_name: null,
  native_ref: null,
  conn_generation: 0,
  retired_at: null,
  retired_into: null,
  link: 'connected',
  parent_state: 'unknown',
  agent_pid: null,
  agent_start: null,
  parent_checked_at: null,
  codex_push_reason: null,
  ...o,
});
const items = (n: number, body = 'hello'): RenderItem[] =>
  Array.from({ length: n }, (_, i) => ({
    msg: {
      id: `msg-01j00000000000000000000${String(i).padStart(3, '0')}`,
      from_name: 'claude-main',
      from_workspace: null,
      to_target: 'codex-merger',
      kind: 'message',
      priority: 'normal',
      subject: `s${i}`,
      body,
      attachments: [],
      reply_to: null,
      request_id: null,
      expires_at: null,
      stream: null,
      created_at: '',
    },
    attachments: [],
  }));

afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_MODE;
});

describe('bounded Claude channel batches', () => {
  it('splits backlogs into bounded pushes and acknowledges every original item once', async () => {
    const pushed: Array<{ content: string }> = [];
    const acked: RenderItem[] = [];
    const conn = {
      event: (_name: string, data: { content: string }) => {
        pushed.push(data);
        return true;
      },
    } as Connection;
    const t = new ClaudeChannelTransport(() => conn);
    const original = items(46, 'body '.repeat(200));
    await t.push(session({ agent: 'claude' }), original, { onPushed: (batch) => acked.push(...batch) });
    expect(pushed.length).toBeGreaterThan(1);
    for (const p of pushed) expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(12000);
    expect(acked.map((x) => x.msg.id)).toEqual(original.map((x) => x.msg.id));
  });
  it('preserves the native answer hint when referencing oversized questions', async () => {
    const pushed: Array<{ content: string }> = [];
    const conn = {
      event: (_name: string, data: { content: string }) => {
        pushed.push(data);
        return true;
      },
    } as Connection;
    const [item] = items(1, 'x'.repeat(30000));
    item.nativeQuestion = true;
    item.msg.kind = 'request';
    item.msg.request_id = 'req-native';
    await new ClaudeChannelTransport(() => conn).push(session({ agent: 'claude' }), [item]);
    expect(pushed[0].content).toContain('question_answer tool, relay_id req-native');
    expect(pushed[0].content).not.toContain('respond tool');
  });
  it('references a single oversized body explicitly instead of emitting an oversized channel payload', async () => {
    const pushed: Array<{ content: string }> = [];
    const conn = {
      event: (_name: string, data: { content: string }) => {
        pushed.push(data);
        return true;
      },
    } as Connection;
    await new ClaudeChannelTransport(() => conn).push(session({ agent: 'claude' }), items(1, 'x'.repeat(30000)));
    expect(Buffer.byteLength(JSON.stringify(pushed[0]))).toBeLessThanOrEqual(12000);
    expect(pushed[0].content).toContain('read_message');
  });
});

describe('CodexQueueTransport', () => {
  it('fails closed without evidence and rechecks every chunk before executing queue', async () => {
    const log = join(tmpHome(), 'queue-trust.jsonl');
    process.env.FAKE_CODEX_LOG = log;
    await expect(new CodexQueueTransport(FAKE_CODEX, 5000).push(session(), items(1))).rejects.toMatchObject({
      data: { hold_reason: 'codex-untrusted' },
    });
    expect(existsSync(log)).toBe(false);
    let checks = 0;
    const acked: RenderItem[] = [];
    const transport = new CodexQueueTransport(FAKE_CODEX, 5000, async () =>
      ++checks === 1 ? null : 'descendant-loaded',
    );
    await expect(
      transport.push(session(), items(3, 'x'.repeat(60000)), { onPushed: (part) => acked.push(...part) }),
    ).rejects.toMatchObject({ data: { hold_reason: 'codex-untrusted' } });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(acked).toHaveLength(1);
    expect(checks).toBe(2);
  });
  it('runs codex queue --thread <id> --message <text>', async () => {
    const log = join(tmpHome(), 'calls.jsonl');
    process.env.FAKE_CODEX_LOG = log;
    await new CodexQueueTransport(FAKE_CODEX, 5000, async () => null).push(session(), items(1));
    const [call] = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(call.argv.slice(0, 4)).toEqual(['queue', '--thread', 'thread-1', '--message']);
    expect(call.argv[4]).toMatch(/\[wigwag\]/);
  });
  it('splits a digest larger than the argv budget into sequential calls', async () => {
    const log = join(tmpHome(), 'calls.jsonl');
    process.env.FAKE_CODEX_LOG = log;
    const big = 'x'.repeat(Math.floor(CODEX_ARG_BUDGET_BYTES / 3));
    await new CodexQueueTransport(FAKE_CODEX, 5000, async () => null).push(session(), items(5, big));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      const bytes = Buffer.byteLength(JSON.parse(c).argv[4], 'utf8');
      expect(bytes).toBeLessThanOrEqual(CODEX_ARG_BUDGET_BYTES);
      expect(bytes).toBeLessThan(128 * 1024); // Linux single-argument ceiling, including the NUL terminator.
    }
  });
  it('rejects an item over the argv budget without sending anything', async () => {
    const log = join(tmpHome(), 'calls.jsonl');
    process.env.FAKE_CODEX_LOG = log;
    const t = new CodexQueueTransport(FAKE_CODEX, 5000, async () => null);
    await expect(
      t.push(session(), [...items(1), ...items(1, 'x'.repeat(CODEX_ARG_BUDGET_BYTES))]),
    ).rejects.toMatchObject({
      code: 'transport',
      message: expect.stringMatching(/over the codex argv budget/),
    });
    expect(existsSync(log)).toBe(false);
  });
  it('normalizes synchronous execFile throws (NUL byte) without quoting the argument', async () => {
    const err = await new CodexQueueTransport(FAKE_CODEX, 5000, async () => null)
      .push(session(), items(1, 'SECRET\u0000b'))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'transport' });
    expect((err as Error).message).not.toMatch(/SECRET|--message/);
  });
  it('chunks multibyte bodies near the budget: every id once, in order, body intact', async () => {
    const log = join(tmpHome(), 'calls.jsonl');
    process.env.FAKE_CODEX_LOG = log;
    const body = 'é✓'.repeat(Math.floor(CODEX_ARG_BUDGET_BYTES / 6 / 2));
    const its = items(4, body);
    await new CodexQueueTransport(FAKE_CODEX, 5000, async () => null).push(session(), its);
    const argvs: string[] = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).argv[4]);
    expect(argvs.length).toBeGreaterThan(1);
    const joined = argvs.join('\n');
    const seen = its.map((i) => joined.split(`--- ${i.msg.id} `).length - 1);
    expect(seen).toEqual([1, 1, 1, 1]);
    const order = its.map((i) => joined.indexOf(`--- ${i.msg.id} `));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(joined.split(body).length - 1).toBe(4);
    for (const a of argvs) expect(Buffer.byteLength(a, 'utf8')).toBeLessThanOrEqual(CODEX_ARG_BUDGET_BYTES);
  });
  it('rejects with stderr metadata on failure, and when unbound or the binary is missing', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const failed = await new CodexQueueTransport(FAKE_CODEX, 5000, async () => null)
      .push(session(), items(1, 'SECRET body'))
      .catch((e: unknown) => e);
    expect(failed).toMatchObject({
      code: 'transport',
      message: expect.stringMatching(/exit code 3; stderr omitted \(\d+ bytes\)/),
    });
    expect((failed as Error).message).not.toMatch(/SECRET|--message|thread-1/);
    await expect(
      new CodexQueueTransport(FAKE_CODEX, 5000, async () => null).push(session({ agent_session_id: null }), items(1)),
    ).rejects.toMatchObject({ code: 'unbound' });
    await expect(
      new CodexQueueTransport('/nonexistent/codex', 5000, async () => null).push(session(), items(1)),
    ).rejects.toMatchObject({
      code: 'transport',
      message: expect.stringMatching(/ENOENT/),
    });
  });
});

describe('ClaudeChannelTransport', () => {
  it('writes a push event to the live connection, rejects when there is none', async () => {
    const sent: unknown[] = [];
    const conn = { event: (name: string, data: unknown) => sent.push({ name, data }) > 0 } as unknown as Connection;
    const t = new ClaudeChannelTransport((id) => (id === 'ses-01j0000000000000000000000a' ? conn : undefined));
    await t.push(session({ agent: 'claude' }), items(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'push', data: { meta: { from: 'claude-main' } } });
    await expect(t.push(session({ id: 'ses-other' }), items(1))).rejects.toMatchObject({ code: 'transport' });
  });

  it('refuses to push to a connection whose client has no channel (E-3), so the push is never recorded as delivered', async () => {
    const sent: unknown[] = [];
    const conn = {
      channel: false,
      event: (name: string, data: unknown) => sent.push({ name, data }) > 0,
    } as unknown as Connection;
    const t = new ClaudeChannelTransport(() => conn);
    expect(t.hasChannel(session({ agent: 'claude' }))).toBe(false);
    await expect(t.push(session({ agent: 'claude' }), items(1))).rejects.toMatchObject({ code: 'transport' });
    expect(sent).toHaveLength(0);
  });
});
