import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { configPath } from '../../src/config.js';
import { getSession } from '../../src/store/sessions.js';
import {
  BOUND_SLACK_MS,
  DIST_MAIN,
  type FakeClaude,
  fakeClaude,
  launcher,
  mcpClient,
  STARTED_PRELOAD,
  startTestBroker,
  tmpHome,
  WAIT_MS,
} from '../helpers.js';

// Async on purpose: the broker runs in this process, so a blocking spawnSync would deadlock the hook.
// The child is killed after a bounded wait so a hung hook fails the test instead of hanging the suite.
// `ms` runs from the moment node is executing the hook (fixtures/started.mjs), not from the spawn call: fork/exec of a
// cold node is outside the hook's own deadline and stalls for seconds under load. `waitMs` is only the hang cap.
const runHook = (
  home: string,
  event: string,
  stdin: string | Buffer | null,
  waitMs = WAIT_MS,
): Promise<{ status: number | null; stdout: string; ms: number }> =>
  new Promise((resolve) => {
    let startedAt = Date.now();
    const child = spawn(process.execPath, ['--import', STARTED_PRELOAD, DIST_MAIN, 'hook', 'claude', event], {
      env: { ...process.env, WIGWAG_HOME: home },
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    });
    child.stdio[3]?.once('data', () => {
      startedAt = Date.now();
    });
    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stdin?.on('error', () => {});
    const killer = setTimeout(() => child.kill('SIGKILL'), waitMs);
    child.on('close', (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, ms: Date.now() - startedAt });
    });
    if (stdin !== null) child.stdin?.end(stdin); // null: leave stdin open, never EOF
  });

const DEADLINE_MS = 500;
const setHooks = (home: string, hooks: { deadline_ms?: number; max_stdin_bytes?: number }) => {
  const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
  Object.assign(cfg.hooks, hooks);
  writeFileSync(configPath(home), JSON.stringify(cfg, null, 2));
};
const hooksLog = (home: string) => {
  const log = join(home, 'logs', 'hooks.log');
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
};

let broker: Broker | null = null;
afterEach(async () => {
  await broker?.stop();
  broker = null;
});

// Live fake `claude` processes (tests/fixtures/fake-claude.mjs); a hook binds only under its own claude process.
const trees: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const t of trees.splice(0)) await t.stop();
});
const startClaude = async (exe?: string) => {
  const c = await fakeClaude(exe);
  trees.push(c);
  return c;
};
/**
 * Runs the real hook command as a child of `agent`, as Claude Code does; `via` is an argv prefix that puts a shell or
 * launcher between the agent and the hook.
 */
const hookIn = (agent: FakeClaude, home: string, event: string, session_id: string, via: string[] = []) =>
  agent.run(
    [...via, process.execPath, DIST_MAIN, 'hook', 'claude', event],
    // Spec §17 (R46-N4): the hook's cwd must be in the session's workspace (mcpClient's default cwd).
    JSON.stringify({ session_id, cwd: '/w/myproject', hook_event_name: event }),
    { WIGWAG_HOME: home },
  );

