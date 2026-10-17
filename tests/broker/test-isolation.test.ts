import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { configPath } from '../../src/config.js';
import { codexIndexPath } from '../../src/native/codex-names.js';
import { startTestBroker, tmpHome } from '../helpers.js';

it('keeps resolved test app-server socket and metadata index inside the fixture home', async () => {
  const { home, broker } = await startTestBroker();
  try {
    for (const path of [
      broker.config.questions.app_server_socket,
      codexIndexPath(broker.config.questions.app_server_socket),
    ]) {
      const rel = relative(home, path);
      expect(isAbsolute(rel) || rel.startsWith('..')).toBe(false);
    }
  } finally {
    await broker.stop();
  }
});

it('rejects an escaped app-server socket before a test broker can use it', async () => {
  const home = tmpHome();
  const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
  cfg.questions.app_server_socket = '/outside-fixture/app-server-control/socket';
  writeFileSync(configPath(home), JSON.stringify(cfg));
  let broker: Broker | undefined;
  try {
    await expect(
      startTestBroker(home).then((r) => {
        broker = r.broker;
        return 'started';
      }),
    ).rejects.toThrow(/outside.*fixture home/);
  } finally {
    await broker?.stop();
  }
});
