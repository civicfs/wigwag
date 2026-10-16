// Child for the concurrent-migration test: loads the real src/store/db.ts (Node transforms the types),
// reports "ready", waits for "go" on stdin so all children call openDb() at the same instant, then
// prints "ok" or the error message.
import { registerHooks } from 'node:module';

// Sources import siblings as "./x.js"; map those to the ".ts" files that exist.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw e;
    }
  },
});

const { openDb } = await import('../../src/store/db.js');
process.stdout.write('ready\n');
process.stdin.once('data', () => {
  try {
    openDb(process.argv[2]).close();
    process.stdout.write('ok\n');
  } catch (e) {
    process.stdout.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.stdin.destroy();
});
