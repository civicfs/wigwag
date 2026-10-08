// A stand-in for a launcher (`timeout`, `env`, `nice`, ...) that stays the parent of the command it runs. Run it through
// a symlink to the node binary named after the launcher, so `ps` reports that name for it. It runs argv[2..] as its
// child with inherited stdio and exits with the child's status.
import { spawn } from 'node:child_process';

const [file, ...args] = process.argv.slice(2);
const child = spawn(file, args, { stdio: 'inherit' });
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
