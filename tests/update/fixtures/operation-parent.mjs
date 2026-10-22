import { installTsChildLoader } from '../../fixtures/ts-child-loader.mjs';

installTsChildLoader();
const { lockUpdate } = await import('../../../src/update/lock.ts');
const { runUpdateOperation } = await import('../../../src/update/operation.ts');
const [home, script, entry, timeout] = process.argv.slice(2);
const release = lockUpdate(home);
try {
  await runUpdateOperation(
    home,
    { step: 'claude', root: home, target: '0.3.5', bin: process.execPath, args: [script, home], cwd: home },
    { entry, timeoutMs: Number(timeout) },
  );
  process.stdout.write('finished\n');
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
} finally {
  release();
}
