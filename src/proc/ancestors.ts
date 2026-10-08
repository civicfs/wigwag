import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export interface Proc {
  pid: number;
  /** Executable name: the basename of `ps -o comm=` ('' when ps could not report it). */
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
    chain.push({ pid: p, exe: row.exe });
    if (!Number.isInteger(row.ppid) || row.ppid <= 0) break;
    p = row.ppid;
  }
  return chain;
}

/** Ancestor pids starting at `pid`, stopping before pid 1. */
export function pidChain(pid: number): number[] {
  return processChain(pid).map((x) => x.pid);
}

/** The nearest strict ancestor (the chain's first entry is the process itself) whose executable is `exe`, or null. */
export function nearestAncestor(chain: Proc[], exe: string): number | null {
  return chain.slice(1).find((x) => x.exe === exe)?.pid ?? null;
}
