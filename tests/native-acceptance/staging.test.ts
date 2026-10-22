import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fingerprintPackage, stagePackage } from '../../scripts/native-acceptance/package.mjs';

it('replaces the exact candidate code and dependency root while preserving the previous package', () => {
  const root = mkdtempSync(join(tmpdir(), 'wwn-stage-test-'));
  const fixture = (name: string, extra: boolean) => {
    const path = join(root, name);
    for (const dir of ['dist', 'plugins', '.agents', '.claude-plugin', 'node_modules'])
      mkdirSync(join(path, dir), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ version: name }));
    writeFileSync(join(path, 'dist', 'main.js'), name);
    writeFileSync(join(path, 'dist', 'cli.js'), `cli:${name}`);
    if (extra) writeFileSync(join(path, 'plugins', 'removed-in-candidate.json'), '{}');
    return path;
  };
  const baseline = fixture('baseline', true);
  const candidate = fixture('candidate', false);
  const installed = join(root, 'installed');
  mkdirSync(installed);
  stagePackage(baseline, installed, fingerprintPackage(baseline).sha256);
  stagePackage(candidate, installed, fingerprintPackage(candidate).sha256);
  expect(fingerprintPackage(installed)).toEqual(fingerprintPackage(candidate));
  expect(readdirSync(join(installed, 'plugins'))).toEqual([]);
  expect(realpathSync(join(installed, 'node_modules'))).toBe(realpathSync(join(candidate, 'node_modules')));
  const history = join(root, 'installation-history');
  expect(
    readdirSync(history).some((entry) => {
      try {
        return readFileSync(join(history, entry, 'installed', 'dist', 'cli.js'), 'utf8') === 'cli:baseline';
      } catch {
        return false;
      }
    }),
  ).toBe(true);
});
