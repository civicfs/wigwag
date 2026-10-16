import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Broker } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import { preV3BackupPath, preV4BackupPath } from '../../src/store/db.js';
import { SCHEMA_V1, SCHEMA_V2 } from '../../src/store/schema.js';
import { spawnTsChild, tmpHome } from '../helpers.js';

const brokers: Broker[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin?.end('release\n');
    await closed;
  }
});

async function hold(home: string, commit = false) {
  const child = spawnTsChild(
    resolve(import.meta.dirname, '../fixtures/broker-lock-child.mjs'),
    [home, commit ? 'commit' : ''],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  children.push(child);
  const output = child.stdout;
  if (!output) throw new Error('fixture stdout pipe missing');
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: output });
    child.once('error', reject);
    child.once('close', (code) => reject(new Error(`lock fixture exited before receipt: ${code}`)));
    lines.once('line', (line) => {
      lines.close();
      output.resume();
      if (line === 'fixture-lock-held') resolve();
      else reject(new Error(`unexpected fixture receipt: ${line}`));
    });
  });
  return async () => {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin?.end('release\n');
    await closed;
  };
}

const broker = (home: string) => {
  const b = new Broker(home, loadConfig(home));
  brokers.push(b);
  return b;
};

it('does not even create state.db when another process holds the broker mutex', async () => {
  const home = tmpHome();
  await hold(home);
  await expect(broker(home).start()).rejects.toMatchObject({ code: 'already_running' });
  expect(existsSync(join(home, 'state.db'))).toBe(false);
});

it('does not migrate or back up a locked v2 database; the next locked start backs up all committed mail', async () => {
  const home = tmpHome(),
    file = join(home, 'state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL)');
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_V2);
  db.exec('INSERT INTO schema_version VALUES(1),(2)');
  db.close();
  const release = await hold(home, true);
  const before = readFileSync(file);
  await expect(broker(home).start()).rejects.toMatchObject({ code: 'already_running' });
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(existsSync(preV3BackupPath(file))).toBe(false);
  expect(existsSync(preV4BackupPath(file))).toBe(false);
  await release();
  const running = broker(home);
  await running.start();
  expect(running.db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 4 });
  for (const path of [preV3BackupPath(file), preV4BackupPath(file)]) {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const backup = new DatabaseSync(path, { readOnly: true });
    try {
      expect(backup.prepare("SELECT body FROM messages WHERE id='last-commit'").get()).toEqual({
        body: 'last committed message',
      });
    } finally {
      backup.close();
    }
  }
});
