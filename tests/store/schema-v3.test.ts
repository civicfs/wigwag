import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb, preV3BackupPath } from '../../src/store/db.js';
import { SCHEMA_V1, SCHEMA_V2 } from '../../src/store/schema.js';
import { getSession } from '../../src/store/sessions.js';

const v2File = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ww-v3-')), 'state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_V2);
  db.exec('INSERT INTO schema_version (version) VALUES (1), (2)');
  const ins = db.prepare(
    `INSERT INTO sessions (id, name, agent, agent_session_id, cwd, workspace, pid_chain, mcp_ppid, state, transport,
       created_at, last_seen_at) VALUES (?, ?, 'claude', NULL, '/w', '/w', '[]', NULL, 'offline', 'claude-channel', 't', 't')`,
  );
  ins.run('ses-a', 'claude-myproject-ab2c');
  ins.run('ses-b', 'codex-merger');
  ins.run('ses-c', null);
  // Documented limitation: a registered name with the provisional shape migrates as provisional.
  ins.run('ses-d', 'codex-wigwag-help');
  db.exec(`INSERT INTO messages (id, from_name, from_workspace, to_target, kind, priority, subject, body, attachments,
    reply_to, request_id, expires_at, stream, created_at)
    VALUES ('msg-1', 'owner', NULL, 'codex-merger', 'message', 'low', 's', 'b', '[]', NULL, NULL, NULL, NULL, 't')`);
  db.exec(`INSERT INTO deliveries (message_id, recipient, state, hold_reason, attempts, updated_at)
    VALUES ('msg-1', 'codex-merger', 'held', 'low', 0, 't')`);
  db.close();
  return file;
};
const version = (db: DatabaseSync) =>
  (db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number }).v;

describe('schema v3', () => {
  it('migrates a v2 database: session columns, name_source from the name shape, new tables', () => {
    const db = openDb(v2File());
    expect(version(db)).toBe(3);
    expect(['ses-a', 'ses-b', 'ses-c', 'ses-d'].map((id) => getSession(db, id)?.name_source)).toEqual([
      'provisional',
      'custom',
      'provisional',
      'provisional',
    ]);
    expect(getSession(db, 'ses-b')).toMatchObject({
      native_name: null,
      native_ref: null,
      conn_generation: 0,
      retired_at: null,
      retired_into: null,
      link: 'connected',
      parent_state: 'unknown',
      agent_pid: null,
      agent_start: null,
      parent_checked_at: null,
    });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['session_lineage', 'session_renames']));
  });

  it('reopening a v3 database is a no-op and a fresh database starts at v3', () => {
    const file = v2File();
    openDb(file).close();
    const again = openDb(file);
    expect(version(again)).toBe(3);
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), 'ww-v3-')), 'state.db'));
    expect(version(fresh)).toBe(3);
  });

  it('keeps session_renames append-only and name_source inside its enum', () => {
    const db = openDb(v2File());
    db.prepare(
      `INSERT INTO session_renames (session_id, from_name, to_name, cause, name_source, mail_moved,
         subscriptions_moved, mutes_moved, at) VALUES ('ses-b', NULL, 'x-name', 'register', 'custom', 0, 0, 0, 't')`,
    ).run();
    expect(() => db.prepare("UPDATE session_renames SET to_name = 'y-name'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM session_renames').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE sessions SET name_source = 'other' WHERE id = 'ses-b'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE sessions SET link = 'half' WHERE id = 'ses-b'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE sessions SET parent_state = 'maybe' WHERE id = 'ses-b'").run()).toThrow(/CHECK/);
  });

  it('rebuilds deliveries: rows survive, indexes exist, and the disconnected hold reason is accepted', () => {
    const db = openDb(v2File());
    expect(db.prepare('SELECT message_id, recipient, state, hold_reason FROM deliveries').all()).toEqual([
      { message_id: 'msg-1', recipient: 'codex-merger', state: 'held', hold_reason: 'low' },
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deliveries'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toEqual(expect.arrayContaining(['deliveries_recipient_state', 'deliveries_state']));
    db.prepare("UPDATE deliveries SET hold_reason = 'disconnected'").run();
    expect(() => db.prepare("UPDATE deliveries SET hold_reason = 'bogus'").run()).toThrow(/CHECK/);
  });
});

describe('pre-v3 backup', () => {
  const counts = (db: DatabaseSync) =>
    ['sessions', 'messages', 'deliveries'].map(
      (t) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    );

  it('backs up a v2 database before migrating: mode 0600, same row counts, kept after success', () => {
    const file = v2File();
    const before = new DatabaseSync(file);
    const want = counts(before);
    before.close();
    const db = openDb(file);
    expect(version(db)).toBe(3);
    const bak = preV3BackupPath(file);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(bak, { readOnly: true });
    expect(version(copy)).toBe(2);
    expect(counts(copy)).toEqual(want);
    copy.close();
    expect(readdirSync(dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to migrate when an earlier backup already exists, and leaves it untouched', () => {
    const file = v2File();
    writeFileSync(preV3BackupPath(file), 'earlier attempt');
    expect(() => openDb(file)).toThrow(/pre-v3\.bak already exists/);
    expect(readFileSync(preV3BackupPath(file), 'utf8')).toBe('earlier attempt');
    const raw = new DatabaseSync(file);
    expect(version(raw)).toBe(2);
    raw.close();
  });

  it('refuses to migrate when the backup cannot be written', () => {
    const file = v2File();
    mkdirSync(`${file}.pre-v3.${process.pid}.tmp`); // VACUUM INTO cannot write over a directory
    expect(() => openDb(file)).toThrow(/could not back up .* before the schema v3 migration/);
    expect(existsSync(preV3BackupPath(file))).toBe(false);
    const raw = new DatabaseSync(file);
    expect(version(raw)).toBe(2);
    raw.close();
  });

  it('makes no backup for an already-v3 database or a fresh file', () => {
    const file = v2File();
    openDb(file).close();
    rmSync(preV3BackupPath(file));
    openDb(file).close();
    expect(existsSync(preV3BackupPath(file))).toBe(false);
    const fresh = join(mkdtempSync(join(tmpdir(), 'ww-v3-')), 'state.db');
    openDb(fresh).close();
    expect(existsSync(preV3BackupPath(fresh))).toBe(false);
  });
});
