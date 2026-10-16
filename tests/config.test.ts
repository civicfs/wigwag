import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initHome, loadConfig, resolveHome } from '../src/config.js';
import { WigwagError } from '../src/errors.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'ww-')), 'home');

describe('config', () => {
  it('resolves home from WIGWAG_HOME, then XDG_STATE_HOME, then ~/.wigwag', () => {
    expect(resolveHome({ WIGWAG_HOME: '/x' })).toBe('/x');
    expect(resolveHome({ XDG_STATE_HOME: '/s' })).toBe('/s/wigwag');
    expect(resolveHome({})).toMatch(/\.wigwag$/);
  });
  it('init writes an explicit config with 0600 and home 0700, and is idempotent', () => {
    const home = fresh();
    const r = initHome(home, '/usr/local/bin/codex');
    expect(r.created).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    const cfg = loadConfig(home);
    expect(cfg.codex.binary).toBe('/usr/local/bin/codex');
    expect(cfg.spawn.enabled).toBe(false);
    expect(cfg.rehearsal).toEqual({ enabled: false, allow_external_paths: false });
    expect(cfg.hooks).toEqual({ deadline_ms: 5000, max_stdin_bytes: 1048576 });
    expect(initHome(home, '/other').created).toBe(false);
    expect(loadConfig(home).codex.binary).toBe('/usr/local/bin/codex');
  });
  it('missing config tells you to run init', () => {
    expect(() => loadConfig(fresh())).toThrow(/Run: wigwag init/);
  });
  it('rejects unknown keys and spawn.enabled=true', () => {
    const home = fresh();
    const { path } = initHome(home, '/c');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...cfg, extra: 1 }));
    expect(() => loadConfig(home)).toThrow(WigwagError);
    writeFileSync(path, JSON.stringify({ ...cfg, spawn: { enabled: true } }));
    expect(() => loadConfig(home)).toThrow(/spawn/);
  });
  it('schema-invalid config is a config error with init guidance', () => {
    const home = fresh();
    const { path } = initHome(home, '/c');
    writeFileSync(path, JSON.stringify({ extra: 1 }));
    try {
      loadConfig(home);
      expect.unreachable();
    } catch (e) {
      expect((e as WigwagError).code).toBe('config');
      expect((e as Error).message).toMatch(/Run: wigwag init/);
    }
  });
  it('init enforces 0600 on an existing config without changing contents', () => {
    const home = fresh();
    const { path } = initHome(home, '/c');
    chmodSync(path, 0o644);
    const before = readFileSync(path, 'utf8');
    const r = initHome(home, '/other');
    expect(r.created).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('init adds keys a newer wigwag introduced and keeps every other value', () => {
    const home = fresh();
    const { path } = initHome(home, '/c');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    cfg.codex.name_wait_ms = undefined;
    cfg.codex.queue_timeout_ms = 7;
    cfg.hooks = undefined;
    writeFileSync(path, JSON.stringify(cfg));
    expect(() => loadConfig(home)).toThrow(/Run: wigwag init/);
    const r = initHome(home, '/other');
    expect(r.created).toBe(false);
    expect(r.added.sort()).toEqual(['codex.name_wait_ms', 'hooks']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const after = loadConfig(home);
    expect(after.codex).toEqual({ binary: '/c', queue_timeout_ms: 7, name_wait_ms: 120000, trusted_host_versions: [] });
    expect(after.hooks).toEqual({ deadline_ms: 5000, max_stdin_bytes: 1048576 });
    expect(initHome(home, '/other').added).toEqual([]);
  });
  it('loads a 0.2-shaped config without init or writing the file', () => {
    const home = fresh();
    const { path } = initHome(home, '/c');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    delete cfg.rehearsal;
    delete cfg.codex.trusted_host_versions;
    delete cfg.questions.codex_idle_grace_ms;
    const original = JSON.stringify(cfg);
    writeFileSync(path, original);
    const loaded = loadConfig(home);
    expect(loaded.rehearsal).toEqual({ enabled: false, allow_external_paths: false });
    expect(loaded.codex.trusted_host_versions).toEqual([]);
    // This optional key stays absent; the question adapter applies its documented 2000 ms fallback.
    expect(loaded.questions.codex_idle_grace_ms).toBeUndefined();
    expect(loaded.codex.binary).toBe('/c');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('init leaves a file that is not a JSON object alone', () => {
    const home = fresh();
    const { path } = initHome(home, '/c');
    writeFileSync(path, '{not json');
    expect(initHome(home, '/c')).toMatchObject({ created: false, added: [] });
    expect(readFileSync(path, 'utf8')).toBe('{not json');
    writeFileSync(path, '[1]');
    expect(initHome(home, '/c').added).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('[1]');
  });
});
