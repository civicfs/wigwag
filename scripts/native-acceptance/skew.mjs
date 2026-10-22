#!/usr/bin/env node
/** Opt-in native fault acceptance: a genuine old broker rejects a genuine current Codex MCP. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessReadiness, correlatedReply, deliveryOwnedBy, pluginTrustScope, recognizeTrustPrompt, sanitizePane, shellQuote } from './helpers.mjs';
import { fingerprintPackage, stagePackage } from './package.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baselineCommit = '36d80dbae75a45db04bb4cbaccbc8636019cc5bd';
const hash = (input) => createHash('sha256').update(input).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, content) => writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
const missing = (path) => { try { lstatSync(path); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };

/** Native paired initial failures prove initial hooks failed; exact SessionStart attribution is inferred. */
export function initialSkewFailure(pane, submittedPrompts) {
  const firstTool = pane.search(/(?:•\s*)?Called\s+wigwag\.whoami\(/);
  if (submittedPrompts !== 1 || firstTool < 0) return false;
  const before = pane.slice(0, firstTool);
  return [...before.matchAll(/Hook failed\s*\n\s*└\s*MCP tool returned an error:\s*schema:\s*broker is older than this client/g)].length === 2;
}
export function trustedSessionStart(pane) {
  return /SessionStart hooks/.test(pane) && /Event\s+SessionStart\b/.test(pane) &&
    /Source\s+Plugin - wigwag@wigwag\s*(?:\n|$)/.test(pane) && /MCP Server\s+wigwag\s*(?:\n|$)/.test(pane) &&
    /MCP Tool\s+session_bind\s*(?:\n|$)/.test(pane) && /Trust\s+Trusted\s*(?:\n|$)/.test(pane);
}
export function hookTableSelection(pane, target) {
  const review = /Event\s+Installed\s+Active\s+Review\s+Description/.test(pane);
  if (!review && !/Event\s+Installed\s+Active\s+Description/.test(pane)) return undefined;
  const rows = [...pane.matchAll(/^\s*([›>]?)\s*(\w+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s+/gm)];
  const selected = rows.findIndex((r) => r[1] !== ''), destination = rows.findIndex((r) => r[2] === target);
  if (selected < 0 || destination < 0 || rows[destination][3] !== '1' || rows[destination][4] !== '1' ||
      (review ? rows[destination][5] !== '0' : rows[destination][5] !== undefined)) return undefined;
  return Array.from({ length: Math.abs(destination - selected) }, () => destination > selected ? 'Down' : 'Up');
}
export function exactPendingPrompt(pane, expected) {
  const lines = pane.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^[›>]\s+/.test(lines[i].trim())) last = i;
  if (last < 0) return false;
  const parts = [lines[last].trim().replace(/^[›>]\s+/, '')];
  for (let i = last + 1; i < lines.length && lines[i].trim(); i++) parts.push(lines[i].trim());
  let remaining = expected.trim();
  for (const part of parts) {
    if (!part || !remaining.startsWith(part)) return false;
    remaining = remaining.slice(part.length).replace(/^[ \t]+/, '');
  }
  return remaining === '';
}


/** Codex 0.163 uses an owned private-home symlink to a short UID-scoped socket. */
export function ownedDaemonSocket(path, codexHome, uid = process.getuid?.()) {
  if (missing(path)) return undefined;
  if (realpathSync(dirname(path)) !== join(realpathSync(codexHome), 'app-server-control')) throw new Error('Private Codex control directory escaped its home');
  const link = lstatSync(path);
  const target = realpathSync(path);
  const stat = lstatSync(target);
  if (uid === undefined || link.uid !== uid || stat.uid !== uid || !stat.isSocket()) throw new Error('Codex control socket ownership or type is invalid');
  if (link.isSymbolicLink()) {
    if (dirname(target) !== join(realpathSync('/tmp'), `codex-daemon-${uid}`) || !/^[a-f0-9]{64}$/.test(basename(target))) throw new Error('Private Codex control socket has an unexpected symlink target');
    const parent = lstatSync(dirname(target));
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw new Error('Codex socket parent is not a private owned directory');
  } else if (target !== path) throw new Error('Codex control socket escaped its private home');
  return { path, target, dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function command(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...opts });
  if (r.error || r.status !== 0) throw new Error(`${basename(bin)} ${args[0] ?? ''} failed (${r.error?.code ?? r.status ?? r.signal})`);
  return r.stdout.trim();
}
function artifact(path) {
  const root = realpathSync(path);
  return { root, version: json(join(root, 'package.json')).version, ...fingerprintPackage(root) };
}
function verifyBaseline(root, repository) {
  const paths = command('git', ['ls-tree', '-r', '--name-only', baselineCommit, '--', 'src', 'plugins', '.agents', '.claude-plugin', 'package.json'], { cwd: repository }).split('\n');
  if (paths.length < 20) throw new Error('Pinned baseline source inventory is incomplete');
  for (const path of paths) {
    const expected = spawnSync('git', ['show', `${baselineCommit}:${path}`], { cwd: repository, maxBuffer: 8 * 1024 * 1024 });
    if (expected.status !== 0 || hash(expected.stdout) !== hash(readFileSync(join(root, path)))) throw new Error(`Baseline source differs from pinned commit: ${path}`);
  }
  return { commit: baselineCommit, verified_source_files: paths.length, limitation: 'Source equality verified; bundle hashes are recorded, build provenance remains an operator responsibility.' };
}
function prepare(v) {
  if (!v.baseline) throw new Error('--baseline must identify a built, genuine pinned 0.3.0 package');
  if (v.root && (!isAbsolute(v.root) || existsSync(v.root))) throw new Error('--root must be a fresh absolute path');
  let root = v.root ? resolve(v.root) : mkdtempSync(join(tmpdir(), 'wws-'));
  if (v.root) mkdirSync(root, { mode: 0o700 });
  root = realpathSync(root);
  chmodSync(root, 0o700);
  if (root.length > 45) throw new Error('Use a short private root such as /tmp/wws-UNIQUE');
  const candidate = artifact(v.candidate ?? repo);
  const baseline = artifact(v.baseline);
  if (baseline.version !== '0.3.0' || candidate.version !== '0.3.5') throw new Error('This fault scenario requires pinned baseline 0.3.0 and candidate 0.3.5');
  Object.assign(baseline, verifyBaseline(baseline.root, candidate.root));
  const paths = Object.fromEntries(['installed', 'baseline', 'bin', 'codex', 'wigwag', 'workspace', 'logs'].map((name) => [name, join(root, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  stagePackage(candidate.root, paths.installed, candidate.sha256);
  stagePackage(baseline.root, paths.baseline, baseline.sha256);
  const codex = realpathSync(v['codex-bin'] ?? command('/bin/sh', ['-c', 'command -v codex']));
  const id = randomBytes(5).toString('hex');
  const m = { format: 'wigwag-native-skew-1', root, id, paths, candidate, baseline, codex, name: `native-skew-${id}`, tmux_socket: `wws-${id}`, created_at: new Date().toISOString() };
  write(join(paths.bin, 'wigwag'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(paths.installed, 'dist/main.js'))} "$@"\n`);
  chmodSync(join(paths.bin, 'wigwag'), 0o700);
  write(join(paths.codex, 'config.toml'), '[features]\nremote_plugin = false\nhooks = true\n\n[plugins._default]\nenabled = false\n');
  write(join(paths.workspace, 'README.md'), 'Disposable native Wigwag incompatible-broker fault acceptance. Synthetic messages only.\n');
  write(join(root, 'skew-manifest.json'), m);
  process.stdout.write(`Prepared ${root}\nCODEX_HOME=${paths.codex}\nAuthenticate this private home separately; no providers or model calls started.\n`);
}
function manifest(v) {
  if (!v.root || !isAbsolute(v.root)) throw new Error('--root must be an absolute prepared path');
  const root = realpathSync(v.root);
  const m = json(join(root, 'skew-manifest.json'));
  if (m.format !== 'wigwag-native-skew-1' || m.root !== root || !/^[a-f0-9]{10}$/.test(m.id) || m.tmux_socket !== `wws-${m.id}`) throw new Error('Fault run ownership marker is invalid');
  for (const [name, path] of Object.entries(m.paths)) {
    if (relative(root, path) !== name || realpathSync(path) !== path || [join(homedir(), '.codex'), join(homedir(), '.wigwag')].includes(path)) throw new Error('Private run path escaped its root');
  }
  for (const name of ['broker.sock', 'broker.lock']) if (!missing(join(m.paths.wigwag, name)) && lstatSync(join(m.paths.wigwag, name)).isSymbolicLink()) throw new Error('Private broker runtime path is a symlink');
  return m;
}
function environment(m) {
  const env = { ...process.env, PATH: `${m.paths.bin}:${dirname(m.codex)}:${process.env.PATH ?? ''}`, WIGWAG_HOME: m.paths.wigwag, WIGWAG_NO_UPDATE_CHECK: '1', CODEX_HOME: m.paths.codex, WIGWAG_NAME: m.name };
  for (const name of ['WIGWAG_REHEARSAL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'TMUX', 'TMUX_PANE']) delete env[name];
  return env;
}
async function rpc(m, method, params = {}) {
  const socket = createConnection(join(m.paths.wigwag, 'broker.sock'));
  socket.setEncoding('utf8');
  let buffer = '', next = 1;
  const pending = new Map();
  const call = (name, data) => new Promise((yes, no) => { const id = next++; pending.set(id, { yes, no }); socket.write(`${JSON.stringify({ id, method: name, params: data })}\n`); });
  const timer = setTimeout(() => socket.destroy(new Error('Owner observation timed out')), 10000);
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy(new Error('Owner response exceeds evidence bound'));
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const frame = JSON.parse(line), p = pending.get(frame.id); if (p) { pending.delete(frame.id); frame.error ? p.no(new Error(frame.error.message)) : p.yes(frame.result); } }
      catch { socket.destroy(new Error('Malformed owner observation')); }
    }
  });
  for (const event of ['error', 'close']) socket.on(event, (e) => { for (const p of pending.values()) p.no(e instanceof Error ? e : new Error('Owner disconnected')); pending.clear(); });
  try { await call('hello', { protocol: 1, role: 'owner' }); return await call(method, params); }
  finally { clearTimeout(timer); socket.destroy(); }
}
function table() {
  return command('ps', ['-axo', 'pid=,ppid=,lstart=,command=']).split('\n').filter(Boolean).map((line) => {
    const p = line.trim().split(/\s+/); return { pid: Number(p[0]), ppid: Number(p[1]), start: p.slice(2, 7).join(' '), command: p.slice(7).join(' ') };
  });
}
export function ownedCliCommand(commandLine, root, allowed = ['mcp', 'broker', 'claude', 'codex']) {
  const args = commandLine.split(/\s+/);
  return /^(?:node|nodejs)(?:\.exe)?$/.test(basename(args[0] ?? '')) && args[1] === join(root, 'dist/main.js') && allowed.includes(args[2]);
}
function mcps(m) { return table().filter((p) => ownedCliCommand(p.command, m.paths.installed, ['mcp'])); }
function ownedProcesses(m) {
  const panes = spawnSync('tmux', ['-L', m.tmux_socket, 'list-panes', '-a', '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 5000 });
  const pids = new Set((panes.stdout ?? '').split('\n').map(Number).filter((n) => n > 1));
  const current = table();
  for (const p of current) {
    if (p.pid === process.pid) continue;
    if ([m.paths.installed, m.paths.baseline].some((root) => ownedCliCommand(p.command, root)) || p.command.split(/\s+/)[0]?.startsWith(`${join(m.paths.codex, 'packages')}/`)) pids.add(p.pid);
  }
  for (let n = 0; n < current.length; n++) { let change = false; for (const p of current) if (p.pid !== process.pid && !pids.has(p.pid) && pids.has(p.ppid)) { pids.add(p.pid); change = true; } if (!change) break; }
  return current.filter((p) => p.pid !== process.pid && pids.has(p.pid));
}
async function cleanup(m) {
  const env = environment(m), processes = ownedProcesses(m), notes = [], errors = [];
  const alive = () => { const now = table(); return processes.filter((p) => now.some((q) => q.pid === p.pid && q.start === p.start)); };
  const control = join(m.paths.codex, 'app-server-control/app-server-control.sock');
  let controlSnapshot;
  try { controlSnapshot = ownedDaemonSocket(control, m.paths.codex); }
  catch (e) { errors.push(`Private daemon identity: ${e.message}`); }
  spawnSync('tmux', ['-L', m.tmux_socket, 'kill-server'], { env, timeout: 10000, stdio: 'ignore' });
  if (controlSnapshot) {
    try { command(m.codex, ['app-server', 'daemon', 'stop'], { env }); }
    catch (e) { notes.push(`Private daemon stop: ${e.message}`); }
  }
  // Stop native hosts and MCP reconnect loops before stopping their broker.
  await pause(500);
  const isBroker = (p) => [m.paths.installed, m.paths.baseline].some((root) => ownedCliCommand(p.command, root, ['broker']));
  for (const p of alive().filter((p) => !isBroker(p))) try { process.kill(p.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') notes.push(`Owned process ${p.pid}: ${e.message}`); }
  let end = Date.now() + 5000;
  while (Date.now() < end && alive().some((p) => !isBroker(p))) await pause(250);
  try {
    const ping = await rpc(m, 'sys.ping');
    const identity = table().find((p) => p.pid === ping.pid && isBroker(p));
    if (!identity) throw new Error('Private broker process identity is not owned');
    process.kill(identity.pid, 'SIGTERM');
  } catch (e) { notes.push(`Private broker cleanup: ${e.message}`); }
  end = Date.now() + 10000;
  while (Date.now() < end && (alive().length || !missing(join(m.paths.wigwag, 'broker.sock')) || (controlSnapshot && existsSync(controlSnapshot.target)))) await pause(250);
  // Native daemon stop may leave its now-dangling link. Remove exactly the captured owned link only.
  if (controlSnapshot && !missing(control) && lstatSync(control).isSymbolicLink() && missing(controlSnapshot.target) && resolve(dirname(control), readlinkSync(control)) === controlSnapshot.target) unlinkSync(control);
  const remaining = alive();
  if (remaining.length) errors.push('Captured owned processes remain alive with matching start identities');
  if (!missing(join(m.paths.wigwag, 'broker.sock'))) errors.push('Private broker socket remains');
  if (!missing(control)) errors.push('Private Codex control socket/link remains');
  if (controlSnapshot && !missing(controlSnapshot.target)) errors.push('Captured private Codex control target remains');
  if (spawnSync('tmux', ['-L', m.tmux_socket, 'has-session', '-t', 'skew'], { timeout: 5000, stdio: 'ignore' }).status === 0) errors.push('Owned tmux session remains');
  return { status: errors.length ? 'fail' : 'pass', errors, notes, control_socket: controlSnapshot, observed_owned_processes: processes, remaining_owned_processes: remaining };
}

async function run(m, v) {
  if (!v['run-native'] || !v['codex-model']) throw new Error('Real paid native calls require --run-native and explicit --codex-model');
  if (existsSync(join(m.root, 'skew-evidence.json'))) throw new Error('Run evidence already exists; prepare a fresh root');
  const timeout = Number(v['timeout-ms'] ?? 120000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error('timeout-ms must be 1000..600000');
  for (const [path, expected] of [[m.paths.installed, m.candidate.sha256], [m.paths.baseline, m.baseline.sha256]]) if (fingerprintPackage(path).sha256 !== expected) throw new Error('Prepared package fingerprint changed');
  const env = environment(m), control = join(m.paths.codex, 'app-server-control/app-server-control.sock');
  const cli = (old, ...args) => command(process.execPath, [join(old ? m.paths.baseline : m.paths.installed, 'dist/main.js'), ...args], { env, cwd: m.paths.workspace });
  const tmux = (...args) => command('tmux', ['-L', m.tmux_socket, ...args], { env });
  const evidence = { format: 1, run_id: m.id, root: m.root, candidate: m.candidate, baseline: m.baseline, model: v['codex-model'], git: { head: command('git', ['rev-parse', 'HEAD'], { cwd: m.candidate.root }), dirty: command('git', ['status', '--porcelain'], { cwd: m.candidate.root }) !== '' }, harness_sources: Object.fromEntries(['skew.mjs', 'helpers.mjs', 'package.mjs'].map((name) => [name, hash(readFileSync(join(dirname(fileURLToPath(import.meta.url)), name)))])), started_at: new Date().toISOString(), status: 'blocked', scenarios: [], trust_ui: [], cleanup: { status: 'pending' }, limitations: ['No pre-restart broker session can exist: the old broker rejects the current MCP hello.', 'Exact initial SessionStart eventName telemetry is unavailable in Codex 0.163; attribution is an inference from paired native hook failures before the first tool and a trusted sole-plugin SessionStart detail. The unbound checkpoint and later hook recovery are directly observed.', 'Delivery passes only with an exact correlated model reply and captured recipient-session ownership.', 'No synthetic hooks, internal binding tools, fake providers or account configuration writes.'] };
  const save = () => write(join(m.root, 'skew-evidence.json'), evidence);
  const record = (id, detail) => { evidence.scenarios.push({ id, status: 'pass', at: new Date().toISOString(), ...detail }); save(); process.stdout.write(`${id}: pass\n`); };
  let onlyWigwag = false, prompts = 0;
  const observedUi = new Set();
  const pane = (history = false) => { try { return tmux('capture-pane', '-p', '-t', 'skew:codex', ...(history ? ['-S', '-300'] : [])).slice(-48000); } catch { return ''; } };
  const scope = () => { const inventory = JSON.parse(command(m.codex, ['plugin', 'list', '--json'], { env })); onlyWigwag = pluginTrustScope(inventory, readFileSync(join(m.paths.codex, 'config.toml'), 'utf8')); evidence.plugin_inventory = inventory.installed?.map((p) => ({ id: p.pluginId, enabled: p.enabled })); save(); return onlyWigwag; };
  const hookCount = Object.values(json(join(m.paths.installed, 'plugins/codex/.codex-plugin/plugin.json')).hooks.hooks).reduce((sum, groups) => sum + groups.reduce((n, group) => n + group.hooks.length, 0), 0);
  const ui = () => {
    const text = pane(), match = recognizeTrustPrompt('codex', text, m.paths.workspace, { onlyWigwag, hookCount });
    if (!match || observedUi.has(`${match.kind}:${match.tool ?? ''}`)) return;
    if (match.kind.startsWith('wigwag-hooks') && !scope()) return;
    observedUi.add(`${match.kind}:${match.tool ?? ''}`);
    evidence.trust_ui.push({ kind: match.kind, tool: match.tool, at: new Date().toISOString(), action: v['trust-disposable'] ? 'accepted-native-ui' : 'waiting-for-operator', pane_sha256: hash(sanitizePane(text)) });
    write(join(m.paths.logs, `trust-${evidence.trust_ui.length}.txt`), sanitizePane(text));
    if (v['trust-disposable']) for (const key of match.keys) tmux('send-keys', '-t', 'skew:codex', key);
    save();
  };
  async function until(label, f) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) { ui(); try { const result = await f(); if (result) return result; } catch (e) { last = e.message; } await pause(400); }
    const error = new Error(`${label} not observed within ${timeout}ms${last ? ` (${last})` : ''}`); error.blocked = true; throw error;
  }
  async function sendPrompt(text) {
    prompts++;
    tmux('send-keys', '-t', 'skew:codex', '-l', text); tmux('send-keys', '-t', 'skew:codex', 'Enter');
    await pause(800);
    // The first Enter may be consumed during the native startup UI transition. Resubmit only exact pending text.
    if (exactPendingPrompt(pane(), text)) {
      evidence.pending_prompt_resubmissions = (evidence.pending_prompt_resubmissions ?? 0) + 1;
      tmux('send-keys', '-t', 'skew:codex', 'Enter');
      save();
    }
  }
  let scenario = 'preflight';
  try {
    if (!missing(join(m.paths.wigwag, 'broker.sock')) || !missing(control) || existsSync(join(m.paths.wigwag, 'config.json'))) throw new Error('Fault scenario requires untouched freshly prepared broker/native homes');
    evidence.provider = { path: m.codex, version: command(m.codex, ['--version'], { env }) };
    command('tmux', ['-V']);
    if (!/^\[plugins\._default\]\s*\nenabled\s*=\s*false\s*$/m.test(readFileSync(join(m.paths.codex, 'config.toml'), 'utf8'))) throw new Error('Private default plugin policy must disable account-synced plugins');
    if (!/^remote_plugin\s+\S+\s+false\s*$/m.test(command(m.codex, ['features', 'list'], { env }))) throw new Error('Account-synced remote plugins are not disabled');
    command(m.codex, ['plugin', 'marketplace', 'add', m.paths.installed], { env, timeout: 0 });
    command(m.codex, ['plugin', 'add', 'wigwag@wigwag'], { env, timeout: 0 });
    if (!scope()) throw new Error('Enabled private plugin inventory is not exclusively staged Wigwag');
    cli(true, 'init', '--codex', m.codex);
    cli(true, 'broker', 'start');
    evidence.old_broker = await rpc(m, 'sys.ping');
    if (evidence.old_broker.version !== '0.3.0') throw new Error('Old native broker version is not 0.3.0');
    if ((await rpc(m, 'session.who')).length) throw new Error('Fault home already has broker sessions');
    record(scenario, { old_broker: evidence.old_broker, native_plugin_install: true });
    tmux('new-session', '-d', '-s', 'skew', '-n', 'control', '-x', '160', '-y', '55', '-c', m.paths.workspace);
    tmux('set-option', '-g', 'history-limit', '1000');
    tmux('set-option', '-g', 'remain-on-exit', 'on');
    const launcher = join(m.root, 'launch-skew.sh');
    const exports = Object.entries({ PATH: env.PATH, WIGWAG_HOME: env.WIGWAG_HOME, WIGWAG_NAME: env.WIGWAG_NAME, WIGWAG_NO_UPDATE_CHECK: '1', CODEX_HOME: env.CODEX_HOME }).map(([k, val]) => `export ${k}=${shellQuote(val)}`).join('\n');
    write(launcher, `#!/bin/sh\n${exports}\nexec ${[m.codex, '-m', v['codex-model'], '--no-alt-screen', '-a', 'on-request', '-s', 'read-only'].map(shellQuote).join(' ')}\n`);
    chmodSync(launcher, 0o700);
    tmux('new-window', '-t', 'skew', '-n', 'codex', '-c', m.paths.workspace, shellQuote(launcher));
    scenario = 'genuine-initial-native-hooks-skew-failure';
    await until('native Wigwag-only initial hook trust', () => evidence.trust_ui.some((u) => u.kind === 'wigwag-hooks' && u.action === 'accepted-native-ui'));
    await pause(800);
    await sendPrompt('For synthetic upgrade acceptance, use only the public Wigwag whoami tool once. Report its exact result or error, then end the turn and wait. Never call any internal hook or binding tools.');
    const failed = await until('paired genuine initial native hook failures before the first model toolcall', async () => {
      const text = pane(true), processes = mcps(m);
      const trusted = evidence.trust_ui.some((u) => u.kind === 'wigwag-hooks' && u.action === 'accepted-native-ui');
      return trusted && initialSkewFailure(text, prompts) && processes.length === 1 && { text, processes };
    });
    await until('initial native turn finished', () => /Worked for\s+\d+s/.test(pane()));
    tmux('send-keys', '-t', 'skew:codex', '-l', '/hooks'); tmux('send-keys', '-t', 'skew:codex', 'Enter');
    await pause(600);
    if (/^[›>]\s*\/hooks\s*$/m.test(pane())) tmux('send-keys', '-t', 'skew:codex', 'Enter');
    const navigation = await until('native SessionStart inventory row', () => hookTableSelection(pane(), 'SessionStart'));
    for (const key of [...navigation, 'Enter']) tmux('send-keys', '-t', 'skew:codex', key);
    const detail = await until('native trusted Wigwag SessionStart detail', () => trustedSessionStart(pane()) && pane());
    write(join(m.paths.logs, 'trusted-sessionstart-detail.txt'), sanitizePane(detail));
    tmux('send-keys', '-t', 'skew:codex', 'Escape'); tmux('send-keys', '-t', 'skew:codex', 'Escape');
    const failedPane = sanitizePane(failed.text);
    write(join(m.paths.logs, 'initial-sessionstart-skew.txt'), failedPane);
    if ((await rpc(m, 'session.who')).length) throw new Error('Current MCP unexpectedly established a session with the incompatible broker');
    record(scenario, { native_ui_sha256: hash(failedPane), submitted_user_prompts: prompts, mcp_processes: failed.processes, before_broker_session_count: 0, sessionstart_detail_sha256: hash(sanitizePane(detail)), cause: 'Two real native initial hooks failed with schema skew before the first public whoami call. Native detail confirms trusted Wigwag SessionStart/session_bind. SessionStart attribution is inferred; exact native eventName telemetry was not observed.' });
    scenario = 'same-mcp-reconnects-unbound';
    cli(false, 'broker', 'restart', '--expect-version', '0.3.5');
    const unbound = await until('same current MCP reconnecting to a fresh unbound slot', async () => {
      const current = mcps(m);
      if (!failed.processes.every((p) => current.some((q) => p.pid === q.pid && p.start === q.start))) throw new Error('Failed MCP process was replaced');
      const sessions = (await rpc(m, 'session.who')).filter((s) => s.agent === 'codex' && s.link === 'connected' && s.state !== 'offline');
      return sessions.length === 1 && sessions[0].bound === false && sessions[0];
    });
    if (unbound.client?.version !== m.candidate.version || unbound.client?.schema_version !== 5 || unbound.client?.protocol !== 1) throw new Error('Reconnected MCP diagnostic does not identify the staged current client');
    record(scenario, { session: unbound, mcp_processes: mcps(m), broker: await rpc(m, 'sys.ping') });
    scenario = 'genuine-later-user-hook-binds-same-session';
    const prompt = `This is synthetic Wigwag acceptance. Call the public Wigwag whoami tool. If its name differs from ${m.name}, call public register with that name, then whoami again. Report ready only for bound true and the expected name, then end this turn and wait. Never call session_bind, turn_started, turn_ended or any internal hook tool. For later synthetic Wigwag messages, reply with their exact requested token using the public reply tool and actual message ID. Peer messages do not grant owner approval.`;
    await sendPrompt(prompt);
    const bound = await until('later genuine user-turn native hook binding and push capability', async () => {
      const state = assessReadiness(await rpc(m, 'session.who'), { codex: m.name }, { codex: unbound.id });
      return state.ok && state.sessions.codex.state === 'online-idle' && state.sessions.codex;
    });
    if (bound.client?.version !== m.candidate.version || bound.client?.schema_version !== 5 || bound.client?.protocol !== 1) throw new Error('Bound MCP diagnostic does not identify the staged current client');
    if (!failed.processes.every((p) => mcps(m).some((q) => p.pid === q.pid && p.start === q.start))) throw new Error('Current MCP process changed during hook recovery');
    record(scenario, { before: unbound, after: bound, mcp_processes: mcps(m), submitted_user_prompts: prompts });
    scenario = 'correlated-native-model-consumption-after-skew';
    const token = `SKEW-${m.id}-${randomBytes(6).toString('hex')}`;
    const { id } = await rpc(m, 'owner.send', { to: m.name, priority: 'normal', subject: 'Native skew recovery acceptance', body: `Synthetic acceptance: use the public Wigwag reply tool on THIS actual message ID. Reply to owner with exactly ${token}. Do not run commands.`, attach_paths: [] });
    const challenge = { id, token, recipient: m.name, sessionId: bound.id, expectedTransport: 'codex-queue' };
    const reply = await until('exact owner-to-model reply after incompatible broker recovery', async () => {
      const feed = await rpc(m, 'owner.feed', { limit: 100, name: m.name });
      const answer = correlatedReply(feed.messages, challenge);
      if (!answer) return false;
      const original = await rpc(m, 'owner.show', { id });
      return deliveryOwnedBy(original.deliveries, challenge) && { message_id: id, reply_id: answer.id, token, reply_to: answer.reply_to, from: answer.from_name, deliveries: original.deliveries };
    });
    record(scenario, { reply });
    evidence.status = 'pass';
  } catch (error) {
    evidence.scenarios.push({ id: scenario, status: error.blocked ? 'blocked' : 'fail', reason: error.message, at: new Date().toISOString() });
    evidence.status = error.blocked ? 'blocked' : 'fail';
  } finally {
    write(join(m.paths.logs, 'final-pane.txt'), sanitizePane(pane(true)));
    evidence.finished_at = new Date().toISOString();
    evidence.cleanup = v['keep-sessions'] ? { status: 'kept', tmux_socket: m.tmux_socket } : await cleanup(m);
    if (evidence.cleanup.status === 'fail') evidence.status = 'fail';
    save(); process.stdout.write(`Evidence: ${join(m.root, 'skew-evidence.json')}\nOverall: ${evidence.status}\n`);
    process.exitCode = evidence.status === 'pass' ? 0 : evidence.status === 'blocked' ? 2 : 1;
  }
}
const help = `Usage:\n  node scripts/native-acceptance/skew.mjs prepare --root /tmp/wws-UNIQUE --baseline /path/to/built/0.3.0 [--candidate /path/to/candidate] [--codex-bin /absolute/codex]\n  node scripts/native-acceptance/skew.mjs run --root /tmp/wws-UNIQUE --run-native --codex-model MODEL [--trust-disposable] [--keep-sessions]\n  node scripts/native-acceptance/skew.mjs cleanup --root /tmp/wws-UNIQUE\n\nPrepare creates fresh private homes without model calls. Authenticate private CODEX_HOME separately.\nRun uses genuine paid Codex, a real pinned 0.3.0 broker and current MCP/plugin, native trust UI, and a correlated model reply.\nNo synthetic hooks or binding calls. Unknown native UI stays blocked. Evidence is private in ROOT/skew-evidence.json.\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values: v, positionals: [mode] } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, 'codex-bin': { type: 'string' }, 'codex-model': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'run-native': { type: 'boolean' }, 'trust-disposable': { type: 'boolean' }, 'keep-sessions': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (v.help) process.stdout.write(help);
    else if (mode === 'prepare') prepare(v);
    else if (mode === 'run') await run(manifest(v), v);
    else if (mode === 'cleanup') { const result = await cleanup(manifest(v)); process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.status === 'pass' ? 0 : 1; }
    else { process.stdout.write(help); process.exitCode = 2; }
  } catch (e) { process.stderr.write(`native skew acceptance: ${e.message}\n`); process.exitCode = 2; }
}
