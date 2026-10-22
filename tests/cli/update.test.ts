import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VERSION } from '../../src/version.js';

const update = vi.hoisted(() => ({
  applyUpdate: vi.fn(),
  checkUpdate: vi.fn(),
  readUpdateProgress: vi.fn(),
  describeApply: vi.fn(),
  describeUpdate: vi.fn(),
}));
vi.mock('../../src/update/update.js', () => update);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let output: string;
let errors: string;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  output = '';
  errors = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  vi.stubEnv('WIGWAG_HOME', mkdtempSync(join(tmpdir(), 'ww-cli-update-')));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  update.readUpdateProgress.mockReturnValue(null);
  update.checkUpdate.mockResolvedValue({
    current: VERSION,
    source: 'npm',
    available: VERSION,
    update_available: false,
  });
  update.describeUpdate.mockReturnValue('check output');
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('prints structured partial results with nonzero exit and resumes pending work without checking npm', async () => {
  const result = {
    version: VERSION,
    providers: ['codex'],
    resumed: true,
    cli_verified: true,
    completed: false,
    pending: ['broker'],
    failures: [{ step: 'broker', detail: 'failed' }],
    next_steps: ['Restart Codex and trust changed hooks'],
  };
  update.readUpdateProgress.mockReturnValue({ target: VERSION });
  update.applyUpdate.mockResolvedValue(result);
  process.argv = [process.execPath, originalArgv[1], 'update', '--apply', '--json'];
  await import('../../src/cli/main.js');
  await vi.waitFor(() => expect(output).not.toBe(''));
  expect(JSON.parse(output)).toEqual(result);
  expect(process.exitCode).toBe(1);
  expect(update.checkUpdate).not.toHaveBeenCalled();
});
it('prints provider-specific follow-up actions after resuming a same-version successful repair', async () => {
  const result = { version: VERSION, completed: true, pending: [], next_steps: ['Claude: /reload-plugins'] };
  update.readUpdateProgress.mockReturnValue({ target: VERSION });
  update.applyUpdate.mockResolvedValue(result);
  update.describeApply.mockReturnValue('CLI and broker verified. Claude: /reload-plugins. Check bound/push readiness.');
  process.argv = [process.execPath, originalArgv[1], 'update', '--apply'];
  await import('../../src/cli/main.js');
  await vi.waitFor(() => expect(output).not.toBe(''));
  expect(output).toContain('/reload-plugins');
  expect(output).toContain('bound/push readiness');
  expect(process.exitCode).not.toBe(1);
});

it('explicit same-version repair bypasses npm metadata and requests provider/broker repair', async () => {
  const result = { version: VERSION, completed: true, pending: [] };
  update.applyUpdate.mockResolvedValue(result);
  update.checkUpdate.mockRejectedValue(new Error('registry must not be called'));
  process.argv = [process.execPath, originalArgv[1], 'update', '--apply', '--repair', '--json'];
  await import('../../src/cli/main.js');
  await vi.waitFor(() => expect(output || errors).not.toBe(''));
  expect(errors).toBe('');
  expect(JSON.parse(output)).toEqual(result);
  expect(update.checkUpdate).not.toHaveBeenCalled();
  expect(update.applyUpdate.mock.calls[0]?.[5]).toEqual({ repair: true });
});
it.each([
  { args: ['--repair'] },
  { args: ['--check', '--repair'] },
  { args: ['--resolve-operation', '00000000-0000-0000-0000-000000000000', '--not-running', '--repair'] },
])('rejects invalid repair combination $args without checking or applying', async ({ args }) => {
  process.argv = [process.execPath, originalArgv[1], 'update', ...args];
  await import('../../src/cli/main.js');
  await vi.waitFor(() => expect(errors).not.toBe(''));
  expect(process.exitCode).toBe(2);
  expect(errors).toMatch(/repair.*apply|repair.*resolve|separately/i);
  expect(update.checkUpdate).not.toHaveBeenCalled();
  expect(update.applyUpdate).not.toHaveBeenCalled();
});
