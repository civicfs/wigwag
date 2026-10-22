import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { lockUpdate } from '../../src/update/lock.js';
import { spawnTsChild } from '../helpers.js';

it('excludes a separate process and releases the update mutex when its holder dies', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ww-update-lock-'));
  const child = spawnTsChild(resolve(import.meta.dirname, 'fixtures/lock-holder.mjs'), [home]);
  const exited = once(child, 'exit');
  let ready = '';
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', () => reject(new Error('lock fixture exited before readiness')));
      child.stdout?.on('data', (chunk) => {
        ready += String(chunk);
        if (ready.includes('locked\n')) resolve();
      });
    });
    expect(() => lockUpdate(home)).toThrow(/update already running/i);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  const release = lockUpdate(home);
  release();
  const reacquired = lockUpdate(home);
  reacquired();
});
