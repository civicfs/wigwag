import { installTsChildLoader } from '../../fixtures/ts-child-loader.mjs';

installTsChildLoader();
const { runUpdateWorker } = await import('../../../src/update/operation.ts');
await runUpdateWorker();
