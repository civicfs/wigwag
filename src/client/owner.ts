import { join } from 'node:path';
import type { Config } from '../config.js';
import { WigwagError } from '../errors.js';
import { frameLimit } from '../protocol/frame.js';
import { assertRehearsalClientPaths } from '../rehearsal.js';
import { Client } from './client.js';

/** Owner actions use the same verified connection; a rehearsal client never routes work through a normal broker. */
export async function connectOwner(
  home: string,
  config: Config,
  onEvent?: (name: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<{ client: Client; welcome: unknown }> {
  const mode = assertRehearsalClientPaths(home, config);
  const deadline = mode.enabled && !signal ? AbortSignal.timeout(config.broker.start_timeout_ms) : signal;
  const result = await Client.connect(
    join(home, 'broker.sock'),
    { protocol: 1, role: 'owner' },
    frameLimit(config),
    onEvent,
    deadline,
  );
  const abort = () => result.client.destroy();
  if (mode.enabled) deadline?.addEventListener('abort', abort, { once: true });
  try {
    if (mode.enabled) {
      if (deadline?.aborted) throw new WigwagError('transport', 'Rehearsal broker verification cancelled');
      const ping = await result.client.call<{ rehearsal?: { enabled?: boolean; native_io?: boolean } }>('sys.ping');
      if (ping?.rehearsal?.enabled !== true || ping.rehearsal.native_io !== false)
        throw new WigwagError(
          'forbidden',
          'Rehearsal client refuses a normal or unverified broker; no owner action was sent. Use a separate rehearsal home.',
        );
    }
    return result;
  } catch (e) {
    result.client.destroy();
    throw e;
  } finally {
    deadline?.removeEventListener('abort', abort);
  }
}