describe('claude hook command', () => {
  it('SessionStart binds via the pid chain and returns additionalContext', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    // The MCP server is a child of the claude process that also runs the hook.
    const a = await mcpClient(started.home, { requested_name: 'claude-main', mcp_ppid: claude.pid });
    const r = await hookIn(claude, started.home, 'SessionStart', 'cs-1');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/registered as "claude-main"/);
    a.client.close();
  });

  it('is not bound by chain membership alone: an MCP parent above the hook agent never matches', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    // This test process is in the hook's chain, above the hook's agent; the old rule (mcp_ppid in the chain) bound it.
    const a = await mcpClient(started.home, { requested_name: 'claude-main', mcp_ppid: process.pid });
    const r = await hookIn(claude, started.home, 'SessionStart', 'cs-1');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(getSession(started.broker.db, a.welcome.session_id)?.agent_session_id).toBeNull();
    a.client.close();
  });

  it('prints nothing and exits 0 when the broker is down', async () => {
    const home = tmpHome();
    const r = await runHook(home, 'PostToolUse', JSON.stringify({ session_id: 'cs-1', cwd: '/w' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('prints nothing, exits 0, and logs on malformed input', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const r = await runHook(started.home, 'UserPromptSubmit', '{not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const log = join(started.home, 'logs', 'hooks.log');
    expect(existsSync(log) && readFileSync(log, 'utf8')).toMatch(/UserPromptSubmit/);
  });

  it('exits 0 within the deadline when the broker accepts but never replies', async () => {
    const home = tmpHome();
    setHooks(home, { deadline_ms: DEADLINE_MS });
    const server = createServer(() => {});
    await new Promise<void>((r) => server.listen(sockPath(home), r));
    try {
      const r = await runHook(home, 'SessionStart', JSON.stringify({ session_id: 'cs-1', cwd: '/w' }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms).toBeLessThan(DEADLINE_MS + BOUND_SLACK_MS);
      expect(hooksLog(home)).toMatch(/SessionStart: deadline exceeded/);
    } finally {
      server.close();
    }
  });

  it('exits 0 within the deadline when stdin never reaches EOF', async () => {
    const home = tmpHome();
    setHooks(home, { deadline_ms: DEADLINE_MS });
    const r = await runHook(home, 'SessionStart', null);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(DEADLINE_MS + BOUND_SLACK_MS);
    expect(hooksLog(home)).toMatch(/deadline exceeded/);
  });

  it('stops reading and logs when stdin exceeds max_stdin_bytes', async () => {
    const home = tmpHome();
    setHooks(home, { max_stdin_bytes: 1024 });
    const r = await runHook(home, 'PostToolUse', Buffer.alloc(1025, 0x20));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(hooksLog(home)).toMatch(/stdin exceeds 1024 bytes/);
  });

  it('empty stdin exits 0 with a log line', async () => {
    const home = tmpHome();
    const r = await runHook(home, 'SessionStart', '');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(hooksLog(home)).toMatch(/SessionStart: empty hook input/);
  });

  it('UserPromptSubmit delivers held low messages as a digest; Stop prints nothing', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    const a = await mcpClient(started.home, { requested_name: 'claude-main', mcp_ppid: claude.pid });
    await hookIn(claude, started.home, 'SessionStart', 'cs-2');
    const sender = await mcpClient(started.home, { requested_name: 'peer-sender', mcp_ppid: 1 });
    await sender.client.call('msg.send', {
      to: 'claude-main',
      subject: 'fyi',
      body: 'LOW-TOKEN-7',
      priority: 'low',
      attachments: [],
    });
    const stop = await hookIn(claude, started.home, 'Stop', 'cs-2');
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe('');
    const r = await hookIn(claude, started.home, 'UserPromptSubmit', 'cs-2');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('LOW-TOKEN-7');
    sender.client.close();
    a.client.close();
  });
});

// E-3 cold start: the SessionStart hook runs before the MCP server registers, finds 0 candidates and returns nothing.
// The first prompt or tool call that binds hands over the same context, once.
describe('claude hook cold start (E-3 SessionStart context)', () => {
  const ctxOf = (stdout: string): string | null =>
    stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput.additionalContext;
  const send = async (home: string, to: string, priority: string) => {
    const sender = await mcpClient(home, { requested_name: 'peer-sender', mcp_ppid: 1 });
    await sender.client.call('msg.send', { to, subject: 'fyi', body: 'COLD-TOKEN', priority, attachments: [] });
    sender.client.close();
  };

  it('delivers the SessionStart context once, at the first prompt that binds after a 0-candidate SessionStart', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    const early = await hookIn(claude, started.home, 'SessionStart', 'cs-cold');
    expect(early.stdout).toBe('');
    const a = await mcpClient(started.home, { requested_name: 'cold-one', mcp_ppid: claude.pid, channel: false });
    await send(started.home, 'cold-one', 'low');
    const first = ctxOf((await hookIn(claude, started.home, 'UserPromptSubmit', 'cs-cold')).stdout);
    expect(first).toMatch(/registered as "cold-one"/);
    // The digest in this same context delivers the low message, which therefore no longer counts as unread.
    expect(first).not.toMatch(/unread/);
    expect(first).toMatch(/did not load the wigwag channel/);
    expect(first).toContain('COLD-TOKEN');
    const second = ctxOf((await hookIn(claude, started.home, 'UserPromptSubmit', 'cs-cold')).stdout);
    expect(second ?? '').not.toMatch(/registered as/);
    const tool = ctxOf((await hookIn(claude, started.home, 'PostToolUse', 'cs-cold')).stdout);
    expect(tool ?? '').not.toMatch(/registered as/);
    a.client.close();
  });

  it('also delivers it at a PostToolUse that binds first, without the no-channel note when the channel loaded', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    await hookIn(claude, started.home, 'SessionStart', 'cs-cold2');
    const a = await mcpClient(started.home, { requested_name: 'cold-two', mcp_ppid: claude.pid, channel: true });
    const first = ctxOf((await hookIn(claude, started.home, 'PostToolUse', 'cs-cold2')).stdout);
    expect(first).toMatch(/registered as "cold-two"/);
    expect(first).not.toMatch(/did not load the wigwag channel/);
    expect(first).not.toMatch(/unread/);
    expect(ctxOf((await hookIn(claude, started.home, 'UserPromptSubmit', 'cs-cold2')).stdout) ?? '').not.toMatch(
      /registered as/,
    );
    a.client.close();
  });

  it('warm start is unchanged: SessionStart carries the context and the first prompt does not repeat it', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    const a = await mcpClient(started.home, { requested_name: 'warm-one', mcp_ppid: claude.pid });
    const start = ctxOf((await hookIn(claude, started.home, 'SessionStart', 'cs-warm')).stdout);
    expect(start).toMatch(/registered as "warm-one"/);
    const prompt = ctxOf((await hookIn(claude, started.home, 'UserPromptSubmit', 'cs-warm')).stdout);
    expect(prompt ?? '').not.toMatch(/registered as/);
    a.client.close();
  });

  it('does not repeat after a later SessionStart on the same session id succeeds', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    await hookIn(claude, started.home, 'SessionStart', 'cs-cold3');
    const a = await mcpClient(started.home, { requested_name: 'cold-three', mcp_ppid: claude.pid });
    const start = ctxOf((await hookIn(claude, started.home, 'SessionStart', 'cs-cold3')).stdout);
    expect(start).toMatch(/registered as "cold-three"/);
    const prompt = ctxOf((await hookIn(claude, started.home, 'UserPromptSubmit', 'cs-cold3')).stdout);
    expect(prompt ?? '').not.toMatch(/registered as/);
    a.client.close();
  });

  it('a nested cold start is never bound to the outer session and owes the outer nothing', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const outer = await startClaude();
    const inner = await outer.nest();
    const o = await mcpClient(started.home, { requested_name: 'outer-one', mcp_ppid: outer.pid });
    expect((await hookIn(inner, started.home, 'SessionStart', 'cs-inner')).stdout).toBe('');
    // The inner id is not bound to the outer even though the outer is the only live claude session.
    expect((await hookIn(inner, started.home, 'UserPromptSubmit', 'cs-inner')).stdout).toBe('');
    expect(getSession(started.broker.db, o.welcome.session_id)?.agent_session_id).toBeNull();
    const i = await mcpClient(started.home, { requested_name: 'inner-one', mcp_ppid: inner.pid });
    expect(ctxOf((await hookIn(inner, started.home, 'UserPromptSubmit', 'cs-inner')).stdout)).toMatch(
      /registered as "inner-one"/,
    );
    // The outer, whose SessionStart was never missed, gets no cold-start context at its first prompt.
    expect(ctxOf((await hookIn(outer, started.home, 'UserPromptSubmit', 'cs-outer')).stdout) ?? '').not.toMatch(
      /registered as/,
    );
    i.client.close();
    o.client.close();
  });
});

