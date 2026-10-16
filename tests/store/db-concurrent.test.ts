import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { spawnTsChild, tsChildArgs } from '../helpers.js';

const CHILD = resolve(import.meta.dirname, '../fixtures/open-db-child.mjs');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

function lines(c: ChildProcess): { next: () => Promise<string> } {
  const queue: string[] = [];
  const waiting: Array<{ resolve: (l: string) => void; reject: (e: Error) => void }> = [];
  let ended: Error | null = null;
  let receipt = false;
  const fail = (error: Error) => {
    ended = error;
    for (const w of waiting.splice(0)) w.reject(error);
  };
  c.once('error', fail);
  c.once('close', (code, signal) =>
    fail(
      new Error(
        `database fixture exited before next output: exit=${code}, signal=${signal}, runtime receipt ${receipt ? 'received' : 'MISSING'}`,
      ),
    ),
  );
  let buf = '';
  c.stdout?.on('data', (d) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const l = buf.slice(0, nl);
      if (l === 'fixture-runtime-ready') receipt = true;
      buf = buf.slice(nl + 1);
      const w = waiting.shift();
      if (w) w.resolve(l);
      else queue.push(l);
      nl = buf.indexOf('\n');
    }
  });
  return {
    next: () => {
      const l = queue.shift();
      return l !== undefined
        ? Promise.resolve(l)
        : ended
          ? Promise.reject(ended)
          : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

describe('openDb under concurrent first open', () => {
  it('starts the child runtime and loads TypeScript before any database operation', () => {
    const result = spawnSync(process.execPath, tsChildArgs(CHILD, ['--check-runtime']), {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (result.status !== 0 || !result.stdout.startsWith('fixture-runtime-ready\n'))
      throw new Error(
        `database fixture runtime failed before its checkpoint: exit=${result.status}, signal=${result.signal}, error=${result.error?.message ?? result.stderr}`,
      );
    expect(result.stdout).toBe('fixture-runtime-ready\nready\n');
  });
  it('fails loudly on an early runtime exit without a checkpoint', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(9)'], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(child);
    await expect(lines(child).next()).rejects.toThrow('exit=9, signal=null, runtime receipt MISSING');
  });
  it('several processes migrating a fresh db at once all succeed (schema_version re-read in the tx)', async () => {
    for (let round = 0; round < 4; round++) {
      const file = join(mkdtempSync(join(tmpdir(), 'ww-db-')), 'state.db');
      const procs = Array.from({ length: 8 }, () => {
        const c = spawnTsChild(CHILD, [file], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        children.push(c);
        return { c, out: lines(c) };
      });
      for (const p of procs) {
        expect(await p.out.next()).toBe('fixture-runtime-ready');
        expect(await p.out.next()).toBe('ready');
      }
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
