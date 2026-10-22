import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { INSTALL_OPERATION_TOKEN } from '../../src/install/process.js';
import {
  checkUpdateOperation,
  clearUpdateOperation,
  readUpdateOperation,
  runUpdateOperation,
} from '../../src/update/operation.js';

const entry = resolve(import.meta.dirname, '../update/fixtures/operation-worker.mjs');
const installer = resolve(import.meta.dirname, '../update/fixtures/nested-installer.mjs');
function fixture(body: string) {
  const home = mkdtempSync(join(tmpdir(), 'ww-nested-op-'));
  const script = join(home, 'provider.mjs');
  writeFileSync(
    script,
    `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const home = process.argv[2];
appendFileSync(home + '/calls', 'provider\\n');
writeFileSync(home + '/provider-token', process.env.${INSTALL_OPERATION_TOKEN} ?? 'absent');
${body}
`,
  );
  const command = {
    step: 'plugins' as const,
    root: home,
    target: '0.3.5',
    bin: process.execPath,
    args: [installer, script, home],
    cwd: home,
  };
  return { home, script, command };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('nested provider signal keeps the operation unknown while an ordinary descendant survives', async () => {
  const { home, command } = fixture(`
const child = spawn(process.execPath, ['-e', \`
  const fs = require('node:fs'); const home = process.argv[1];
  fs.writeFileSync(home + '/child-started', String(process.pid));
  const timer = setInterval(() => {
    if (fs.existsSync(home + '/release')) {
      clearInterval(timer); fs.writeFileSync(home + '/child-finished', 'done');
    }
  }, 20);
\`, home], { stdio: 'ignore' });
const timer = setInterval(() => {
  if (existsSync(home + '/child-started')) { clearInterval(timer); process.kill(process.pid, 'SIGTERM'); }
}, 20);
`);
  try {
    await expect(runUpdateOperation(home, command, { entry })).rejects.toThrow(/outcome unknown/);
    expect(readUpdateOperation(home)?.state).toBe('running');
    expect(() => checkUpdateOperation(home)).toThrow(/outcome unknown/);
    expect(() => process.kill(Number(readFileSync(join(home, 'child-started'), 'utf8')), 0)).not.toThrow();
    expect(existsSync(join(home, 'child-finished'))).toBe(false);
    expect(readFileSync(join(home, 'provider-token'), 'utf8')).toBe('absent');
    await expect(runUpdateOperation(home, command, { entry })).rejects.toThrow(/could not start/);
    expect(readFileSync(join(home, 'calls'), 'utf8')).toBe('provider\n');
  } finally {
    writeFileSync(join(home, 'release'), 'finish');
    await until(() => existsSync(join(home, 'child-finished')));
  }
});

it('nested output above the old capture limit succeeds only after its ordinary descendant finishes', async () => {
  const { home, command } = fixture(`
spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "done"), 500)', home + '/child-finished'], { stdio: 'ignore' });
process.stdout.write('x'.repeat(3 * 1024 * 1024));
process.stderr.write('y'.repeat(3 * 1024 * 1024));
`);
  await runUpdateOperation(home, command, { entry });
  expect(readUpdateOperation(home)?.state).toBe('succeeded');
  expect(existsSync(join(home, 'child-finished'))).toBe(true);
});

it('ordinary nested nonzero exits remain failed and can be retried after acknowledgement', async () => {
  const { home, command, script } = fixture('process.exitCode = 7;');
  await expect(runUpdateOperation(home, command, { entry })).rejects.toThrow(/command failed/);
  const failed = checkUpdateOperation(home);
  expect(failed?.state).toBe('failed');
  if (!failed) throw new Error('Missing failed operation receipt');
  clearUpdateOperation(home, failed.id);
  writeFileSync(script, 'process.exitCode = 0;');
  await runUpdateOperation(home, command, { entry });
  expect(readUpdateOperation(home)?.state).toBe('succeeded');
});

it('a mismatched nested IPC token cannot change an ordinary failure into unknown', async () => {
  const { home, command } = fixture('');
  command.args = [
    '-e',
    `process.send({ kind: 'wigwag-install-outcome-unknown', token: 'wrong-token' }); process.exitCode = 7;`,
  ];
  await expect(runUpdateOperation(home, command, { entry })).rejects.toThrow(/command failed/);
  expect(readUpdateOperation(home)?.state).toBe('failed');
});

it('failure to spawn the direct command remains a known failure', async () => {
  const { home, command } = fixture('');
  command.bin = join(home, 'does-not-exist');
  await expect(runUpdateOperation(home, command, { entry })).rejects.toThrow(/command failed/);
  expect(readUpdateOperation(home)?.state).toBe('failed');
});

it('a queued GO after failed preparation cannot run without its operation lock', async () => {
  const { home, command } = fixture('');
  const id = '7354588e-5062-4f97-9ea8-f899b792629a';
  const worker = spawn(process.execPath, [entry], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, WIGWAG_HOME: home },
  });
  const exited = once(worker, 'exit');
  const ready = once(worker, 'message');
  worker.send({ kind: 'prepare', id, command });
  expect((await ready)[0]).toEqual({ kind: 'ready' });
  worker.send({ kind: 'invalid' }, () => {});
  worker.send({ kind: 'go', id }, () => {});
  await exited;
  expect(readUpdateOperation(home)).toBeNull();
  expect(existsSync(join(home, 'calls'))).toBe(false);
});
