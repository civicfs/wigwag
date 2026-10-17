import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureIdentity,
  checkIdentities,
  linuxProbe,
  type ProcessProbe,
  parseDarwinPs,
  sameProcess,
  systemProbe,
} from '../../src/proc/identity.js';

const fakeProbe =
  (procs: Map<number, string>, calls: number[][] = []): ProcessProbe =>
  (pids) => {
    calls.push(pids);
    const m = new Map<number, string>();
    for (const p of pids) {
      const s = procs.get(p);
      if (s) m.set(p, s);
    }
    return m;
  };

describe('process identity (W8)', () => {
  it('parses macOS ps output into darwin:UTC:<lstart>:<uid>', () => {
    expect(parseDarwinPs('  4242   501 Thu Oct 15 08:47:53 2026\n   77     0 Mon Oct  5 01:02:03 2026\n')).toEqual(
      new Map([
        [4242, 'darwin:UTC:Thu Oct 15 08:47:53 2026:501'],
        [77, 'darwin:UTC:Mon Oct 5 01:02:03 2026:0'],
      ]),
    );
  });

  it('reads Linux start ticks after the last ")" of comm, with boot id and uid', () => {
    const root = mkdtempSync(join(tmpdir(), 'ww-proc-'));
    mkdirSync(join(root, 'sys/kernel/random'), { recursive: true });
    writeFileSync(join(root, 'sys/kernel/random/boot_id'), 'b-1\n');
    mkdirSync(join(root, '123'));
    writeFileSync(
      join(root, '123', 'stat'),
      '123 (my (weird) proc) S 1 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 10\n',
    );
    const uid = statSync(join(root, '123')).uid;
    expect(linuxProbe([123, 999], root)).toEqual(new Map([[123, `linux:b-1:98765:${uid}`]]));
    expect(linuxProbe([123], join(root, 'missing'))).toBeNull();
  });

  it('pid reuse, a gone process and a failed probe are told apart', () => {
    const procs = new Map([[4242, 'start-A']]);
    const calls: number[][] = [];
    const probe = fakeProbe(procs, calls);
    const id = captureIdentity(4242, probe);
    expect(id).toEqual({ pid: 4242, start: 'start-A' });
    expect(sameProcess(id as { pid: number; start: string }, probe)).toBe(true);
    procs.set(4242, 'start-B'); // the pid now belongs to another process
    expect(sameProcess({ pid: 4242, start: 'start-A' }, probe)).toBe(false);
    procs.delete(4242);
    expect(sameProcess({ pid: 4242, start: 'start-A' }, probe)).toBe(false);
    expect(captureIdentity(4242, probe)).toBeNull();
    expect(sameProcess({ pid: 4242, start: 'start-A' }, () => null)).toBeNull();
    calls.length = 0;
    procs.set(1, 'a');
    procs.set(2, 'b');
    expect(
      checkIdentities(
        [
          { pid: 1, start: 'a' },
          { pid: 2, start: 'x' },
          { pid: 1, start: 'a' },
        ],
        probe,
      ),
    ).toEqual([true, false, true]);
    expect(calls).toEqual([[1, 2]]);
    expect(checkIdentities([], () => null)).toEqual([]);
  });

  it('the system probe identifies this test process', () => {
    const id = captureIdentity(process.pid, systemProbe);
    expect(id?.pid).toBe(process.pid);
    expect(sameProcess(id as { pid: number; start: string }, systemProbe)).toBe(true);
  });
});
