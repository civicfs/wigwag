import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { suppressSqliteExperimentalWarning } from '../../src/warnings.js';

const warning = (message: string, name = 'ExperimentalWarning') => Object.assign(new Error(message), { name });

describe('suppressSqliteExperimentalWarning', () => {
  it('drops only the SQLite experimental warning and keeps every other warning going to the default listener', () => {
    const proc = new EventEmitter();
    const shown: string[] = [];
    proc.on('warning', (w: Error) => shown.push(w.message)); // stands in for Node's default stderr printer
    suppressSqliteExperimentalWarning(proc);

    proc.emit('warning', warning('SQLite is an experimental feature and might change at any time'));
    proc.emit('warning', warning('Type stripping is an experimental feature'));
    proc.emit('warning', warning('SQLite is an experimental feature', 'DeprecationWarning'));
    proc.emit('warning', warning('something else', 'Warning'));

    expect(shown).toEqual([
      'Type stripping is an experimental feature',
      'SQLite is an experimental feature',
      'something else',
    ]);
  });

  it('keeps additional listeners registered by others', () => {
    const proc = new EventEmitter();
    const seen: string[] = [];
    proc.on('warning', (w: Error) => seen.push(`a:${w.message}`));
    proc.on('warning', (w: Error) => seen.push(`b:${w.message}`));
    suppressSqliteExperimentalWarning(proc);
    proc.emit('warning', warning('keep me'));
    expect(seen).toEqual(['a:keep me', 'b:keep me']);
  });
});
