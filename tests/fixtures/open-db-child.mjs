// Child for the concurrent-migration test: loads the real src/store/db.ts (Node transforms the types),
// reports "ready", waits for "go" on stdin so all children call openDb() at the same instant, then
// prints "ok" or the error message.
import { writeSync } from 'node:fs';
import { installTsChildLoader } from './ts-child-loader.mjs';

installTsChildLoader();

// A synchronous receipt distinguishes runtime startup from the migration being exercised.
writeSync(1, 'fixture-runtime-ready\n');
const { openDb } = await import('../../src/store/db.js');
process.stdout.write('ready\n');
if (process.argv[2] !== '--check-runtime')
  process.stdin.once('data', () => {
    try {
      openDb(process.argv[2]).close();
      process.stdout.write('ok\n');
    } catch (e) {
      process.stdout.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    process.stdin.destroy();
  });