// E-4 nested: `claude -p` run from inside a live wigwag Claude session. The outer session's MCP parent (the outer
// claude) is in the inner hook's pid chain too, so chain membership alone bound the inner hook to the outer session.
describe('claude hook in a nested claude process tree (E-4 nested)', () => {
  const brokerLog = (home: string) => readFileSync(join(home, 'logs', 'broker.log'), 'utf8');
  const tree = async () => {
    const outer = await startClaude();
    const inner = await outer.nest();
    return { outer, inner };
  };

  it('does not bind the inner SessionStart to the outer session while the inner MCP server is not registered', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const { outer, inner } = await tree();
    const o = await mcpClient(started.home, { requested_name: 'outer-one', mcp_ppid: outer.pid });
    const r = await hookIn(inner, started.home, 'SessionStart', 'cs-inner');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(getSession(started.broker.db, o.welcome.session_id)?.agent_session_id).toBeNull();
    expect(brokerLog(started.home)).toMatch(/hook\.event SessionStart: .*not bound/);
    o.client.close();
  });

  it('binds the inner hook to the inner session once its MCP server is registered; the outer keeps its own', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const { outer, inner } = await tree();
    const o = await mcpClient(started.home, { requested_name: 'outer-one', mcp_ppid: outer.pid });
    const outerStart = await hookIn(outer, started.home, 'SessionStart', 'cs-outer');
    expect(JSON.parse(outerStart.stdout).hookSpecificOutput.additionalContext).toMatch(/registered as "outer-one"/);
    const i = await mcpClient(started.home, { requested_name: 'inner-one', mcp_ppid: inner.pid });
    const r = await hookIn(inner, started.home, 'UserPromptSubmit', 'cs-inner');
    expect(r.status).toBe(0);
    expect(getSession(started.broker.db, i.welcome.session_id)).toMatchObject({
      agent_session_id: 'cs-inner',
      state: 'online-busy',
    });
    expect(getSession(started.broker.db, o.welcome.session_id)).toMatchObject({
      agent_session_id: 'cs-outer',
      state: 'online-idle',
    });
    i.client.close();
    o.client.close();
  });

  it('a nested claude that reuses the outer session id (--continue) cannot drive the outer session', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const { outer, inner } = await tree();
    const o = await mcpClient(started.home, { requested_name: 'outer-one', mcp_ppid: outer.pid });
    await hookIn(outer, started.home, 'SessionStart', 'cs-outer');
    const r = await hookIn(inner, started.home, 'UserPromptSubmit', 'cs-outer');
    expect(r.stdout).toBe('');
    expect(getSession(started.broker.db, o.welcome.session_id)?.state).toBe('online-idle');
    expect(brokerLog(started.home)).toMatch(/hook\.event UserPromptSubmit: .*not bound/);
    o.client.close();
  });
});

