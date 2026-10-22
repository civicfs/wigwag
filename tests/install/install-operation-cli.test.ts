import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { checkUpdateOperation, readUpdateOperation, runUpdateOperation } from '../../src/update/operation.js';
import { DIST_MAIN, killSpawnedBrokers } from '../helpers.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for nested CLI fixture');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function fixture(mode: 'output' | 'signal') {
  const home = mkdtempSync(join(tmpdir(), 'ww-inst-op-'));
  const provider = join(home, 'codex');
  writeFileSync(
    provider,
    `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const home = ${JSON.stringify(home)};
appendFileSync(home + '/calls', process.argv.slice(2).join(' ') + '\\n');
writeFileSync(home + '/provider-token', process.env.WIGWAG_INSTALL_OPERATION_TOKEN ?? 'absent');
if (process.argv[3] === 'marketplace') {
  spawn(process.execPath, ['-e', \`
    const fs = require('node:fs'); const home = process.argv[1];
    fs.writeFileSync(home + '/child-started', String(process.pid));
    const timer = setInterval(() => {
      if (fs.existsSync(home + '/release')) {
        clearInterval(timer); fs.writeFileSync(home + '/child-finished', 'done');
      }
    }, 20);
  \`, home], { stdio: 'ignore' });
  ${
    mode === 'output'
      ? `process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.stderr.write('y'.repeat(3 * 1024 * 1024));`
      : `
  const timer = setInterval(() => {
    if (existsSync(home + '/child-started')) { clearInterval(timer); process.kill(process.pid, 'SIGTERM'); }
  }, 20);`
  }
}
`,
    { mode: 0o700 },
  );
  return {
    home,
    command: {
      step: 'plugins' as const,
      root: home,
      target: '0.3.5',
      bin: process.execPath,
      args: [DIST_MAIN, 'install', '--codex-only', '--codex-binary', provider],
      cwd: home,
    },
  };
}
async function cleanup(home: string) {
  writeFileSync(join(home, 'release'), 'finish');
  if (existsSync(join(home, 'child-started'))) await until(() => existsSync(join(home, 'child-finished')));
  if (existsSync(join(home, 'config.json'))) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
}

it('bundled install retains the worker fence after nested output exceeds 1 MB', async () => {
  const { home, command } = fixture('output');
  const operation = runUpdateOperation(home, command, { entry: DIST_MAIN });
  // Attach a rejection handler immediately so a regression cannot become an unhandled rejection.
  const result = operation.then(
    () => null,
    (error: Error) => error,
  );
  try {
    await until(() => existsSync(join(home, 'child-started')));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => checkUpdateOperation(home)).toThrow(/still running/i);
    expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
    writeFileSync(join(home, 'release'), 'finish');
    expect(await result).toBeNull();
    expect(existsSync(join(home, 'child-finished'))).toBe(true);
    expect(readUpdateOperation(home)?.state).toBe('succeeded');
    expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    await cleanup(home);
    await result;
  }
});

it('bundled install propagates a nested provider signal and prevents overlapping retry', async () => {
  const { home, command } = fixture('signal');
  try {
    await expect(runUpdateOperation(home, command, { entry: DIST_MAIN })).rejects.toThrow(/outcome unknown/);
    expect(readUpdateOperation(home)?.state).toBe('running');
    expect(() => checkUpdateOperation(home)).toThrow(/outcome unknown/);
    expect(() => process.kill(Number(readFileSync(join(home, 'child-started'), 'utf8')), 0)).not.toThrow();
    expect(readFileSync(join(home, 'provider-token'), 'utf8')).toBe('absent');
    await expect(runUpdateOperation(home, command, { entry: DIST_MAIN })).rejects.toThrow(/could not start/);
    expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    await cleanup(home);
  }
});
