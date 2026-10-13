import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../scripts/check-public.mjs');
function check(name: string, contents: string) {
  const root = mkdtempSync(join(tmpdir(), 'ww-public-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, name), contents);
  execFileSync('git', ['add', '-f', name], { cwd: root });
  return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
}
describe('public repository guard', () => {
  it('allows source and synthetic fixture paths', () => {
    expect(check('example.ts', "const path = '/Users/x/code/test';").status).toBe(0);
  });
  it('rejects private state filenames without printing file contents', () => {
    const result = check('.env', 'fictional-sensitive-value');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private/generated file');
    expect(result.stderr).not.toContain('fictional-sensitive-value');
  });
  it('rejects secret-shaped strings without exposing them', () => {
    const value = 'sk-proj-' + 'x'.repeat(32);
    const result = check('accident.txt', value);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('credential pattern');
    expect(result.stderr).not.toContain(value);
  });
});
