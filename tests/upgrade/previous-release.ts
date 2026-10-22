import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import type { startBroker } from '../../src/broker/assemble.js';
import type { CodexNames } from '../../src/native/codex-names.js';

/** Last published schema-4 release. Exercise its actual parser and MCP, not a restamped current client. */
export const PREVIOUS_RELEASE = '36d80dbae75a45db04bb4cbaccbc8636019cc5bd';

export async function previousRelease(): Promise<{
  entry: string;
  startBroker: typeof startBroker;
  CodexNames: typeof CodexNames;
}> {
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'ww-prev-'));
  const source = join(dir, 'source');
  mkdirSync(source);
  const archive = join(dir, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, PREVIOUS_RELEASE, 'src'], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', source]);
  // Runtime dependencies are shared; source, executable artifacts and state are all private fixtures.
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const common = {
    bundle: true,
    platform: 'node' as const,
    format: 'esm' as const,
    target: 'node24',
    packages: 'external' as const,
    logLevel: 'silent' as const,
  };
  const entry = join(dir, 'main.mjs');
  buildSync({ ...common, entryPoints: [join(source, 'src/cli/bootstrap.ts')], outfile: entry });
  const api = join(dir, 'api.mjs');
  buildSync({
    ...common,
    stdin: {
      contents:
        "export { startBroker } from './src/broker/assemble.ts'; export { CodexNames } from './src/native/codex-names.ts';",
      resolveDir: source,
      loader: 'ts',
    },
    outfile: api,
  });
  const previous = await import(pathToFileURL(api).href);
  return { entry, startBroker: previous.startBroker, CodexNames: previous.CodexNames };
}
