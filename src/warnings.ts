import type { EventEmitter } from 'node:events';

type WarningHost = EventEmitter;

const SQLITE_EXPERIMENTAL = 'SQLite is an experimental feature';

/**
 * Node 24 prints `ExperimentalWarning: SQLite is an experimental feature` once per process, which lands on every
 * CLI call's stderr and in broker.log. wigwag uses `node:sqlite` deliberately (spec §3), so that one warning is
 * dropped. Every other warning still reaches the listeners that were registered before (including Node's own
 * stderr printer), unchanged.
 */
export function suppressSqliteExperimentalWarning(proc: WarningHost = process): void {
  const original = proc.listeners('warning') as Array<(w: Error) => void>;
  proc.removeAllListeners('warning');
  proc.on('warning', (w: Error) => {
    if (w.name === 'ExperimentalWarning' && w.message.startsWith(SQLITE_EXPERIMENTAL)) return;
    for (const l of original) l.call(proc, w);
  });
}
