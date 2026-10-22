import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('prepares a tagged read-only foreground watcher that exits only after the driver releases it', async () => {
  const base = mkdtempSync('/tmp/wwn-work-');
  const candidate = join(base, 'candidate');
  for (const name of ['dist', 'plugins', '.agents', '.claude-plugin', 'node_modules'])
    mkdirSync(join(candidate, name), { recursive: true });
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ version: 'test' }));
  writeFileSync(join(candidate, 'dist', 'main.js'), '// fixture package');
  const root = join(base, 'run');
  const prepared = spawnSync(
    process.execPath,
    [
      resolve('scripts/native-acceptance.mjs'),
      'prepare',
      '--root',
      root,
      '--candidate',
      candidate,
      '--claude-bin',
      process.execPath,
      '--codex-bin',
      process.execPath,
    ],
    { encoding: 'utf8' },
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const fixture = join(manifest.paths.workspace, '.wigwag-native-work.mjs');
  const tag = `claude-${manifest.id}`;
  const settings = JSON.parse(readFileSync(join(manifest.paths.claude, 'settings.json'), 'utf8'));
  expect(settings.permissions.allow).toContain(`Bash(node .wigwag-native-work.mjs ${tag})`);
  expect(settings.permissions.allow).not.toContain('Bash(sleep *)');
  const child = spawn(process.execPath, [fixture, tag], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    expect(String((await once(child.stdout, 'data'))[0])).toContain(`waiting ${tag}`);
    expect(child.exitCode).toBeNull();
    writeFileSync(join(manifest.paths.workspace, '.wigwag-native-release'), 'driver release\n');
    expect((await closed)[0]).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
  const refused = spawnSync(process.execPath, [fixture, 'other-run'], { encoding: 'utf8' });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('Unexpected native work tag');
});
