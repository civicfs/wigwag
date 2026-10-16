import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** S-A: a pid plus the start identity of the process that had it; a pid alone never proves "same process". */
export interface ProcessIdentity {
  pid: number;
  start: string;
}

/** pid → start identity for the pids that exist now. A missing pid is gone; null means the probe itself failed. */
export type ProcessProbe = (pids: number[]) => Map<number, string> | null;

/** `ps -o pid=,uid=,lstart=` lines (LC_ALL=C) as `darwin:<lstart>:<uid>`. */
export function parseDarwinPs(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), `darwin:${m[3].replace(/\s+/g, ' ')}:${m[2]}`);
  }
  return out;
}

/**
 * macOS: start time to the second (ps lstart) plus uid. libproc's microsecond start needs a native addon; not in
 * 0.3.0. ps exits 1 when some pids are missing but still prints the others.
 */
export const darwinProbe: ProcessProbe = (pids) => {
  if (!pids.length) return new Map();
  try {
    return parseDarwinPs(
      execFileSync('ps', ['-o', 'pid=,uid=,lstart=', '-p', pids.join(',')], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }),
    );
  } catch (e) {
    const { stdout, status } = e as { stdout?: unknown; status?: unknown };
    return typeof stdout === 'string' && status === 1 ? parseDarwinPs(stdout) : null;
  }
};

/** Linux: `linux:<boot id>:<start ticks>:<uid>` from /proc/<pid>/stat field 22 (S-A: parse after comm's last ")"). */
export function linuxProbe(pids: number[], procRoot = '/proc'): Map<number, string> | null {
  let boot: string;
  try {
    boot = readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
  } catch {
    return null;
  }
  const out = new Map<number, string>();
  for (const pid of pids) {
    try {
      const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = rest[19]; // rest[0] is field 3 (state); field 22 is starttime
      if (!start || !/^\d+$/.test(start)) continue;
      out.set(pid, `linux:${boot}:${start}:${statSync(join(procRoot, String(pid))).uid}`);
    } catch {
      // gone, or not readable: treated as gone
    }
  }
  return out;
}

export const systemProbe: ProcessProbe = (pids) =>
  process.platform === 'linux' ? linuxProbe(pids) : darwinProbe(pids);

/** Knows no process: every capture fails, so no session records a parent (tests/helpers.ts default). */
export const noProcesses: ProcessProbe = () => new Map();

export function captureIdentity(pid: number, probe: ProcessProbe = systemProbe): ProcessIdentity | null {
  const start = probe([pid])?.get(pid);
  return start ? { pid, start } : null;
}

/** One probe call for every identity; null when the probe failed (unverifiable, not gone). */
export function checkIdentities(ids: ProcessIdentity[], probe: ProcessProbe = systemProbe): boolean[] | null {
  if (!ids.length) return [];
  const now = probe([...new Set(ids.map((i) => i.pid))]);
  return now === null ? null : ids.map((i) => now.get(i.pid) === i.start);
}

export function sameProcess(id: ProcessIdentity, probe: ProcessProbe = systemProbe): boolean | null {
  const r = checkIdentities([id], probe);
  return r === null ? null : (r[0] as boolean);
}
