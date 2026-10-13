import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, checkUpdate, notifyUpdate, type Run } from '../../src/update/update.js';
import { VERSION } from '../../src/version.js';

afterEach(() => vi.restoreAllMocks());
const next = '99.0.0';
describe('npm updates', () => {
  it('checks releases without running an installer and never offers a downgrade', async () => {
    expect(await checkUpdate(async () => next)).toMatchObject({
      source: 'npm',
      available: next,
      update_available: true,
    });
    for (const v of [VERSION, '0.0.1'])
      expect(await checkUpdate(async () => v)).toMatchObject({ update_available: false });
    await expect(checkUpdate(async () => 'latest; echo unsafe')).rejects.toThrow('Invalid release');
  });
  it('applies the exact npm version and refreshes plugins and broker in order', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ww-update-'));
    mkdirSync(join(base, '@civicfs'));
    const root = join(base, '@civicfs', 'wigwag');
    mkdirSync(root);
    const calls: Array<[string, string[]]> = [];
    const execute: Run = async (bin, args) => {
      calls.push([bin, args]);
      if (bin === 'claude' && args[1] === 'list') return JSON.stringify([{ id: 'wigwag@wigwag' }]);
      if (bin === 'codex' && args[1] === 'list') return JSON.stringify({ installed: [{ pluginId: 'wigwag@wigwag' }] });
      return bin === 'npm' && args[0] === 'root' ? base : '';
    };
    await applyUpdate(root, await checkUpdate(async () => next), execute, () => true, 'codex');
    expect(calls).toEqual([
      ['npm', ['root', '--global']],
      ['claude', ['plugin', 'list', '--json']],
      ['codex', ['plugin', 'list', '--json']],
      ['npm', ['install', '--global', '@civicfs/wigwag@99.0.0', '--ignore-scripts']],
      ['wigwag', ['install']],
      ['claude', ['plugin', 'update', 'wigwag@wigwag']],
      ['wigwag', ['broker', 'restart', '--expect-version', next]],
    ]);
  });
  it('refuses a project dependency install and never touches Git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ww-project-'));
    const calls: string[] = [];
    await expect(
      applyUpdate(root, await checkUpdate(async () => next), async (bin) => {
        calls.push(bin);
        return root;
      }),
    ).rejects.toThrow('not a global CLI');
    expect(calls).toEqual(['npm']);
  });
  it('stops on an install failure before refreshing plugins or restarting the broker', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ww-update-fail-'));
    mkdirSync(join(base, '@civicfs'));
    const root = join(base, '@civicfs', 'wigwag');
    mkdirSync(root);
    const execute = vi
      .fn<Run>()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(JSON.stringify([{ id: 'wigwag@wigwag' }]))
      .mockRejectedValueOnce(new Error('npm unavailable'));
    await expect(
      applyUpdate(root, await checkUpdate(async () => next), execute, (name) => name === 'claude', 'codex'),
    ).rejects.toThrow('npm unavailable');
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('refuses a development checkout link before changing the installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ww-dev-'));
    mkdirSync(join(root, '.git'));
    const execute = vi.fn<Run>();
    await expect(applyUpdate(root, await checkUpdate(async () => next), execute)).rejects.toThrow(
      'Development checkout',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('preserves a Codex-only installation and skips Claude refresh', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ww-codex-only-'));
    mkdirSync(join(base, '@civicfs'));
    const root = join(base, '@civicfs', 'wigwag');
    mkdirSync(root);
    const execute = vi.fn<Run>().mockImplementation(async (bin, args) => {
      if (bin === 'npm' && args[0] === 'root') return base;
      if (bin === 'codex' && args[1] === 'list') return JSON.stringify({ installed: [{ pluginId: 'wigwag@wigwag' }] });
      return '';
    });
    await applyUpdate(root, await checkUpdate(async () => next), execute, (name) => name === 'codex', 'codex');
    expect(execute.mock.calls.some(([bin]) => bin === 'claude')).toBe(false);
    expect(execute).toHaveBeenCalledWith('wigwag', ['install', '--codex-only'], root);
    expect(execute).toHaveBeenCalledWith('wigwag', ['broker', 'restart', '--expect-version', next], root);
  });
  it('rejects globally linked package subdirectories before npm installation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ww-linked-'));
    mkdirSync(join(base, '@civicfs'));
    const root = join(base, 'package-subdirectory');
    mkdirSync(root);
    symlinkSync(root, join(base, '@civicfs', 'wigwag'));
    const execute = vi.fn<Run>().mockResolvedValue(base);
    await expect(applyUpdate(root, await checkUpdate(async () => next), execute)).rejects.toThrow('Linked development');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('uses the configured Codex binary even when PATH has no codex', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ww-custom-codex-'));
    mkdirSync(join(base, '@civicfs'));
    const root = join(base, '@civicfs', 'wigwag');
    mkdirSync(root);
    const custom = '/custom/bin/codex';
    const execute = vi.fn<Run>().mockImplementation(async (bin, args) => {
      if (bin === 'npm' && args[0] === 'root') return base;
      if (bin === custom) return JSON.stringify({ installed: [{ pluginId: 'wigwag@wigwag' }] });
      return '';
    });
    await applyUpdate(root, await checkUpdate(async () => next), execute, (name) => name === custom, custom);
    expect(execute).toHaveBeenCalledWith(custom, ['plugin', 'list', '--json'], root);
    expect(execute).toHaveBeenCalledWith('wigwag', ['install', '--codex-only'], root);
  });
  it('caches launch checks for a day and only prints a notice', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ww-notice-'));
    const read = vi.fn(async () => next);
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await notifyUpdate(home, read);
    await notifyUpdate(home, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.flat().join('')).toContain('wigwag update --apply');
    expect(JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8')).status.update_available).toBe(true);
  });
  it('caches failures and never breaks an offline launch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ww-offline-'));
    const read = vi.fn(async () => {
      throw new Error('offline');
    });
    await notifyUpdate(home, read);
    await notifyUpdate(home, read);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
