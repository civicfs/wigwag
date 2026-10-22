import { lockUpdate } from '../../../src/update/lock.ts';

const release = lockUpdate(process.argv[2]);
process.on('SIGTERM', () => {
  release();
  process.exit(0);
});
process.stdout.write('locked\n');
setInterval(() => {}, 1000);
