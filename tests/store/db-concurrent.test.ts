import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';

const CHILD = resolve(import.meta.dirname, '../fixtures/open-db-child.mjs');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

function lines(c: ChildProcess): { next: () => Promise<string> } {
  const queue: string[] = [];
  const waiting: Array<(l: string) => void> = [];
  let buf = '';
  c.stdout?.on('data', (d) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiting.shift();
      if (w) w(l);
      else queue.push(l);
      nl = buf.indexOf('\n');
    }
  });
  return {
    next: () => {
      const l = queue.shift();
      return l !== undefined ? Promise.resolve(l) : new Promise((res) => waiting.push(res));
    },
  };
}

describe('openDb under concurrent first open', () => {
  it('several processes migrating a fresh db at once all succeed (schema_version re-read in the tx)', async () => {
    for (let round = 0; round < 4; round++) {
      const file = join(mkdtempSync(join(tmpdir(), 'ww-db-')), 'state.db');
      const procs = Array.from({ length: 8 }, () => {
        const c = spawn(process.execPath, ['--experimental-transform-types', CHILD, file], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        children.push(c);
        return { c, out: lines(c) };
      });
      for (const p of procs) expect(await p.out.next()).toBe('ready');
      for (const p of procs) p.c.stdin?.write('go\n');
      const results = await Promise.all(procs.map((p) => p.out.next()));
      expect(results).toEqual(procs.map(() => 'ok'));
      const db = openDb(file);
      expect(db.prepare('SELECT count(*) AS n FROM schema_version').get()).toEqual({ n: 4 });
      expect(db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 4 });
      db.close();
    }
  });
});
