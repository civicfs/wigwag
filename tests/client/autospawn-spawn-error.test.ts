import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// spawn() reports some failures (missing executable, EAGAIN) asynchronously as an 'error' event on the
// child. Simulate that so ensureBroker must turn it into a rejection instead of an uncaught exception.
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: undefined, unref: () => {} });
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })));
      return child;
    },
  };
});

const { ensureBroker } = await import('../../src/client/autospawn.js');
const { loadConfig } = await import('../../src/config.js');
const { DIST_MAIN, tmpHome } = await import('../helpers.js');

describe('autospawn spawn failure', () => {
  it('an async spawn error rejects with code transport', async () => {
    const home = tmpHome();
    await expect(ensureBroker(home, loadConfig(home), DIST_MAIN)).rejects.toMatchObject({
      code: 'transport',
      message: expect.stringMatching(/ENOENT/),
    });
  });
});
