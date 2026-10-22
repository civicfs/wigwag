import { installTsChildLoader } from '../../fixtures/ts-child-loader.mjs';

installTsChildLoader();
const { runInstaller } = await import('../../../src/install/process.ts');
try {
  const result = await runInstaller(process.execPath, process.argv.slice(2));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
