import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { liveStatus } from '../../src/cli/commands/broker.js';
import { loadConfig, setCodexBinary } from '../../src/config.js';
import { VERSION } from '../../src/version.js';
import { killSpawnedBrokers, tmpHome } from '../helpers.js';
import { previousRelease } from './previous-release.js';

const cli = (entry: string, env: NodeJS.ProcessEnv, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [entry, ...args], { env, timeout: 30000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });

it('repairs an actual old updater failure after package replacement without an old repair journal', async () => {
  const previous = await previousRelease();
  const home = tmpHome();
  const fixture = mkdtempSync(join(tmpdir(), 'ww-updater-bootstrap-'));
  const globalRoot = join(fixture, 'global');
  const installed = join(globalRoot, '@civicfs', 'wigwag');
  const bin = join(fixture, 'bin');
  const candidate = join(fixture, 'candidate');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(candidate);
  symlinkSync(resolve('node_modules'), join(installed, 'node_modules'), 'dir');
  for (const name of ['main.js', 'cli.js']) writeFileSync(join(candidate, name), readFileSync(resolve('dist', name)));
  const entry = join(installed, 'dist', 'main.js');
  writeFileSync(entry, readFileSync(previous.entry));
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ type: 'module', version: '0.3.0' }));
  const calls = join(fixture, 'calls.jsonl');
  const fail = join(fixture, 'fail-provider');
  const registryCalls = join(fixture, 'registry-calls');
  const shim = join(fixture, 'registry.mjs');
  writeFileSync(fail, 'fail after npm replaced the CLI');
  writeFileSync(
    shim,
    `import { appendFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) !== 'https://registry.npmjs.org/@civicfs%2fwigwag/latest') return originalFetch(input, options);
  appendFileSync(${JSON.stringify(registryCalls)}, 'lookup\\n');
  return Response.json({ version: ${JSON.stringify(VERSION)} });
};`,
  );
  const executable = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const bin = process.argv[1].split('/').at(-1), args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ bin, args }) + '\\n');
if (bin === 'npm' && args.join(' ') === 'root --global') console.log(${JSON.stringify(globalRoot)});
else if (bin === 'npm' && args[0] === 'install') {
  for (const name of ['main.js', 'cli.js']) writeFileSync(${JSON.stringify(join(installed, 'dist'))} + '/' + name, readFileSync(${JSON.stringify(candidate)} + '/' + name));
  writeFileSync(${JSON.stringify(join(installed, 'package.json'))}, JSON.stringify({ type: 'module', version: ${JSON.stringify(VERSION)} }));
} else if (bin === 'claude' && args.join(' ') === 'plugin list --json') console.log(JSON.stringify([{ id: 'wigwag@wigwag' }]));
else if (bin === 'codex' && args.join(' ') === 'plugin list --json') console.log(JSON.stringify({ installed: [] }));
else if (bin === 'claude' && args[1] === 'validate' && existsSync(${JSON.stringify(fail)})) process.exit(3);
else if (bin === 'npm') process.exit(9);
`;
  for (const name of ['npm', 'claude', 'codex']) writeFileSync(join(bin, name), executable, { mode: 0o755 });
  setCodexBinary(home, join(bin, 'codex'));
  writeFileSync(
    join(bin, 'wigwag'),
    `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, [${JSON.stringify(entry)}, ...process.argv.slice(2)], { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    WIGWAG_HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    NODE_OPTIONS: `--import ${pathToFileURL(shim).href}`,
  };
  try {
    const original = await cli(entry, env, ['--version']);
    expect(original.code, original.stderr).toBe(0);
    expect(original.stdout.trim()).toBe('0.3.0');
    expect((await cli(entry, env, ['broker', 'start'])).code).toBe(0);
    const oldBroker = await liveStatus(home);
    expect(oldBroker?.version).toBe('0.3.0');
    const first = await cli(entry, env, ['update', '--apply']);
    expect(first.code, first.stdout + first.stderr).toBe(1);
    expect((await cli(entry, env, ['--version'])).stdout.trim(), first.stdout + first.stderr).toBe(VERSION);
    expect(existsSync(join(home, 'update-progress.json'))).toBe(false);
    expect((await liveStatus(home))?.pid).toBe(oldBroker?.pid);
    // The new entry must bootstrap repair even without a journal or npm metadata.
    unlinkSync(fail);
    writeFileSync(
      shim,
      `import { appendFileSync } from 'node:fs'; const originalFetch = globalThis.fetch; globalThis.fetch = async (input, options) => { if (String(input) !== 'https://registry.npmjs.org/@civicfs%2fwigwag/latest') return originalFetch(input, options); appendFileSync(${JSON.stringify(registryCalls)}, 'unexpected\\n'); throw new Error('offline fixture'); };`,
    );
    const lookups = readFileSync(registryCalls, 'utf8');
    const repaired = await cli(entry, env, ['update', '--apply', '--repair', '--json']);
    expect(repaired.code, repaired.stdout + repaired.stderr).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({
      version: VERSION,
      providers: ['claude'],
      cli_verified: true,
      completed: true,
      pending: [],
    });
    expect(readFileSync(registryCalls, 'utf8')).toBe(lookups);
    expect((await liveStatus(home))?.version).toBe(VERSION);
    expect(existsSync(join(home, 'update-progress.json'))).toBe(false);
    const commands = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(commands.filter((call) => call.bin === 'npm' && call.args[0] === 'install')).toHaveLength(1);
    expect(commands.some((call) => call.bin === 'codex' && call.args[1] !== 'list')).toBe(false);
  } finally {
    await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
  }
});
