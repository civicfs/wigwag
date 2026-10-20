import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from '../../src/store/schema.js';
import { SCHEMA_VERSION } from '../../src/version.js';

const fixture = (version = 3) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ww-v4-')), 'state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL)');
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_V2);
  if (version >= 3) db.exec(SCHEMA_V3);
  db.exec(
    `INSERT INTO schema_version VALUES(1),(2)${version >= 3 ? ',(3)' : ''}; INSERT INTO messages(id,from_name,to_target,kind,priority,subject,body,attachments,created_at) VALUES('m','owner','worker','message','urgent','s','b','[]','t'); INSERT INTO deliveries(message_id,recipient,state,hold_reason,attempts,updated_at) VALUES('m','worker','held','${version >= 3 ? 'disconnected' : 'offline'}',2,'t');
    INSERT INTO sessions(id,name,agent,agent_session_id,cwd,workspace,pid_chain,state,transport,created_at,last_seen_at)
    VALUES('codex-old','old-worker','codex','T','/fixture','/fixture','[]','offline','codex-queue','t','t')`,
  );
  db.close();
  return file;
};
describe('schema v4 Codex push holds', () => {
  it.each([2, 3])(
    'preserves legacy relay data and marks already-answered native submissions unknown from v%s',
    (version) => {
      const file = fixture(version),
        old = new DatabaseSync(file);
      old.exec(`INSERT INTO sessions(id,name,agent,agent_session_id,cwd,workspace,pid_chain,state,transport,created_at,last_seen_at) VALUES('lead','leader','claude','L','/fixture','/fixture','[]','offline','claude-channel','t','t');
      INSERT INTO assignments(id,orchestrator_session_id,orchestrator_native_id,worker_session_id,worker_native_id,idempotency_key,payload_json,task_message_id,created_at) VALUES('a','lead','L','codex-old','T','key','{}','m','t');`);
      for (const [id, kind, state] of [
        ['sync', 'codex', 'answered'],
        ['async', 'codex_async', 'answered'],
        ['pending', 'codex_async', 'pending'],
        ['applied', 'codex_async', 'applied'],
      ])
        old
          .prepare(
            'INSERT INTO question_relays(id,assignment_id,native_session_id,turn_id,tool_use_id,kind,questions_json,answers_json,message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(id, 'a', 'T', 'turn', id, kind, '[]', '{}', 'm', state, 't', 't');
      old.close();
      const db = openDb(file);
      try {
        expect(db.prepare('SELECT id,state,submission_state FROM question_relays ORDER BY id').all()).toEqual([
          { id: 'applied', state: 'applied', submission_state: 'confirmed' },
          { id: 'async', state: 'answered', submission_state: 'unknown' },
          { id: 'pending', state: 'pending', submission_state: 'unsent' },
          { id: 'sync', state: 'answered', submission_state: 'unknown' },
        ]);
        expect(() => db.exec("UPDATE question_relays SET submission_state='invented'")).toThrow(/CHECK/);
        const backup = new DatabaseSync(`${file}.pre-v4.bak`, { readOnly: true });
        try {
          expect(backup.prepare('SELECT answers_json FROM question_relays').all()).toHaveLength(4);
          expect(
            (backup.prepare('PRAGMA table_info(question_relays)').all() as Array<{ name: string }>).some(
              (c) => c.name === 'submission_state',
            ),
          ).toBe(false);
        } finally {
          backup.close();
        }
        expect(statSync(`${file}.pre-v4.bak`).mode & 0o777).toBe(0o600);
      } finally {
        db.close();
      }
    },
  );

  it.each([2, 3])(
    'migrates v%s bindings unverified and widens diagnostic reasons without losing backup data',
    (version) => {
      const file = fixture(version),
        db = openDb(file);
      try {
        expect(
          db.prepare('SELECT bind_origin,host_client_name,host_client_version,codex_push_reason FROM sessions').get(),
        ).toEqual({
          bind_origin: 'unverified',
          host_client_name: null,
          host_client_version: null,
          codex_push_reason: 'unverified-bind',
        });
        for (const reason of ['unverified-bind', 'too-many-loaded', 'unreadable-loaded'])
          db.prepare('UPDATE sessions SET codex_push_reason=?').run(reason);
        expect(() => db.exec("UPDATE sessions SET codex_push_reason='invented'")).toThrow(/CHECK/);
        expect(
          (db.prepare('PRAGMA table_info(question_relays)').all() as Array<{ name: string }>).map((c) => c.name),
        ).toContain('submission_state');
        expect(db.prepare('SELECT forward_to FROM deliveries').get()).toEqual({ forward_to: null });
        db.exec("UPDATE deliveries SET forward_to='codex-old'");
        expect(() => db.exec("UPDATE deliveries SET forward_to='missing-slot'")).toThrow(/FOREIGN KEY/);
        expect(db.prepare('SELECT forward_to FROM deliveries').get()).toEqual({ forward_to: 'codex-old' });
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        for (const v of version === 2 ? [3, 4] : [4]) {
          const bak = `${file}.pre-v${v}.bak`;
          expect(statSync(bak).mode & 0o777).toBe(0o600);
          const copy = new DatabaseSync(bak, { readOnly: true });
          expect(copy.prepare('SELECT body FROM messages').get()).toEqual({ body: 'b' });
          copy.close();
        }
      } finally {
        db.close();
      }
    },
  );
  it('backs up v3 mode0600, preserves rows/indexes/FKs, and accepts the new hold reason', () => {
    const file = fixture(),
      db = openDb(file);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: SCHEMA_VERSION });
      expect(db.prepare('SELECT state,hold_reason,attempts FROM deliveries').get()).toEqual({
        state: 'held',
        hold_reason: 'disconnected',
        attempts: 2,
      });
      db.exec("UPDATE deliveries SET hold_reason='codex-untrusted'");
      expect(() => db.exec("UPDATE deliveries SET hold_reason='bogus'")).toThrow(/CHECK/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deliveries'")
          .all()
          .map((r) => r.name),
      ).toEqual(expect.arrayContaining(['deliveries_state', 'deliveries_recipient_state']));
      const bak = `${file}.pre-v4.bak`;
      expect(statSync(bak).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(bak, { readOnly: true });
      expect(copy.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 3 });
      copy.close();
    } finally {
      db.close();
    }
  });
  it('refuses a pre-existing backup without changing it', () => {
    const file = fixture();
    writeFileSync(`${file}.pre-v4.bak`, 'keep');
    expect(() => openDb(file)).toThrow(/pre-v4.bak already exists/);
    expect(readFileSync(`${file}.pre-v4.bak`, 'utf8')).toBe('keep');
  });
  it('removes only its own backup after rollback and permits retry', () => {
    const file = fixture(),
      exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      exec.call(this, sql);
      if (sql.includes('CREATE TABLE deliveries_v4')) throw new Error('fixture failure');
    });
    try {
      expect(() => openDb(file)).toThrow('fixture failure');
      expect(existsSync(`${file}.pre-v4.bak`)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const db = openDb(file);
    expect(db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: SCHEMA_VERSION });
    db.close();
  });
});
