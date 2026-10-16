import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { vi } from 'vitest';
import { startBroker as assembleBroker } from '../src/broker/assemble.js';
import type { Broker } from '../src/broker/server.js';
import { sockPath } from '../src/client/autospawn.js';
import { Client } from '../src/client/client.js';
import { configPath, initHome, loadConfig } from '../src/config.js';
import { CodexNames, codexIndexPath } from '../src/native/codex-names.js';
import { noProcesses } from '../src/proc/identity.js';
import { frameLimit } from '../src/protocol/frame.js';
import type { Hello, PushData } from '../src/protocol/rpc.js';
import { listSessions } from '../src/store/sessions.js';

export const FAKE_CODEX = resolve(import.meta.dirname, 'fixtures/fake-codex.mjs');
export const STARTED_PRELOAD = resolve(import.meta.dirname, 'fixtures/started.mjs');
export const DIST_MAIN = resolve(import.meta.dirname, '../dist/main.js');

export function tmpHome(): string {
  // Short path: unix socket paths are limited to ~104 bytes on macOS.
  const home = join(mkdtempSync(join(tmpdir(), 'ww-')), 'h');
  initHome(home, FAKE_CODEX);
  const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
  cfg.retry.base_ms = 50;
  // These budgets count a cold node start of the spawned broker or hook (spawn, module graph, node:sqlite) which
  // stalls for seconds under CPU load. Tests of the bounds themselves set their own small values and assert
  // against them.
  cfg.broker.start_timeout_ms = 30000;
  cfg.hooks.deadline_ms = 30000;
  cfg.questions.app_server_socket = join(home, 'app-server-control', 'fixture.sock');
  writeFileSync(configPath(home), JSON.stringify(cfg, null, 2));
  return home;
}

/** All test broker starts validate native paths and default to a fake process table, including restarts. */
export async function startBroker(
  home: string,
  opts: NonNullable<Parameters<typeof assembleBroker>[1]> = {},
): Promise<Broker> {
  const socket = loadConfig(home).questions.app_server_socket;
  for (const path of [socket, codexIndexPath(socket)]) {
    const rel = relative(resolve(home), path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
      throw new Error('test broker native path is outside its fixture home');
  }
  return assembleBroker(home, { processProbe: noProcesses, ...opts });
}

export async function startTestBroker(home = tmpHome()): Promise<{ home: string; broker: Broker }> {
  // W8: a probe that knows no process, so no session records a parent and a closed MCP client goes offline at once,
  // as before. Liveness tests pass their own probe to startBroker.
  let broker: Broker | undefined;
  const names = fixtureCodexNames(home, () =>
    broker
      ? listSessions(broker.db).flatMap((s) =>
          s.agent === 'codex' && s.state !== 'offline' && s.link === 'connected' && s.agent_session_id
            ? [s.agent_session_id]
            : [],
        )
      : [],
  );
  broker = await startBroker(home, { processProbe: noProcesses, codexNames: names });
  return { home, broker };
}

/** Transport tests explicitly model independent loaded roots. Push-identity tests inject their own sharing/outage evidence. */
export function fixtureCodexNames(home: string, ids: () => string[]): CodexNames {
  class Metadata extends EventEmitter {
    async connect() {}
    async call(method: string, p: { threadId?: string }) {
      return method === 'thread/loaded/list'
        ? { data: [...new Set(ids())] }
        : {
            thread: { id: p.threadId, sessionId: p.threadId, source: 'cli', parentThreadId: null, name: null },
          };
    }
    send() {}
    close() {
      this.emit('disconnected');
    }
  }
  return new CodexNames({ factory: () => new Metadata(), indexPath: join(home, 'missing-index') });
}

export async function ownerClient(home: string): Promise<Client> {
  const { client } = await Client.connect(sockPath(home), { protocol: 1, role: 'owner' }, frameLimit(loadConfig(home)));
  return client;
}

/**
 * Resolves once a session named `name` is registered and not offline at the broker for `home`: the observable that a
 * spawned MCP server has finished its cold start (module load, pid chain, hello) and is ready to receive pushes.
 */
export async function sessionOnline(home: string, name: string): Promise<void> {
  const owner = await ownerClient(home);
  try {
    const poll = async (): Promise<void> => {
      const who = await owner.call<Array<{ name: string; state: string }>>('session.who');
      if (!who.some((x) => x.name === name && x.state !== 'offline')) throw new Error(`${name} is not online`);
    };
    await vi.waitFor(poll, { timeout: WAIT_MS, interval: 50 });
  } finally {
    owner.close();
  }
}

/** Leaves a real stale unix socket at `path`: a child binds it and is SIGKILLed, so nothing unlinks it. */
export function staleSocket(path: string): void {
  const r = spawnSync(process.execPath, [
    '-e',
    "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
    path,
  ]);
  if (r.signal !== 'SIGKILL') throw new Error(`stale socket helper did not die by SIGKILL: ${r.stderr}`);
}

/** Pids that ensureBroker spawned for `home`, read from the `spawned broker pid=` lines it logs. */
export function spawnedBrokerPids(home: string): number[] {
  const path = join(home, 'logs', 'broker.log');
  if (!existsSync(path)) return [];
  return [...readFileSync(path, 'utf8').matchAll(/spawned broker pid=(\d+)/g)].map((m) => Number(m[1]));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM every broker process spawned for `home` that is still alive, and wait until each has exited. */
export async function killSpawnedBrokers(home: string, timeoutMs: number): Promise<void> {
  const pids = spawnedBrokerPids(home).filter(isAlive);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  await vi.waitFor(
    () => {
      const left = pids.filter(isAlive);
      if (left.length) throw new Error(`brokers still alive: ${left.join(',')}`);
    },
    { timeout: timeoutMs },
  );
}
export async function mcpClient(home: string, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/w/myproject',
    pid_chain: [3, 2],
    mcp_ppid: 2,
    ...extra,
  };
  const pushes: PushData[] = [];
  const { client, welcome } = await Client.connect(
    sockPath(home),
    hello,
    frameLimit(loadConfig(home)),
    (name, data) => {
      if (name === 'push') pushes.push(data as PushData);
    },
  );
  return { client, welcome: welcome as { session_id: string; name: string }, pushes };
}

export function readCodexCalls(log: string): Array<{ argv: string[] }> {
  try {
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Cap on waiting for an observable condition (a session online, a push received, a process gone). Polls return the
 * moment the condition holds, so the cap only bounds a real failure; it must outlast process spawn and cold node
 * start under CPU load, which are the slow steps these conditions wait behind.
 */
export const WAIT_MS = 30000;

/**
 * Scheduling slack for asserting that something happened within a configured bound (config value + slack). It is far
 * below the helper's own 30 s budgets, so an ignored or defaulted config value still fails the assertion.
 */
export const BOUND_SLACK_MS = 5000;

export const until = async (cond: () => boolean, ms = WAIT_MS) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'ignore' });

/** A real git repository with one commit (so worktrees can be added) containing a `sub/` subdirectory. */
export function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ww-r-'));
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'keep'), '');
  git(dir, 'add', 'sub/keep');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A detached worktree of `repo` in a separate temp directory. */
