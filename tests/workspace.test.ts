import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_TIMEOUT_MS, resolveWorkspace, WorkspaceResolver, workspaceLabel } from '../src/workspace.js';
import { fakeGitDir, gitRepo, gitWorktree, REAL_GIT, WAIT_MS } from './helpers.js';

const PATH = process.env.PATH;

/**
 * git is bounded by GIT_TIMEOUT_MS and a starved lookup falls back to the directory (spec §17), so a test of what git
 * answers retries until git has answered in time; the bound itself is tested separately with a hung git.
 */
const gitAnswers = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: WAIT_MS, interval: 50 });
afterEach(() => {
  process.env.PATH = PATH;
});

describe('resolveWorkspace', () => {
  it('maps a repo root, a subdirectory and a worktree of the same repo to one id', async () => {
    const repo = gitRepo();
    const wt = gitWorktree(repo);
    const id = join(realpathSync(repo), '.git');
    await gitAnswers(() => {
      expect(resolveWorkspace(repo)).toBe(id);
      expect(resolveWorkspace(join(repo, 'sub'))).toBe(id);
      expect(resolveWorkspace(wt)).toBe(id);
    });
    expect(workspaceLabel(id)).toBe(realpathSync(repo));
  });

  it('a different repo is a different workspace', () => {
    expect(resolveWorkspace(gitRepo())).not.toBe(resolveWorkspace(gitRepo()));
  });

  it('a non-repo directory is its realpath; its label is the path; a missing cwd is returned unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-n-'));
    expect(resolveWorkspace(dir)).toBe(realpathSync(dir));
    expect(workspaceLabel(realpathSync(dir))).toBe(realpathSync(dir));
    expect(resolveWorkspace('/w/does-not-exist')).toBe('/w/does-not-exist');
    expect(dirname(resolveWorkspace(dir))).toBe(realpathSync(dirname(dir)));
  });
});

describe('git bounds and cache (final I-5)', () => {
  it('a hung git is bounded by GIT_TIMEOUT_MS: the directory is used and the timeout is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-n-'));
    process.env.PATH = `${fakeGitDir('exec sleep 30')}:${PATH}`;
    const lines: string[] = [];
    const r = new WorkspaceResolver((l) => lines.push(l));
    const t0 = Date.now();
    expect(await r.resolve(dir)).toBe(realpathSync(dir));
    expect(Date.now() - t0).toBeLessThan(GIT_TIMEOUT_MS + 1500);
    expect(lines.join('\n')).toMatch(/timed out/);
    const t1 = Date.now();
    expect(resolveWorkspace(dir)).toBe(realpathSync(dir));
    expect(Date.now() - t1).toBeLessThan(GIT_TIMEOUT_MS + 1500);
  });

  it('caches per cwd: concurrent and repeated lookups run git once', async () => {
    const repo = gitRepo();
    await gitAnswers(async () => {
      // A fresh resolver and counter per attempt: an attempt whose git was starved past the bound falls back to the
      // directory (and, by design, is not cached), so it says nothing about caching. A real caching bug fails every attempt.
      const count = join(mkdtempSync(join(tmpdir(), 'ww-c-')), 'count');
      process.env.PATH = `${fakeGitDir(`echo x >> '${count}'; exec '${REAL_GIT}' "$@"`)}:${PATH}`;
      const r = new WorkspaceResolver(() => {});
      const ids = await Promise.all(Array.from({ length: 5 }, () => r.resolve(repo)));
      for (let i = 0; i < 5; i++) ids.push(await r.resolve(repo));
      expect(new Set(ids)).toEqual(new Set([join(realpathSync(repo), '.git')]));
      expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    });
  });

  it('logs "git unavailable" when git is not on PATH, separately from "not a repository"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-n-'));
    const lines: string[] = [];
    process.env.PATH = mkdtempSync(join(tmpdir(), 'ww-e-'));
    expect(await new WorkspaceResolver((l) => lines.push(l)).resolve(dir)).toBe(realpathSync(dir));
    expect(lines.join('\n')).toMatch(/git unavailable/);
    process.env.PATH = PATH;
    const quiet: string[] = [];
    expect(await new WorkspaceResolver((l) => quiet.push(l)).resolve(dir)).toBe(realpathSync(dir));
    expect(quiet).toEqual([]);
  });
  it('bounds a git process that ignores SIGTERM (final Codex I-5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-n-'));
    process.env.PATH = `${fakeGitDir(`exec '${process.execPath}' -e 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(1), 5000)'`)}:${PATH}`;
    const t0 = Date.now();
    expect(await new WorkspaceResolver(() => {}).resolve(dir)).toBe(realpathSync(dir));
    expect(Date.now() - t0).toBeLessThan(GIT_TIMEOUT_MS + 1500);
  });
  it('retries when git returns to PATH instead of caching an unavailable result (final Codex I-5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-n-'));
    const resolver = new WorkspaceResolver(() => {});
    process.env.PATH = mkdtempSync(join(tmpdir(), 'ww-e-'));
    expect(await resolver.resolve(dir)).toBe(realpathSync(dir));
    const repo = mkdtempSync(join(tmpdir(), 'ww-git-common-'));
    process.env.PATH = `${fakeGitDir(`echo '${repo}'`)}:${PATH}`;
    expect(await resolver.resolve(dir)).toBe(realpathSync(repo));
  });
  it('discovers a repository created in a previously plain directory (final Codex I-5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-n-'));
    const resolver = new WorkspaceResolver(() => {});
    expect(await resolver.resolve(dir)).toBe(realpathSync(dir));
    execFileSync(REAL_GIT, ['init', '-q', dir]);
    expect(await resolver.resolve(dir)).toBe(realpathSync(join(dir, '.git')));
  });
  it('invalidates a cwd alias when the symlink is retargeted (final Codex I-5)', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ww-a-'));
    const b = mkdtempSync(join(tmpdir(), 'ww-b-'));
    for (const dir of [a, b]) execFileSync(REAL_GIT, ['init', '-q', dir]);
    const alias = join(mkdtempSync(join(tmpdir(), 'ww-alias-')), 'cwd');
    const resolver = new WorkspaceResolver(() => {});
    symlinkSync(a, alias);
    expect(await resolver.resolve(alias)).toBe(realpathSync(join(a, '.git')));
    unlinkSync(alias);
    symlinkSync(b, alias);
    expect(await resolver.resolve(alias)).toBe(realpathSync(join(b, '.git')));
  });
});
