// A stand-in for a running `claude` process. Run it through a symlink named `claude` that points at the node binary,
// so `ps` reports `claude` as its executable (as for the real agent). It reads one JSON command per stdin line and
// answers each with one JSON line on stdout:
//   {"run": [file, ...args], "stdin": "...", "env": {...}} runs a child to exit -> {"pid", "status", "stdout"}
//   {"spawn": [file, ...args]} starts a long-lived nested agent (another fake claude) -> {"pid", "child": n}
//   {"to": [n, ...], ...command} forwards the command to nested agent n (recursively) and relays its answer
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const children = [];

/** One request/response channel over a child's stdio (JSON lines, one command at a time). */
function channel(child) {
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', (l) => waiting.shift()?.(l));
  return (cmd) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    });
}

function run(cmd) {
  return new Promise((resolve) => {
    const [file, ...args] = cmd.run;
    const child = spawn(file, args, { env: { ...process.env, ...(cmd.env ?? {}) } });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stdin.on('error', () => {});
    child.on('close', (status) => resolve(JSON.stringify({ pid: child.pid, status, stdout })));
    child.stdin.end(cmd.stdin ?? '');
  });
}

async function handle(cmd) {
  if (cmd.to?.length) {
    const [n, ...rest] = cmd.to;
    return children[n].call({ ...cmd, to: rest });
  }
  if (cmd.run) return run(cmd);
  if (cmd.spawn) {
    const [file, ...args] = cmd.spawn;
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push({ child, call: channel(child) });
    return JSON.stringify({ pid: child.pid, child: children.length - 1 });
  }
  return JSON.stringify({ error: 'unknown command' });
}

const input = createInterface({ input: process.stdin });
let queue = Promise.resolve();
input.on('line', (line) => {
  queue = queue.then(async () => process.stdout.write(`${await handle(JSON.parse(line))}\n`));
});
// The test closes stdin to end the tree: close every nested agent's stdin, then exit.
input.on('close', () => {
  for (const { child } of children) child.stdin.end();
  process.exitCode = 0;
});
