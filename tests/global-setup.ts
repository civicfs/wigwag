import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function setup(): void {
  // autospawn tests run the real CLI entry; build it once per test run.
  execFileSync('npx', ['tsup'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit' });
}
