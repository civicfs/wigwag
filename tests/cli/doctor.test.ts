import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDoctorDb } from '../../src/cli/commands/doctor.js';
import { openDb } from '../../src/store/db.js';
import { recordLineage } from '../../src/store/recovery.js';
import { SCHEMA_V1, SCHEMA_V2 } from '../../src/store/schema.js';
import { bindAgentSession, claimName, createSession } from '../../src/store/sessions.js';
import { DIST_MAIN, tmpHome } from '../helpers.js';

function fixturePath(home: string): string {
  const bin = join(home, 'fake-bin');
  mkdirSync(bin);
  for (const [name, output] of [
    ['git', 'git version 2.0.0'],
    ['claude', '2.1.300'],
    ['wigwag', 'fixture'],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho '${output}'\n`);
    chmodSync(path, 0o755);
  }
  return `${bin}:${process.env.PATH}`;
}
const snapshot = (home: string) =>
  readdirSync(home, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => {
      const path = join(f.parentPath, f.name);
      return [path, createHash('sha256').update(readFileSync(path)).digest('hex')];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
const doctor = (home: string, path: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [DIST_MAIN, 'doctor', '--claude-only'], {
      env: { ...process.env, WIGWAG_HOME: home, PATH: path },
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });

describe('read-only doctor state diagnostics', () => {
  it('never starts a broker or creates a state database', async () => {
    const home = tmpHome(),
      path = fixturePath(home),
      before = snapshot(home);
    const r = await doctor(home, path);
    expect(r.stdout).toContain('broker');
    expect(existsSync(join(home, 'broker.sock'))).toBe(false);
    expect(existsSync(join(home, 'broker.lock'))).toBe(false);
    expect(existsSync(join(home, 'state.db'))).toBe(false);
    expect(snapshot(home)).toEqual(before);
  });
  it('reports schema/backups, link/parent/identity, recovery and Codex trust without changing them', async () => {
    const home = tmpHome(),
      path = fixturePath(home),
      db = openDb(join(home, 'state.db'));
    createSession(db, { agent: 'claude', cwd: home, pid_chain: [], mcp_ppid: null });
    const a = createSession(db, { agent: 'codex', cwd: home, pid_chain: [], mcp_ppid: null });
    const b = createSession(db, { agent: 'codex', cwd: home, pid_chain: [], mcp_ppid: null });
    claimName(db, a.id, 'unsafe\u001b[2J-worker', 'custom');
    bindAgentSession(db, a.id, 'T');
    bindAgentSession(db, b.id, 'T');
    db.prepare("UPDATE sessions SET link='disconnected' WHERE id=?").run(a.id);
    recordLineage(db, {
      agent: 'codex',
      native_id: 'T',
      workspace: a.workspace,
      session_id: b.id,
      canonical_session_id: a.id,
      cause: 'resume',
      outcome: 'flagged',
      reason: 'codex-thread-id-untrusted',
      evidence: {},
    });
    db.close();
    writeFileSync(join(home, 'state.db.pre-v3.bak'), 'fixture', { mode: 0o600 });
    const before = snapshot(home),
      r = await doctor(home, path);
    for (const text of [
      'schema version',
      '4',
      'state.db.pre-v3.bak',
      '0600',
      'MCP disconnected',
      '1 session',
      'parent unknown',
      'process identity',
      'unresolved recovery',
      'duplicate slots',
      'wigwag recovery',
      'Codex push untrusted',
      'unverified-bind',
      'bind_origin=unverified',
      'host_client_name=unknown',
      'host_client_version=unknown',
      'reload the Wigwag plugin / restart this Codex session to enable push',
    ])
      expect(r.stdout).toContain(text);
    expect(r.stdout).not.toContain('\u001b[2J');
    expect(snapshot(home)).toEqual(before);
  });
  it('reports an insecure backup mode without opening or changing the backup', async () => {
    const home = tmpHome(),
      path = fixturePath(home),
      backup = join(home, 'state.db.pre-v3.bak');
    writeFileSync(backup, 'private fixture', { mode: 0o644 });
    const before = snapshot(home);
    const r = await doctor(home, path);
    expect(r.stdout).toContain('0644');
    expect(r.stdout).toContain('expected 0600');
    expect(snapshot(home)).toEqual(before);
  });
  it('reads committed WAL content with existing sidecars without writing database bytes', () => {
    const home = tmpHome(),
      file = join(home, 'state.db'),
      writer = openDb(file);
    writer.exec('CREATE TABLE wal_probe(value); INSERT INTO wal_probe VALUES(42)');
    const before = readFileSync(file);
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(existsSync(`${file}-shm`)).toBe(true);
    const { db, fallback } = openDoctorDb(file);
    try {
      expect(db.prepare('SELECT value FROM wal_probe').get()).toEqual({ value: 42 });
      expect(fallback).toBe(false);
    } finally {
      db.close();
    }
    expect(readFileSync(file)).toEqual(before);
    writer.close();
  });
  it('falls back without deleting bookkeeping files when immutable URI support is unavailable', () => {
    const file = join(tmpHome(), 'state.db');
    openDb(file).close();
    const before = readFileSync(file),
      attempts: string[] = [];
    const { db, fallback } = openDoctorDb(file, (path) => {
      attempts.push(path);
      if (path.startsWith('file:'))
        throw Object.assign(new Error('URI unsupported'), { code: 'ERR_INVALID_ARG_VALUE' });
      return new DatabaseSync(path, { readOnly: true });
    });
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 4 });
      expect(fallback).toBe(true);
    } finally {
      db.close();
    }
    expect(attempts).toHaveLength(2);
    expect(readFileSync(file)).toEqual(before);
  });
  it('reports a legacy schema without migrating or backing it up', async () => {
    const home = tmpHome(),
      path = fixturePath(home),
      db = new DatabaseSync(join(home, 'state.db'));
    db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL)');
    db.exec(SCHEMA_V1);
    db.exec(SCHEMA_V2);
    db.exec('INSERT INTO schema_version VALUES(1),(2)');
    db.close();
    const before = snapshot(home),
      r = await doctor(home, path);
    expect(r.stdout).toContain('schema version');
    expect(r.stdout).toContain('2 (client requires 4)');
    expect(snapshot(home)).toEqual(before);
  });
});