export function gitWorktree(repo: string): string {
  const wt = join(mkdtempSync(join(tmpdir(), 'ww-wt-')), 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  return wt;
}

/** A directory holding an executable shell script `name` with `body`; put it first on PATH to replace that command. */
export function fakeCommandDir(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ww-g-'));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

/** A directory holding an executable `git` shell script with `body`; put it first on PATH to replace git. */
export const fakeGitDir = (body: string): string => fakeCommandDir('git', body);

/** The real git binary, resolved before any test changes PATH. */
export const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

export const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');

export interface FakeClaude {
  pid: number;
  /** Runs one child of this agent process to exit, as Claude Code runs a command hook. */
  run(
    argv: string[],
    stdin: string,
    env?: Record<string, string>,
  ): Promise<{ pid: number; status: number | null; stdout: string }>;
  /**
   * Starts a nested agent process under this one: `claude -p` run from the session's shell tool, or (with another
   * `exe`) the next layer of a launcher tree such as the `--bg` daemon -> pty host -> session process.
   */
  nest(exe?: string): Promise<FakeClaude>;
}

/** A fresh symlink named `exe` to the node binary: `ps` reports `exe` as the executable of a process started through it. */
function nodeAs(exe: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'ww-c-')), exe);
  symlinkSync(process.execPath, bin);
  return bin;
}

export const FAKE_WRAPPER = resolve(import.meta.dirname, 'fixtures/wrapper.mjs');

/**
 * The argv prefix of a launcher named `exe` (`timeout`, `env`, `nice`, ...) that stays the parent of the command it
 * runs (tests/fixtures/wrapper.mjs). Prepend it to a hook's argv to put that launcher between the agent and the hook.
 */
export const launcher = (exe: string): string[] => [nodeAs(exe), FAKE_WRAPPER];

/**
 * A live fake agent process (tests/fixtures/fake-claude.mjs) started through a symlink named `exe` to the node binary,
 * so `ps` reports `exe` as its executable: `claude` for a terminal session, a version string such as `2.1.295` for the
 * Claude Code `--bg` session process, `node` for an npm-installed Claude Code.
 */
export async function fakeClaude(exe = 'claude'): Promise<FakeClaude & { stop(): Promise<void> }> {
  const bin = nodeAs(exe);
  const proc = spawn(bin, [FAKE_CLAUDE], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: proc.stdout });
  const waiting: Array<(l: string) => void> = [];
  lines.on('line', (l) => waiting.shift()?.(l));
  const call = <T>(cmd: object): Promise<T> =>
    new Promise((res) => {
      waiting.push((l) => res(JSON.parse(l) as T));
      proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    });
  const node = (pid: number, to: number[]): FakeClaude => ({
    pid,
    run: (argv, stdin, env) => call({ to, run: argv, stdin, env }),
    nest: async (exe = 'claude') => {
      const r = await call<{ pid: number; child: number }>({ to, spawn: [nodeAs(exe), FAKE_CLAUDE] });
      return node(r.pid, [...to, r.child]);
    },
  });
  const exited = new Promise<void>((res) => proc.once('exit', () => res()));
  return {
    ...node(proc.pid as number, []),
    stop: async () => {
      proc.stdin.end();
      await exited;
    },
  };
}
