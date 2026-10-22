import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { resolveHome } from '../../src/config.js';
import { applyUpdate, run } from '../../src/update/update.js';

/** Updater doubles must never write a journal in the user's home or invoke the real installer. */
export function isolatedApply(...args: Parameters<typeof applyUpdate>): ReturnType<typeof applyUpdate> {
  const home = process.env.WIGWAG_HOME;
  if (!home || !isAbsolute(home) || home !== resolveHome())
    throw new Error('Updater tests require an explicit isolated home');
  const rel = relative(realpathSync(tmpdir()), realpathSync(home));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
    throw new Error('Updater test home must be temporary');
  if (!args[2] || args[2] === run) throw new Error('Updater tests require an isolated command executor');
  return applyUpdate(...args);
}
