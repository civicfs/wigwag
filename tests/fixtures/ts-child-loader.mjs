/**
 * Shared test-only TS child loader for Node 24/26. Parent: spawn(process.execPath, tsChildArgs(entry, args), opts),
 * or use spawnTsChild from tests/helpers.ts. Child: call installTsChildLoader() before importing any src/*.js.
 * Node's working transform API wins; a supported transform flag is the fallback, otherwise use tsup's esbuild.
 * Emit a synchronous fixture receipt after setup/source loading and before any deliberately induced crash.
 */
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

let nativeSupported;
function supportsNativeTransform() {
  if (nativeSupported !== undefined) return nativeSupported;
  try {
    nodeModule.stripTypeScriptTypes('class Fixture { constructor(readonly n: number) {} }', { mode: 'transform' });
    nativeSupported = true;
  } catch {
    nativeSupported = false;
  }
  return nativeSupported;
}

export function tsChildArgs(entry, args = []) {
  const flag =
    !supportsNativeTransform() && process.allowedNodeEnvironmentFlags.has('--experimental-transform-types')
      ? ['--experimental-transform-types']
      : [];
  return [...flag, entry, ...args];
}

let installed = false;
export function installTsChildLoader() {
  if (installed) return;
  const native = supportsNativeTransform();
  const builtinFlag = !native && process.execArgv.includes('--experimental-transform-types');
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith('.') && specifier.endsWith('.js'))
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        throw error;
      }
    },
    ...(!builtinFlag
      ? {
          load(url, context, nextLoad) {
            const result = nextLoad(url, context);
            if (!url.startsWith('file:') || !url.endsWith('.ts')) return result;
            const source =
              typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
            return {
              ...result,
              format: 'module',
              source: native
                ? nodeModule.stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url })
                : transformSync(source, {
                    loader: 'ts',
                    format: 'esm',
                    target: 'node24',
                    sourcefile: fileURLToPath(url),
                  }).code,
            };
          },
        }
      : {}),
  });
  installed = true;
}
