import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { claimMessageRecipient, messageAddressedTo, messageSender } from '../../src/store/ownership.js';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4 } from '../../src/store/schema.js';

const fixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ww-v5-')), 'state.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL); ${SCHEMA_V1} ${SCHEMA_V2} ${SCHEMA_V3} ${SCHEMA_V4}
    INSERT INTO schema_version VALUES(1),(2),(3),(4);
    INSERT INTO sessions(id,name,agent,cwd,workspace,pid_chain,state,transport,created_at,last_seen_at)
    VALUES('sender','sender-two','claude','/w','/w','[]','offline','claude-channel','2026-01-01','2026-01-03'),
      ('worker','worker-two','codex','/w','/w','[]','offline','codex-queue','2026-01-01','2026-01-03'),
      ('replacement','sender-one','claude','/w','/w','[]','offline','claude-channel','2026-01-03','2026-01-03');
    INSERT INTO name_claims VALUES('sender-one','sender','2026-01-01','2026-01-03'),
      ('worker-one','worker','2026-01-01','2026-01-03'), ('sender-one','replacement','2026-01-03',NULL);
    INSERT INTO messages(id,from_name,to_target,kind,priority,subject,body,attachments,request_id,created_at)
    VALUES('proven','sender-one','worker-one','request','normal','s','b','[]','req-proven','2026-01-02'),
      ('unknown','sender-one','never-held','request','normal','s','b','[]','req-unknown','2025-01-02');
    INSERT INTO deliveries(message_id,recipient,state,updated_at) VALUES('proven','worker-two','held','2026-01-03'),
      ('unknown','never-held','held','2026-01-03');`);
  db.close();
  return file;
};

describe('schema v5 message ownership', () => {
  it('backs up v4, pins proven historical participants and leaves unproven names unowned', () => {
    const file = fixture();
    const db = openDb(file);
    try {
      expect(db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 5 });
      expect(
        db.prepare('SELECT message_id,sender_session_id,mode FROM message_ownership ORDER BY message_id').all(),
      ).toEqual([
        { message_id: 'proven', sender_session_id: 'sender', mode: 'historical' },
        { message_id: 'unknown', sender_session_id: null, mode: 'historical' },
      ]);
      expect(db.prepare('SELECT message_id,recipient_session_id FROM deliveries ORDER BY message_id').all()).toEqual([
        { message_id: 'proven', recipient_session_id: 'worker' },
        { message_id: 'unknown', recipient_session_id: null },
      ]);
      expect(() => db.exec("UPDATE message_ownership SET sender_session_id='replacement'")).toThrow(/append-only/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(messageSender(db, 'proven')?.id).toBe('sender');
      expect(messageSender(db, 'unknown')).toBeUndefined();
      expect(messageAddressedTo(db, 'proven', 'worker')).toBe(true);
      expect(messageAddressedTo(db, 'proven', 'replacement')).toBe(false);
      db.exec("UPDATE sessions SET name='never-held' WHERE id='replacement'");
      expect(claimMessageRecipient(db, 'unknown', 'replacement')).toBe(false);
      const backup = new DatabaseSync(`${file}.pre-v5.bak`, { readOnly: true });
      expect(backup.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 4 });
      expect(backup.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 2 });
      backup.close();
      expect(statSync(`${file}.pre-v5.bak`).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it('refuses an existing v5 backup and preserves it', () => {
    const file = fixture();
    writeFileSync(`${file}.pre-v5.bak`, 'preserve');
    expect(() => openDb(file)).toThrow(/pre-v5.bak already exists/);
    expect(readFileSync(`${file}.pre-v5.bak`, 'utf8')).toBe('preserve');
  });

  it('rolls back failed migration and removes only its own backup so retry can proceed', () => {
    const file = fixture();
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      exec.call(this, sql);
      if (sql.includes('CREATE TABLE message_ownership')) throw new Error('fixture ownership migration failure');
    });
    try {
      expect(() => openDb(file)).toThrow('fixture ownership migration failure');
      expect(existsSync(`${file}.pre-v5.bak`)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const db = openDb(file);
    expect(db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 5 });
    db.close();
  });
});
