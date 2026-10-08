import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initHome, loadConfig } from '../../src/config.js';
import { install } from '../../src/install/install.js';
import { DIST_MAIN, killSpawnedBrokers } from '../helpers.js';

// R40: saving --codex-binary can fail (read-only home, full disk). initHome re-chmods the home to 0700, so the
// failure cannot be produced from outside a CLI run portably; setCodexBinary is replaced to throw instead.
vi.mock('../../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../../src/config.js')>()),
  setCodexBinary: () => {
    throw new Error('EACCES: permission denied, rename config.json');
  },
}));
// The broker this install autospawns must be the built CLI, not the vitest worker.
vi.mock('../../src/cli/util.js', async (orig) => ({
  ...(await orig<typeof import('../../src/cli/util.js')>()),
  cliEntry: () => DIST_MAIN,
}));

const FAKE = resolve(import.meta.dirname, '../fixtures/fake-agent.mjs');
const env = {
  PATH: process.env.PATH,
  WIGWAG_HOME: process.env.WIGWAG_HOME,
  FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG,
};
let home = '';
afterEach(async () => {
  if (home) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('install --codex-binary when saving it fails (R40)', () => {
  it('uses the explicit binary for this run and reports the save as a FAIL step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-inst-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync(FAKE, join(bin, 'codex'));
    home = join(dir, 'h');
    const log = join(dir, 'calls.jsonl');
    process.env.WIGWAG_HOME = home;
    process.env.FAKE_AGENT_LOG = log;
    initHome(home, '/nonexistent/codex');
    const steps = await install({ claude: false, codex: true, codexBinary: join(bin, 'codex') });
    expect(steps).toContainEqual(
      expect.objectContaining({
        target: 'wigwag',
        action: 'config',
        ok: false,
        detail: expect.stringMatching(/EACCES/),
      }),
    );
    expect(steps.every((s) => s.ok)).toBe(false); // the CLI exits 1
    const codexSteps = steps.filter((s) => s.target === 'codex');
    expect(codexSteps.map((s) => [s.action, s.ok])).toEqual([
      ['marketplace', true],
      ['plugin', true],
    ]);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { bin: string; argv: string[] });
    expect(calls.map((c) => c.argv)).toContainEqual(['plugin', 'add', 'wigwag@wigwag']);
    expect(loadConfig(home).codex.binary).toBe('/nonexistent/codex');
  });
});
