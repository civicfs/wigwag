import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { lockUpdate, lockUpdateOperation } from '../../src/update/lock.js';
import { checkUpdateOperation, readUpdateOperation } from '../../src/update/operation.js';
import { spawnTsChild } from '../helpers.js';

const entry = resolve('dist/main.js');
const parentEntry = resolve(import.meta.dirname, 'fixtures/operation-parent.mjs');
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ww-operation-process-'));
  const script = join(home, 'installer.mjs');
  writeFileSync(
    script,
    `import { existsSync, writeFileSync } from 'node:fs';
const home = process.argv[2];
writeFileSync(home + '/started', String(process.pid));
const timer = setInterval(() => {
  process.stdout.write('x'.repeat(131072));
  if (existsSync(home + '/release')) {
    clearInterval(timer); writeFileSync(home + '/finished', 'done');
  }
}, 20);
`,
  );
  return { home, script };
}
function start(home: string, script: string, timeout = 30000) {
  return spawnTsChild(parentEntry, [home, script, entry, String(timeout)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WIGWAG_HOME: home },
  });
}
async function stop(child: ChildProcess, home: string) {
  writeFileSync(join(home, 'release'), 'finish');
  if (existsSync(join(home, 'started'))) await until(() => existsSync(join(home, 'finished')), 'installer completion');
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
}
const cli = (home: string, args: string[]) =>
  new Promise<{ code: number; text: string }>((resolve) => {
    execFile(
      process.execPath,
      [entry, 'update', ...args],
      { env: { ...process.env, WIGWAG_HOME: home } },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, text: stdout + stderr }),
    );
  });

it('parent SIGKILL leaves the command fenced until the surviving worker records completion', async () => {
  const { home, script } = fixture();
  const parent = start(home, script);
  try {
    await until(() => existsSync(join(home, 'started')), 'installer start');
    const exited = once(parent, 'exit');
    parent.kill('SIGKILL');
    await exited;
    const release = lockUpdate(home);
    release();
    expect(() => checkUpdateOperation(home)).toThrow(/still running/i);
    // Output already exceeds execFile's old 1 MB cap; supervision must stay alive.
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(() => lockUpdateOperation(home)).toThrow(/still running/i);
    writeFileSync(join(home, 'release'), 'finish');
    await until(() => readUpdateOperation(home)?.state === 'succeeded', 'worker receipt');
    await until(() => {
      try {
        const release = lockUpdateOperation(home);
        release();
        return true;
      } catch {
        return false;
      }
    }, 'worker fence release');
    expect(checkUpdateOperation(home)?.state).toBe('succeeded');
  } finally {
    await stop(parent, home);
  }
});

it('a soft wait timeout leaves the worker and command fenced instead of killing them', async () => {
  const { home, script } = fixture();
  const parent = start(home, script, 2500);
  try {
    const exited = once(parent, 'exit');
    await until(() => existsSync(join(home, 'started')), 'installer start');
    await exited;
    expect(parent.exitCode).toBe(1);
    expect(() => checkUpdateOperation(home)).toThrow(/still running/i);
    writeFileSync(join(home, 'release'), 'finish');
    await until(() => readUpdateOperation(home)?.state === 'succeeded', 'worker receipt');
  } finally {
    await stop(parent, home);
  }
});

it('worker death leaves unknown outcome; CLI recovery requires exact ID and not-running acknowledgement', async () => {
  const { home, script } = fixture();
  const parent = start(home, script);
  const journal = join(home, 'update-progress.json');
  writeFileSync(journal, 'pending journal must survive');
  try {
    const exited = once(parent, 'exit');
    await until(() => existsSync(join(home, 'started')), 'installer start');
    const operation = readUpdateOperation(home);
    if (!operation) throw new Error('Missing started operation receipt');
    process.kill(operation.worker_pid, 'SIGKILL');
    await exited;
    expect(() => checkUpdateOperation(home)).toThrow(/outcome unknown/i);
    expect(() => process.kill(Number(readFileSync(join(home, 'started'), 'utf8')), 0)).not.toThrow();
    expect((await cli(home, ['--resolve-operation', operation.id])).code).toBe(1);
    expect((await cli(home, ['--resolve-operation', 'wrong-id', '--not-running'])).code).toBe(1);
    expect(readUpdateOperation(home)?.id).toBe(operation.id);
    writeFileSync(join(home, 'release'), 'finish');
    await until(() => existsSync(join(home, 'finished')), 'installer stopped before acknowledgement');
    const recovered = await cli(home, ['--resolve-operation', operation.id, '--not-running']);
    expect(recovered.code, recovered.text).toBe(0);
    expect(readUpdateOperation(home)).toBeNull();
    expect(readFileSync(journal, 'utf8')).toBe('pending journal must survive');
  } finally {
    await stop(parent, home);
  }
});

it('disconnect before GO never launches the prepared command', async () => {
  const { home, script } = fixture();
  const worker = spawn(process.execPath, [entry, '__update-worker'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, WIGWAG_HOME: home },
  });
  const exited = once(worker, 'exit');
  try {
    const ready = once(worker, 'message');
    worker.send({
      kind: 'prepare',
      id: '7354588e-5062-4f97-9ea8-f899b792629a',
      command: {
        root: home,
        target: '0.3.5',
        step: 'claude',
        bin: process.execPath,
        args: [script, home],
        cwd: home,
      },
    });
    expect((await ready)[0]).toEqual({ kind: 'ready' });
    worker.disconnect();
    await exited;
    expect(existsSync(join(home, 'started'))).toBe(false);
    expect(readUpdateOperation(home)).toBeNull();
    const release = lockUpdateOperation(home);
    release();
  } finally {
    await stop(worker, home);
  }
});
