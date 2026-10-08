import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureBroker, sockPath } from '../../src/client/autospawn.js';
import { loadConfig } from '../../src/config.js';
import {
  DIST_MAIN,
  isAlive,
  killSpawnedBrokers,
  ownerClient,
  spawnedBrokerPids,
  staleSocket,
  tmpHome,
} from '../helpers.js';

// Every home a test uses is registered before anything is spawned; afterEach kills whatever those
// spawns left alive (by pid, from the autospawn log) and waits for the exits, pass or fail.
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
});

function testHome(): string {
  const home = tmpHome();
  homes.push(home);
  return home;
}

const N = 6;

describe('autospawn', () => {
  const cases: Array<[string, (home: string) => void]> = [
    ['fresh home', () => {}],
    [
      'stale lock + stale socket',
      (home) => {
        writeFileSync(join(home, 'broker.lock'), '999999');
        staleSocket(sockPath(home));
      },
    ],
  ];
  for (const [name, prepare] of cases) {
    it(`${N} concurrent ensureBroker calls end with exactly one broker (${name})`, async () => {
      const home = testHome();
      prepare(home);
      const cfg = loadConfig(home);
      await Promise.all(Array.from({ length: N }, () => ensureBroker(home, cfg, DIST_MAIN)));
      const spawned = spawnedBrokerPids(home);
      expect(spawned.length).toBeGreaterThanOrEqual(1);

      const c = await ownerClient(home);
      const { pid } = await c.call<{ pid: number }>('sys.ping');
      c.close();
      expect(spawned).toContain(pid);
      expect(Number(readFileSync(join(home, 'broker.lock'), 'utf8'))).toBe(pid);
      // Every other spawned process must lose the lock and exit on its own; only then is the
      // winner the sole broker (a loser still starting could otherwise take over later).
      await vi.waitFor(
        () => {
          const alive = spawned.filter(isAlive);
          if (alive.length !== 1 || alive[0] !== pid) throw new Error(`alive: ${alive.join(',')}`);
        },
        { timeout: cfg.broker.start_timeout_ms },
      );
      const log = readFileSync(join(home, 'logs', 'broker.log'), 'utf8');
      expect(log.match(/broker started/g)).toHaveLength(1);
    });
  }

  it("the spawned broker runs in the home directory, not the spawner's cwd (final m-7)", async () => {
    const home = testHome();
    await ensureBroker(home, loadConfig(home), DIST_MAIN);
    const [pid] = spawnedBrokerPids(home);
    const cwd =
      process.platform === 'linux'
        ? readlinkSync(`/proc/${pid}/cwd`)
        : (execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
            .split('\n')
            .find((l) => l.startsWith('n'))
            ?.slice(1) ?? '');
    expect(cwd).toBe(realpathSync(home));
  });

  it('rejects with code transport when the spawned entry does not exist', async () => {
    const home = testHome();
    const cfg = loadConfig(home);
    await expect(ensureBroker(home, cfg, join(home, 'no-such-main.js'))).rejects.toMatchObject({
      code: 'transport',
      message: expect.stringMatching(/exited with code 1/),
    });
  });
});
