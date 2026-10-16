import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { darwinProbe, parseDarwinPs } from '../../src/proc/identity.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('runs ps in UTC and C locale while keeping the inherited environment', () => {
  vi.stubEnv('TZ', 'America/New_York');
  vi.mocked(execFileSync).mockReturnValue(' 42 501 Sun Nov  1 05:30:00 2026\n');
  expect(darwinProbe([42])).toEqual(new Map([[42, 'darwin:UTC:Sun Nov 1 05:30:00 2026:501']]));
  expect(execFileSync).toHaveBeenCalledWith(
    'ps',
    ['-o', 'pid=,uid=,lstart=', '-p', '42'],
    expect.objectContaining({
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }),
  );
});

it('keeps distinct UTC starts across a DST-like repeated local hour and normalizes padded days', () => {
  expect(parseDarwinPs('42 501 Sun Nov  1 05:30:00 2026\n43 501 Sun Nov  1 06:30:00 2026\n')).toEqual(
    new Map([
      [42, 'darwin:UTC:Sun Nov 1 05:30:00 2026:501'],
      [43, 'darwin:UTC:Sun Nov 1 06:30:00 2026:501'],
    ]),
  );
});
