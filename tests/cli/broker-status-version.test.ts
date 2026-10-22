import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdBroker } from '../../src/cli/commands/broker.js';
import { VERSION } from '../../src/version.js';
import { startBroker, tmpHome } from '../helpers.js';

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});
it('version-constrained broker status rejects a live wrong version without replacing the broker', async () => {
  const home = tmpHome();
  vi.stubEnv('WIGWAG_HOME', home);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const broker = await startBroker(home);
  try {
    await expect(cmdBroker('status', ['--expect-version', '0.0.1'])).rejects.toThrow(
      /version.*not confirmed|expected.*0\.0\.1/i,
    );
    await expect(cmdBroker('status', ['--expect-version', VERSION])).resolves.toBeUndefined();
  } finally {
    await broker.stop();
  }
});
it('version-constrained status rejects a missing broker without creating broker files', async () => {
  const home = tmpHome();
  vi.stubEnv('WIGWAG_HOME', home);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await expect(cmdBroker('status', ['--expect-version', VERSION])).rejects.toThrow(/not running|not confirmed/i);
  expect(existsSync(join(home, 'broker.lock'))).toBe(false);
  expect(existsSync(join(home, 'broker.mutex'))).toBe(false);
  expect(existsSync(join(home, 'state.db'))).toBe(false);
});
