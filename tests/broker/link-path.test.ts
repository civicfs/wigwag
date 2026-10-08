import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { installOwner } from '../../src/broker/handlers/owner.js';
import { Broker, type HandlerCtx } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import type { Params } from '../../src/protocol/rpc.js';
import { activeLinks } from '../../src/store/links.js';
import { tmpHome } from '../helpers.js';

it('link requires directories, including through symlinks, rather than creating file workspaces (final Codex m-3)', async () => {
  const home = tmpHome();
  const broker = new Broker(home, loadConfig(home));
  let link!: (ctx: HandlerCtx, params: Params<'owner.link'>) => unknown;
  vi.spyOn(broker, 'handle').mockImplementation((method, handler) => {
    if (method === 'owner.link') link = handler as typeof link;
  });
  installOwner(broker);
  const file = join(home, 'regular-file');
  const alias = join(home, 'file-alias');
  writeFileSync(file, 'content');
  symlinkSync(file, alias);
  try {
    for (const path of [file, alias]) {
      await expect(link({ broker, conn: {} as HandlerCtx['conn'] }, { a: path, b: home })).rejects.toMatchObject({
        code: 'bad_request',
        message: expect.stringMatching(/directory/),
      });
      expect(activeLinks(broker.db)).toHaveLength(0);
    }
  } finally {
    await broker.stop();
  }
});
