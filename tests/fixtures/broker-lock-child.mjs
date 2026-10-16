// Own fixture process only: simulate a 0.2 broker holding broker.mutex while committing its final message.
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installTsChildLoader } from './ts-child-loader.mjs';

installTsChildLoader();
const { BrokerLock } = await import('../../src/broker/lock.js');
const lock = BrokerLock.acquire(process.argv[2]);
if (process.argv[3] === 'commit') {
  const db = new DatabaseSync(join(process.argv[2], 'state.db'));
  db.exec(
    "INSERT INTO messages(id,from_name,to_target,kind,priority,subject,body,attachments,created_at) VALUES('last-commit','owner','worker','message','normal','s','last committed message','[]','t')",
  );
  db.close();
}
writeSync(1, 'fixture-lock-held\n');
process.stdin.once('data', () => {
  lock.release();
  process.stdin.destroy();
});
