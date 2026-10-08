import { defineConfig } from 'tsup';

export default defineConfig({
  // main = the bin; it installs the SQLite warning filter before `cli` (which imports node:sqlite) is loaded.
  entry: { main: 'src/cli/bootstrap.ts', cli: 'src/cli/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
});
