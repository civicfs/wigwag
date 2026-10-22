import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { liveStatus } from '../../src/cli/commands/broker.js';
import { loadConfig } from '../../src/config.js';
import { readUpdateOperation } from '../../src/update/operation.js';
import { VERSION } from '../../src/version.js';
import { killSpawnedBrokers, tmpHome } from '../helpers.js';

let home = '';
afterEach(async () => {
  if (home) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
  home = '';
});

it('a real updater killed during refresh blocks replay, then resumes from the worker receipt', async () => {
  home = tmpHome();
  const fixture = mkdtempSync(join(tmpdir(), 'ww-cli-orphan-'));
  const globalRoot = join(fixture, 'global');
  const installed = join(globalRoot, '@civicfs', 'wigwag');
  const bin = join(fixture, 'bin');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(installed, 'node_modules'), 'dir');
  mkdirSync(bin);
  for (const name of ['main.js', 'cli.js'])
    writeFileSync(join(installed, 'dist', name), readFileSync(resolve('dist', name)));
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ type: 'module', version: VERSION }));
  const calls = join(fixture, 'calls.jsonl');
  const started = join(fixture, 'started');
  const release = join(fixture, 'release');
  const script = `#!${process.execPath}\nimport { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const bin = process.argv[1].split('/').at(-1), args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ bin, args }) + '\\n');
if (bin === 'npm' && args.join(' ') === 'root --global') console.log(${JSON.stringify(globalRoot)});
else if (bin === 'claude' && args.join(' ') === 'plugin update wigwag@wigwag') {
  writeFileSync(${JSON.stringify(started)}, String(process.pid));
  const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20);
} else process.exit(9);
`;
  for (const name of ['npm', 'claude']) writeFileSync(join(bin, name), script, { mode: 0o755 });
  const entry = join(installed, 'dist', 'main.js');
  const journal = join(home, 'update-progress.json');
  writeFileSync(
    journal,
    JSON.stringify({
      format: 1,
      root: realpathSync(installed),
      target: VERSION,
      providers: ['claude'],
      codex_binary: 'codex',
      pending: ['claude'],
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env, WIGWAG_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` };
  expect((await cli(entry, env, ['broker', 'start'])).code).toBe(0);
  const broker = await liveStatus(home);
  const updater = spawn(process.execPath, [entry, 'update', '--apply', '--json'], { env, stdio: 'ignore' });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for isolated updater');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await wait(() => existsSync(started));
    const exited = once(updater, 'exit');
    updater.kill('SIGKILL');
    await exited;
    const callsBeforeRetry = readFileSync(calls, 'utf8');
    const blocked = await cli(entry, env, ['update', '--apply']);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/operation still running/i);
    // The fence runs before even the read-only npm root subprocess.
    expect(readFileSync(calls, 'utf8')).toBe(callsBeforeRetry);
    writeFileSync(release, 'finish');
    await wait(() => readUpdateOperation(home)?.state === 'succeeded');
    const resumed = await cli(entry, env, ['update', '--apply', '--json']);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ completed: true, resumed: true, pending: [] });
    const recorded = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(recorded.filter((call) => call.bin === 'claude')).toHaveLength(1);
    expect((await liveStatus(home))?.pid).toBe(broker?.pid);
    expect(readUpdateOperation(home)).toBeNull();
    expect(existsSync(journal)).toBe(false);
  } finally {
    writeFileSync(release, 'finish');
    if (updater.exitCode === null && updater.signalCode === null) {
      const exited = once(updater, 'exit');
      updater.kill('SIGKILL');
      await exited;
    }
  }
});
const cli = (entry: string, env: NodeJS.ProcessEnv, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [entry, ...args], { env, timeout: 30000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });

it.each([false, true])(
  'real CLI repairs a partial same-version upgrade offline (broker stopped: %s)',
  async (stopped) => {
    home = tmpHome();
    const fixture = mkdtempSync(join(tmpdir(), 'ww-cli-upgrade-'));
    const globalRoot = join(fixture, 'global');
    const installed = join(globalRoot, '@civicfs', 'wigwag');
    const bin = join(fixture, 'bin');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(installed, 'node_modules'), 'dir');
    mkdirSync(bin);
    // Use the actual bundled candidate, installed outside a development checkout.
    for (const name of ['main.js', 'cli.js'])
      writeFileSync(join(installed, 'dist', name), readFileSync(resolve('dist', name)));
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ type: 'module', version: VERSION }));
    // External provider/package-manager commands are recording executables; broker/CLI/state remain real.
    const calls = join(fixture, 'calls.jsonl');
    const failClaude = join(fixture, 'fail-claude');
    writeFileSync(failClaude, 'fail once');
    const script = `#!${process.execPath}\nimport { appendFileSync, existsSync } from 'node:fs';\nconst bin = process.argv[1].split('/').at(-1); const args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify({bin,args})+'\\n');\nif(bin==='npm' && args.join(' ')==='root --global') console.log(${JSON.stringify(globalRoot)});\nelse if(bin==='claude' && args[0]==='plugin' && args[1]==='update' && existsSync(${JSON.stringify(failClaude)})) process.exit(3);\nelse if(bin==='npm') process.exit(9);\n`;
    for (const name of ['npm', 'claude', 'codex']) writeFileSync(join(bin, name), script, { mode: 0o755 });
    const entry = join(installed, 'dist', 'main.js');
    const journal = join(home, 'update-progress.json');
    writeFileSync(
      journal,
      JSON.stringify({
        format: 1,
        root: realpathSync(installed),
        target: VERSION,
        providers: ['claude', 'codex'],
        codex_binary: join(bin, 'codex'),
        pending: ['plugins', 'claude', 'broker'],
      }),
      { mode: 0o600 },
    );
    const env = { ...process.env, WIGWAG_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` };
    const first = await cli(entry, env, ['update', '--apply', '--json']);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(1);
    const partial = JSON.parse(first.stdout);
    expect(partial).toMatchObject({
      version: VERSION,
      resumed: true,
      cli_verified: true,
      completed: false,
      pending: ['claude'],
      failures: [{ step: 'claude' }],
    });
    expect(partial.next_steps.join('\n')).toContain('/reload-plugins');
    expect(partial.next_steps.join('\n')).toMatch(/Codex: restart/);
    expect(partial.next_steps.join('\n')).toContain('BOUND=yes');
    const replacement = await liveStatus(home);
    expect(replacement?.version).toBe(VERSION);
    const pending = JSON.parse(readFileSync(journal, 'utf8'));
    expect(pending).toMatchObject({ target: VERSION, providers: ['claude', 'codex'], pending: ['claude'] });
    if (stopped) {
      const stop = await cli(entry, env, ['broker', 'stop']);
      expect(stop.code, stop.stderr).toBe(0);
      await vi.waitFor(async () => expect(await liveStatus(home)).toBeNull(), { timeout: 10000 });
    }
    unlinkSync(failClaude);
    const second = await cli(entry, env, ['update', '--apply']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('CLI and broker replacement verified');
    expect(second.stdout).toContain('/reload-plugins');
    expect(second.stdout).toMatch(/Codex: restart/);
    expect(second.stdout).toContain('does not reload agent plugins');
    expect(second.stdout).toContain('Wigwag whoami');
    expect(existsSync(journal)).toBe(false);
    const repaired = await liveStatus(home);
    expect(repaired?.version).toBe(VERSION);
    if (stopped) expect(repaired?.pid).not.toBe(replacement?.pid);
    else expect(repaired?.pid).toBe(replacement?.pid);
    const recorded = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(recorded.some((call) => call.bin === 'npm' && call.args[0] !== 'root')).toBe(false);
    expect(
      recorded.filter((call) => call.bin === 'claude' && call.args[0] === 'plugin' && call.args[1] === 'update'),
    ).toHaveLength(2);
  },
);