// Spec §4: the hook's agent is its nearest ancestor that is not a shell or launcher, whatever that process is named. The
// Claude Code `--bg` session process is named after its version (`2.1.295`) and runs under a pty host and a daemon that
// are named `claude`; an npm-installed Claude Code runs as `node`.
describe('claude hook agent process, identified by position not by name', () => {
  const brokerLog = (home: string) => readFileSync(join(home, 'logs', 'broker.log'), 'utf8');
  const ctxOf = (stdout: string): string | null =>
    stdout === '' ? null : JSON.parse(stdout).hookSpecificOutput.additionalContext;
  // `exit $?` keeps the shell as the hook's parent instead of exec'ing the hook in its place.
  const SH = ['/bin/sh', '-c', '"$0" "$@"; exit $?'];
  /** `claude --bg`: daemon (`claude`) -> pty host (`claude`) -> the session process, named after the version. */
  const bgTree = async () => {
    const daemon = await startClaude();
    const ptyHost = await daemon.nest();
    const session = await ptyHost.nest('2.1.295');
    return { daemon, ptyHost, session };
  };

  it('binds a --bg session: the version-named process that spawned the MCP server and the hook', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const { ptyHost, session } = await bgTree();
    const a = await mcpClient(started.home, { requested_name: 'bg-one', mcp_ppid: session.pid });
    // A session whose MCP parent is the pty host above: the hook must stop at its own agent and never reach it.
    const decoy = await mcpClient(started.home, { requested_name: 'decoy-one', mcp_ppid: ptyHost.pid });
    const r = await hookIn(session, started.home, 'SessionStart', 'cs-bg', SH);
    expect(r.status).toBe(0);
    expect(ctxOf(r.stdout)).toMatch(/registered as "bg-one"/);
    expect(getSession(started.broker.db, a.welcome.session_id)?.agent_session_id).toBe('cs-bg');
    expect(getSession(started.broker.db, decoy.welcome.session_id)?.agent_session_id).toBeNull();
    decoy.client.close();
    a.client.close();
  });

  it('binds an npm-installed Claude Code that runs as node', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const agent = await startClaude('node');
    const a = await mcpClient(started.home, { requested_name: 'npm-one', mcp_ppid: agent.pid });
    expect(ctxOf((await hookIn(agent, started.home, 'SessionStart', 'cs-npm', SH)).stdout)).toMatch(
      /registered as "npm-one"/,
    );
    a.client.close();
  });

  it.each([
    ['a shell', SH],
    ['timeout', launcher('timeout')],
    ['env', launcher('env')],
    ['a shell running timeout', [...SH, ...launcher('timeout')]],
  ])('looks through %s between the agent and the hook', async (_label, via) => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    const a = await mcpClient(started.home, { requested_name: 'wrapped-one', mcp_ppid: claude.pid });
    expect(ctxOf((await hookIn(claude, started.home, 'SessionStart', 'cs-wrap', via)).stdout)).toMatch(
      /registered as "wrapped-one"/,
    );
    a.client.close();
  });

  it('fails closed on an unknown launcher between the agent and the hook instead of skipping past it', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const claude = await startClaude();
    // The agent above has exactly one session; skipping upward over `nice` would bind it.
    const a = await mcpClient(started.home, { requested_name: 'wrapped-one', mcp_ppid: claude.pid });
    const r = await hookIn(claude, started.home, 'SessionStart', 'cs-nice', launcher('nice'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(getSession(started.broker.db, a.welcome.session_id)?.agent_session_id).toBeNull();
    expect(brokerLog(started.home)).toMatch(/hook\.event SessionStart: 0 candidate sessions .*not bound/);
    a.client.close();
  });

  it('fails closed when two live sessions have the hook agent as their MCP parent', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const { session } = await bgTree();
    const a = await mcpClient(started.home, { requested_name: 'twin-one', mcp_ppid: session.pid });
    const b = await mcpClient(started.home, { requested_name: 'twin-two', mcp_ppid: session.pid });
    const r = await hookIn(session, started.home, 'SessionStart', 'cs-twin', SH);
    expect(r.stdout).toBe('');
    for (const x of [a, b]) expect(getSession(started.broker.db, x.welcome.session_id)?.agent_session_id).toBeNull();
    expect(brokerLog(started.home)).toMatch(/hook\.event SessionStart: 2 candidate sessions .*not bound/);
    b.client.close();
    a.client.close();
  });

  // E-4 nested under each layout, with the inner agent named as each install names it. The inner hook's agent is the
  // inner process, which has no session yet at its cold SessionStart: the hook must stop there, never at the outer.
  describe.each([
    ['a terminal session', 'claude', async () => ({ outer: await startClaude() })],
    ['a --bg session', '2.1.295', async () => ({ outer: (await bgTree()).session })],
  ])('nested claude -p under %s', (_label, _outerExe, outerOf) => {
    it.each(['claude', '2.1.295', 'node'])('an inner agent named %s never binds to the outer', async (innerExe) => {
      const started = await startTestBroker();
      broker = started.broker;
      const { outer } = await outerOf();
      const inner = await outer.nest(innerExe);
      const o = await mcpClient(started.home, { requested_name: 'outer-one', mcp_ppid: outer.pid });
      expect((await hookIn(inner, started.home, 'SessionStart', 'cs-inner', SH)).stdout).toBe('');
      expect((await hookIn(inner, started.home, 'UserPromptSubmit', 'cs-inner', SH)).stdout).toBe('');
      expect(getSession(started.broker.db, o.welcome.session_id)).toMatchObject({
        agent_session_id: null,
        state: 'online-idle',
      });
      // Once the inner MCP server is connected, the inner hook binds to it and not to the outer.
      const i = await mcpClient(started.home, { requested_name: 'inner-one', mcp_ppid: inner.pid });
      expect(ctxOf((await hookIn(inner, started.home, 'UserPromptSubmit', 'cs-inner', SH)).stdout)).toMatch(
        /registered as "inner-one"/,
      );
      expect(getSession(started.broker.db, o.welcome.session_id)?.agent_session_id).toBeNull();
      // The outer's own hook still binds the outer.
      expect(ctxOf((await hookIn(outer, started.home, 'SessionStart', 'cs-outer', SH)).stdout)).toMatch(
        /registered as "outer-one"/,
      );
      i.client.close();
      o.client.close();
    });
  });
});
