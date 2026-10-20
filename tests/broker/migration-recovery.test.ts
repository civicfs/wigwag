import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { preV3BackupPath } from '../../src/store/db.js';
import { SCHEMA_V1, SCHEMA_V2 } from '../../src/store/schema.js';
import { mcpClient, startBroker, tmpHome } from '../helpers.js';

it('migrates v2 duplicates, saves a private backup, and recovers the assigned slot with its held mail', async () => {
  const home = tmpHome();
  const file = join(home, 'state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL)');
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_V2);
  db.exec('INSERT INTO schema_version VALUES (1),(2)');
  const insert = db.prepare(`INSERT INTO sessions
    (id,name,agent,agent_session_id,cwd,workspace,pid_chain,mcp_ppid,state,transport,created_at,last_seen_at)
    VALUES (?,?,'claude',?,'/w/myproject','/w/myproject','[]',NULL,'offline','claude-channel','t','t')`);
  insert.run('s-lead', 'lead-one', 'L');
  insert.run('s-dup1', 'claude-project-ab2c', 'sid-migrated');
  insert.run('s-dup2', 'claude-project-bc3d', 'sid-migrated');
  insert.run('s-dup3', null, 'sid-migrated');
  const mail = { id: 'msg-migrated' };
  db.exec(`INSERT INTO messages(id,from_name,to_target,kind,priority,subject,body,attachments,created_at)
    VALUES('msg-migrated','owner','claude-project-ab2c','message','low','retained','b','[]','t');
    INSERT INTO deliveries(message_id,recipient,state,hold_reason,updated_at)
    VALUES('msg-migrated','claude-project-ab2c','held','low','t');`);
  db.prepare('INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(
    'req-migrated',
    's-lead',
    'L',
    's-dup1',
    'sid-migrated',
    'k',
    '{}',
    mail.id,
    't',
  );
  db.close();
  const broker = await startBroker(home);
  const fresh = await mcpClient(home);
  const { client: hook } = await Client.connect(
    sockPath(home),
    { protocol: 1, role: 'hook' },
    frameLimit(loadConfig(home)),
  );
  try {
    expect(statSync(preV3BackupPath(file)).mode & 0o777).toBe(0o600);
    await hook.call('hook.event', {
      agent: 'claude',
      event: 'SessionStart',
      agent_session_id: 'sid-migrated',
      cwd: '/w/myproject',
      pid_chain: [9, 2],
      agent_pid: 2,
    });
    expect(await fresh.client.call('session.whoami')).toMatchObject({
      id: 's-dup1',
      name: 'claude-project-ab2c',
      unread: 1,
    });
    expect(
      broker.db.prepare('SELECT worker_session_id,ended_at FROM assignments WHERE id=?').get('req-migrated'),
    ).toEqual({ worker_session_id: 's-dup1', ended_at: null });
    expect(JSON.stringify(await fresh.client.call('msg.inbox'))).toContain(mail.id);
  } finally {
    hook.close();
    fresh.client.close();
    await broker.stop();
  }
});
