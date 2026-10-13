import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../scripts/check-package.mjs');
describe('npm package guard', () => {
  it('rejects a package missing the CLI module loaded by its bootstrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'ww-pack-'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'main.js'), 'import("./cli.js");');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'wigwag-synthetic-fixture', version: '0.0.0', files: ['dist'] }),
    );
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required npm package files');
    expect(result.stderr).toContain('dist/cli.js');
  });

  it('rejects private files hidden inside a packaged build directory without executing package hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ww-pack-'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'auth.json'), 'fictional-sensitive-value');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'wigwag-synthetic-fixture',
        version: '0.0.0',
        files: ['dist'],
        scripts: { prepack: "node -e \"require('node:fs').writeFileSync('hook-ran','yes')\"" },
      }),
    );
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/auth.json');
    expect(result.stderr).not.toContain('fictional-sensitive-value');
    expect(existsSync(join(root, 'hook-ran'))).toBe(false);
    expect(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }),
    ).toContain('dist/auth.json');
  });
});
