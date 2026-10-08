import { execFile, execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/** Upper bound on one `git rev-parse` call (spec §11 fixed constants). Not a tunable. */
export const GIT_TIMEOUT_MS = 2000;

const gitArgs = (cwd: string) => ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'];

type Outcome = 'repo' | 'not-repo' | 'git-unavailable' | 'timeout' | 'missing';

function classify(err: unknown): Outcome {
  const e = err as { code?: unknown; signal?: unknown; killed?: boolean };
  if (e.code === 'ENOENT') return 'git-unavailable';
  if (e.code === 'ETIMEDOUT' || e.killed || e.signal) return 'timeout';
  return 'not-repo';
}

/**
 * Workspace id (spec §17): the realpath of the git common dir when `cwd` is inside a git repository, so every
 * worktree of one repo is one workspace; otherwise the realpath of `cwd`. A missing `cwd` is returned unchanged.
 * Synchronous (CLI and fallbacks), with git bounded by GIT_TIMEOUT_MS. The broker uses WorkspaceResolver.
 */
export function resolveWorkspace(cwd: string): string {
  if (!existsSync(cwd)) return cwd;
  try {
    const out = execFileSync('git', gitArgs(cwd), {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }).trim();
    if (out) return realpathSync(out);
  } catch {
    // not a git repository, git unavailable or timed out: fall through to the directory itself
  }
  return realpathSync(cwd);
}

function probe(cwd: string): Promise<{ workspace: string; outcome: Outcome }> {
  if (!existsSync(cwd)) return Promise.resolve({ workspace: cwd, outcome: 'missing' });
  return new Promise((resolve) => {
    const fallback = (outcome: Outcome) => {
      try {
        resolve({ workspace: realpathSync(cwd), outcome });
      } catch {
        resolve({ workspace: cwd, outcome: 'missing' }); // removed meanwhile
      }
    };
    try {
      execFile(
        'git',
        gitArgs(cwd),
        { timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' },
        (err, stdout) => {
          if (err) return fallback(classify(err));
          const out = String(stdout).trim();
          if (!out) return fallback('not-repo');
          try {
            resolve({ workspace: realpathSync(out), outcome: 'repo' });
          } catch {
            fallback('not-repo');
          }
        },
      );
    } catch (e) {
      fallback(classify(e));
    }
  });
}

/**
 * Final review I-5: the broker's workspace lookup. git runs asynchronously (never blocking the event loop),
 * bounded by GIT_TIMEOUT_MS. Concurrent lookups share one call; successful repositories are cached by canonical cwd.
 * Resolve cwd aliases afresh, and don't cache fallback results: a plain directory can later become a repository.
 * "git unavailable" is logged once separately from "not a repository", which is a normal outcome.
 */
export class WorkspaceResolver {
  private readonly cache = new Map<string, Promise<string>>();
  private warnedUnavailable = false;

  constructor(private readonly log: (line: string) => void) {}

  async resolve(cwd: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(cwd);
    } catch {
      return cwd;
    }
    const hit = this.cache.get(canonical);
    if (hit) return hit;
    const p = probe(canonical).then(({ workspace, outcome }) => {
      if (outcome !== 'repo') this.cache.delete(canonical);
      if (outcome === 'timeout') {
        this.log(`git rev-parse in ${cwd} timed out after ${GIT_TIMEOUT_MS} ms; using the directory as its workspace`);
      } else if (outcome === 'git-unavailable' && !this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.log('git unavailable on the broker PATH; every directory is its own workspace (run: wigwag doctor)');
      }
      return workspace;
    });
    this.cache.set(canonical, p);
    return p;
  }
}

/** Display label: the repository directory for a `.../.git` common dir, otherwise the workspace path itself. */
export const workspaceLabel = (ws: string): string => (basename(ws) === '.git' ? dirname(ws) : ws);
