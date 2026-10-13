import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface Proc {
  pid: number;
  /** Executable name from macOS ps comm or Linux argv[0]; empty when unavailable. */
  exe: string;
}

/** Pid-chain depth (spec §11 fixed constants). Not a tunable. */
const MAX_DEPTH = 16;

/** One `ps` for the whole process table, so the walk costs one spawn however deep the tree is. */
function processTable(): Map<number, { ppid: number; exe: string }> | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const table = new Map<number, { ppid: number; exe: string }>();
  for (const line of out.split('\n')) {
    // macOS prints the executable path as exec'd (it may contain spaces), Linux the bare name.
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), exe: basename(m[3].trim()) });
  }
  return table;
}

/** Linux comm is a mutable/truncated thread name (Node can report MainThread), not argv[0]. */
function executable(pid: number, comm: string): string {
  if (process.platform !== 'linux') return comm;
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`);
    const end = args.indexOf(0);
    const argv0 = args.subarray(0, end < 0 ? args.length : end).toString('utf8');
    return argv0 ? basename(argv0) : '';
  } catch {
    // An exited/inaccessible process stays unknown; agentAncestor must not skip past it.
    return '';
  }
}

/**
 * Ancestor processes starting at `pid`, stopping before pid 1. Works on macOS and Linux. The table comes from a single
 * `ps -ax -o pid=,ppid=,comm=`: a `ps` per ancestor serialised a spawn per level, and under CPU load each spawn can take
 * seconds, which counted against the hook deadline and the MCP hello budget.
 */
export function processChain(pid: number): Proc[] {
  const table = processTable();
  const chain: Proc[] = [];
  let p = pid;
  while (p > 1 && chain.length < MAX_DEPTH) {
    const row = table?.get(p);
    if (!row) {
      chain.push({ pid: p, exe: '' });
      break;
    }
    chain.push({ pid: p, exe: executable(p, row.exe) });
    if (!Number.isInteger(row.ppid) || row.ppid <= 0) break;
    p = row.ppid;
  }
  return chain;
}

/** Ancestor pids starting at `pid`, stopping before pid 1. */
export function pidChain(pid: number): number[] {
  return processChain(pid).map((x) => x.pid);
}

/**
 * Spec §4: the shells and launchers that may stand between an agent process and a hook command it runs (Claude Code
 * runs a command hook through a shell; a hook command may itself be wrapped in `env` or `timeout`), plus this package's
 * own bin names. These are names of shells and generic launchers, never of an agent: the agent's executable name is
 * not stable (Claude Code's terminal process is `claude`, its `--bg` session process is named after the release, such
 * as `2.1.295`, and an npm install runs as `node`). Fixed, not a tunable: every name here is looked through on the way
 * up, so it must never be a name an agent process can run under (`node` is therefore not here).
 */
const HOOK_LAUNCHERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env', 'timeout', 'wigwag', 'ww']);

/** A login shell's `ps` name carries a leading `-` (`-zsh`). */
const launcherName = (exe: string): string => (exe.startsWith('-') ? exe.slice(1) : exe);

/**
 * Spec §4: the process that ran this hook, found by position, not by name: the nearest strict ancestor (the chain's
 * first entry is the hook itself) that is not a shell or launcher in `HOOK_LAUNCHERS`. The walk stops at the first
 * other process, whatever it is (an unknown wrapper, or a process `ps` could not name): it never skips past it to a
 * process further up, so a nested `claude -p` hook stops at the inner agent and never reaches the outer one. Null when
 * the chain has only shells and launchers above the hook.
 */
export function agentAncestor(chain: Proc[]): number | null {
  return chain.slice(1).find((x) => !HOOK_LAUNCHERS.has(launcherName(x.exe)))?.pid ?? null;
}
