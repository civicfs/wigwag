import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { install } from '../../src/install/install.js';

vi.mock('../../src/client/autospawn.js', () => ({ ensureBroker: async () => {} }));
vi.mock('../../src/cli/util.js', () => ({ cliEntry: () => resolve('dist/main.js') }));
afterEach(() => vi.unstubAllEnvs());

function fixture(body: string) {
  const home = mkdtempSync(join(tmpdir(), 'ww-nested-inst-'));
  const provider = join(home, 'provider');
  writeFileSync(
    provider,
    `#!${process.execPath}\nimport { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const home = ${JSON.stringify(home)};
appendFileSync(home + '/calls', process.argv.slice(2).join(' ') + '\\n');
${body}\n`,
    { mode: 0o700 },
  );
  vi.stubEnv('WIGWAG_HOME', home);
  return { home, provider };
}

it('nested installer drains multi-megabyte output and waits for its ordinary child', async () => {
  const { home, provider } = fixture(`
if (process.argv[3] === 'marketplace') {
  spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "done"), 900)', home + '/descendant-done'], { stdio: 'ignore' });
  process.stdout.write('x'.repeat(3 * 1024 * 1024));
  process.stderr.write('y'.repeat(3 * 1024 * 1024));
}
`);
  const steps = await install({ claude: false, codex: true, codexBinary: provider });
  expect(steps.every((step) => step.ok)).toBe(true);
  expect(existsSync(join(home, 'descendant-done'))).toBe(true);
  expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
});

it('a signalled nested provider aborts subsequent installer commands as outcome unknown', async () => {
  const { home, provider } = fixture('process.kill(process.pid, "SIGTERM");');
  await expect(install({ claude: false, codex: true, codexBinary: provider })).rejects.toThrow(
    /outcome unknown.*SIGTERM/i,
  );
  expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it('ordinary provider failures retain bounded diagnostics and remain ordinary failed steps', async () => {
  const { provider } = fixture(`
process.stderr.write('x'.repeat(3 * 1024 * 1024) + 'provider failed');
process.exitCode = 7;
`);
  const steps = await install({ claude: false, codex: true, codexBinary: provider });
  const providerSteps = steps.filter((step) => step.target === 'codex');
  expect(providerSteps).toHaveLength(2);
  for (const step of providerSteps) {
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/provider failed$/);
    expect(step.detail.length).toBeLessThanOrEqual(65536);
  }
});
