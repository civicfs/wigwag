// Run a potentially blocking reader in a fixture child; the test's timeout owns this child only.
import { registerHooks } from 'node:module';

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
const [kind, path, sid] = process.argv.slice(2);
const { readSidecarTitle } = await import('../../src/native/claude-title.js');
const { tailLines } = await import('../../src/native/tail.js');
process.stdout.write(JSON.stringify(kind === 'sidecar' ? readSidecarTitle(path, sid) : tailLines(path, 1024)));
