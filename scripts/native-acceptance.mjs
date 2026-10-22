#!/usr/bin/env node
/** Opt-in local acceptance. No fake provider executables, native hook injection, or live-home writes. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessReadiness, correlatedReply, deliveryOwnedBy, nativeUiErrors, overallVerdict, ownedCliCommand, pluginTrustScope, recognizeTrustPrompt, sanitizePane, shellQuote, uiActionKeys } from './native-acceptance/helpers.mjs';
import { fingerprintPackage, stagePackage } from './native-acceptance/package.mjs';
import { exactPendingPrompt } from './native-acceptance/skew.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, 'baseline-commit': { type: 'string' },
    'claude-bin': { type: 'string' }, 'codex-bin': { type: 'string' },
    'claude-model': { type: 'string' }, 'codex-model': { type: 'string' },
    'run-native': { type: 'boolean' }, 'trust-disposable': { type: 'boolean' },
    'keep-sessions': { type: 'boolean' }, 'timeout-ms': { type: 'string' }, 'low-observe-ms': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const mode = positionals[0];
const help = `Usage:
  node scripts/native-acceptance.mjs prepare [--root /tmp/wwn-UNIQUE] [--baseline /path/to/old/package]
  node scripts/native-acceptance.mjs run --root /tmp/wwn-UNIQUE --run-native --claude-model sonnet --codex-model MODEL [--trust-disposable]
  node scripts/native-acceptance.mjs cleanup --root /tmp/wwn-UNIQUE

prepare stages a fresh private installation and empty provider homes; it makes no model calls.
Authenticate those homes separately. The harness never copies authentication material.
run starts genuine paid native providers in a dedicated tmux server. Unknown UI remains blocked.
--trust-disposable permits only recognized trust UIs for this run's isolated workspace/Wigwag hooks.
--keep-sessions preserves this run's panes for inspection; cleanup closes only this run's server and private brokers.
See docs/native-acceptance.md. Evidence is private at ROOT/evidence.json.
`;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data) => writeFileSync(path, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const runId = () => randomBytes(5).toString('hex');

function command(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...opts });
  if (r.error || r.status !== 0) throw new Error(`${bin} ${args[0] ?? ''} failed (${r.error?.code ?? r.status ?? r.signal})`);
  return r.stdout.trim();
}

function binary(name, explicit) {
  const path = explicit ?? command('/bin/sh', ['-c', 'command -v "$1"', 'sh', name]);
  if (!isAbsolute(path)) throw new Error(`${name} must resolve to an absolute executable path`);
  return realpathSync(path);
}

function artifact(path) {
  const root = realpathSync(path);
  const pkg = json(join(root, 'package.json'));
  const main = join(root, 'dist', 'main.js');
  const fingerprint = fingerprintPackage(root);
  return { root, version: pkg.version, main_sha256: hash(readFileSync(main)), cli_sha256: fingerprint.files['dist/cli.js'] ?? null, files: fingerprint.files, package_code_sha256: fingerprint.sha256, repository: gitEvidence(root) };
}

function verifyBaselineSource(root, commit, repository) {
  if (!/^[a-f0-9]{40}$/.test(commit) || command('git', ['cat-file', '-t', commit], { cwd: repository }) !== 'commit') throw new Error('--baseline-commit requires an existing full commit ID');
  const paths = command('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src', 'plugins', '.agents', '.claude-plugin', 'package.json'], { cwd: repository }).split('\n');
  for (const path of paths) {
    const expected = spawnSync('git', ['show', `${commit}:${path}`], { cwd: repository, maxBuffer: 8 * 1024 * 1024 });
    if (expected.status !== 0 || hash(expected.stdout) !== hash(readFileSync(join(root, path)))) throw new Error(`Baseline source does not match ${commit}: ${path}`);
  }
  return { source_commit: commit, source_verified_files: paths.length, note: 'Source/manifests match commit; bundle hashes recorded separately. Bundle build provenance requires the operator build record.' };
}

function gitEvidence(path) {
  try {
    return { head: command('git', ['rev-parse', 'HEAD'], { cwd: path }), dirty: command('git', ['status', '--porcelain'], { cwd: path }) !== '' };
  } catch { return { head: null, dirty: null }; }
}

function prepare() {
  const explicit = values.root && resolve(values.root);
  if (explicit && existsSync(explicit)) throw new Error('prepare requires a fresh, nonexistent root');
  let root = explicit ?? mkdtempSync(join(tmpdir(), 'wwn-'));
  if (explicit) mkdirSync(root, { mode: 0o700 });
  root = realpathSync(root);
  chmodSync(root, 0o700);
  if (root.length > 45) throw new Error('Use a short root such as /tmp/wwn-UNIQUE (native Unix sockets have path limits)');
  const id = runId();
  const candidate = artifact(values.candidate ?? repo);
  const baseline = artifact(values.baseline ?? candidate.root);
  if (values['baseline-commit']) Object.assign(baseline, verifyBaselineSource(baseline.root, values['baseline-commit'], candidate.root));
  const paths = Object.fromEntries(['installed', 'bin', 'wigwag', 'codex', 'claude', 'workspace', 'logs'].map((n) => [n, join(root, n)]));
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  const initialInstallation = stagePackage(baseline.root, paths.installed, baseline.package_code_sha256);
  write(join(paths.bin, 'wigwag'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(paths.installed, 'dist', 'main.js'))} "$@"\n`);
  chmodSync(join(paths.bin, 'wigwag'), 0o700);
  const manifest = {
    format: 1, id, root: realpathSync(root), created_at: new Date().toISOString(), paths,
    candidate: { ...candidate, repository: gitEvidence(candidate.root) }, baseline, initial_installation: initialInstallation,
    providers: { claude: binary('claude', values['claude-bin']), codex: binary('codex', values['codex-bin']) },
    names: { claude: `native-claude-${id}`, codex: `native-codex-${id}` }, tmux_socket: `wwn-${id}`,
  };
  symlinkSync(manifest.providers.claude, join(paths.bin, 'claude'));
  const claudeTools = ['whoami', 'register', 'send', 'reply', 'inbox'].map((tool) => `mcp__plugin_wigwag_wigwag__${tool}`);
  write(join(paths.claude, 'settings.json'), { permissions: { allow: [...claudeTools, `Bash(node .wigwag-native-work.mjs claude-${id})`] } });
  write(join(paths.codex, 'config.toml'), '[features]\nremote_plugin = false\nhooks = true\n\n[plugins._default]\nenabled = false\n');
  write(join(root, 'manifest.json'), manifest);
  write(join(paths.workspace, 'README.md'), 'Disposable Wigwag native acceptance workspace. Synthetic messages only.\n');
  write(join(paths.workspace, '.wigwag-native-work.mjs'), `import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace = dirname(fileURLToPath(import.meta.url));
const release = join(workspace, '.wigwag-native-release');
const tag = process.argv[2];
if (!/^(?:claude|codex)-${id}$/.test(tag ?? '')) throw new Error('Unexpected native work tag');
console.log('waiting ' + tag);
await new Promise((resolve, reject) => {
  const poll = setInterval(() => { if (existsSync(release)) finish(); }, 200);
  const timer = setTimeout(() => finish(new Error('Native acceptance driver did not release work within 60s')), 60000);
  function finish(error) { clearTimeout(timer); clearInterval(poll); error ? reject(error) : resolve(); }
  if (existsSync(release)) finish();
});
console.log('released ' + tag);
`);
  process.stdout.write(`Prepared ${root}\nCODEX_HOME=${paths.codex}\nCLAUDE_CONFIG_DIR=${paths.claude}\nWIGWAG_HOME=${paths.wigwag}\nNo native providers or model calls started. Authenticate these private provider homes before run.\n`);
}

function ownedManifest() {
  if (!values.root || !isAbsolute(values.root)) throw new Error('--root must be an absolute prepared path');
  const root = realpathSync(values.root);
  const m = json(join(root, 'manifest.json'));
  if (m.format !== 1 || m.root !== root || !/^[a-f0-9]{10}$/.test(m.id) || m.tmux_socket !== `wwn-${m.id}`) throw new Error('Run ownership marker is invalid');
  const live = [join(homedir(), '.wigwag'), join(homedir(), '.codex'), join(homedir(), '.claude')];
  for (const [name, path] of Object.entries(m.paths)) {
    if (relative(root, path) !== name || realpathSync(path) !== path || live.includes(path)) throw new Error('Run paths have escaped the private root');
  }
  for (const path of [join(m.paths.wigwag, 'broker.sock'), join(m.paths.wigwag, 'broker.lock'), join(m.paths.codex, 'app-server-control')]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Runtime socket/lock symlink escapes are refused');
  }
  const control = join(m.paths.codex, 'app-server-control', 'app-server-control.sock');
  if (existsSync(control) && lstatSync(control).isSymbolicLink()) {
    const stamp = json(join(m.root, 'runtime-sockets.json'));
    const target = nativeControlTarget(control);
    if (stamp.run_id !== m.id || stamp.codex_control_target !== target) throw new Error('Native control socket does not match this run ownership record');
  }
  return m;
}

function nativeControlTarget(control) {
  const target = realpathSync(control);
  const parent = join(realpathSync('/tmp'), `codex-daemon-${process.getuid()}`);
  const parentStat = statSync(parent);
  if (dirname(target) !== parent || !/^[a-f0-9]{64}$/.test(target.slice(parent.length + 1)) ||
      parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0 ||
      !statSync(target).isSocket() || statSync(target).uid !== process.getuid()) throw new Error('Native Codex control socket target ownership is not verified');
  return target;
}

function environment(m) {
  const env = { ...process.env, PATH: `${m.paths.bin}:${dirname(m.providers.codex)}:${dirname(m.providers.claude)}:${process.env.PATH ?? ''}`,
    WIGWAG_HOME: m.paths.wigwag, WIGWAG_NO_UPDATE_CHECK: '1', CODEX_HOME: m.paths.codex, CLAUDE_CONFIG_DIR: m.paths.claude };
  delete env.WIGWAG_REHEARSAL;
  delete env.WIGWAG_NAME;
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'TMUX', 'TMUX_PANE']) delete env[key];
  return env;
}

/** Read-only public owner observation, except the explicit owner.send call. No session/internal hook methods. */
async function rpc(m, method, params = {}) {
  const socket = createConnection(join(m.paths.wigwag, 'broker.sock'));
  socket.setEncoding('utf8');
  let buffer = '';
  let next = 1;
  const pending = new Map();
  const timer = setTimeout(() => socket.destroy(new Error('broker RPC timed out')), 10000);
  const call = (name, p) => new Promise((yes, no) => {
    const id = next++;
    pending.set(id, { yes, no });
    socket.write(`${JSON.stringify({ id, method: name, params: p })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy(new Error('broker response exceeds evidence bound'));
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const f = JSON.parse(line);
        const p = pending.get(f.id);
        if (p) { pending.delete(f.id); f.error ? p.no(new Error(f.error.message)) : p.yes(f.result); }
      } catch { socket.destroy(new Error('malformed broker response')); }
    }
  });
  socket.on('error', (error) => { for (const p of pending.values()) p.no(error); pending.clear(); });
  socket.on('close', () => { for (const p of pending.values()) p.no(new Error('broker disconnected')); pending.clear(); });
  try {
    // A versionless protocol-1 owner observes both the baseline and candidate wire contracts.
    await call('hello', { protocol: 1, role: 'owner' });
    return await call(method, params);
  } finally { clearTimeout(timer); socket.destroy(); }
}

function processes(m) {
  return command('ps', ['-axo', 'pid=,ppid=,lstart=,command=']).split('\n')
    .filter((line) => { const p = line.trim().split(/\s+/); return ownedCliCommand(p.slice(7).join(' '), m.paths.installed, ['mcp']); })
    .map((line) => { const p = line.trim().split(/\s+/); return { pid: Number(p[0]), ppid: Number(p[1]), start: p.slice(2, 7).join(' '), command: p.slice(7).join(' ') }; });
}

function processTable() {
  return command('ps', ['-axo', 'pid=,ppid=,lstart=,command=']).split('\n').filter(Boolean).map((line) => {
    const p = line.trim().split(/\s+/);
    return { pid: Number(p[0]), ppid: Number(p[1]), start: p.slice(2, 7).join(' '), command: p.slice(7).join(' ') };
  });
}

function ownedProcesses(m) {
  const panes = spawnSync('tmux', ['-L', m.tmux_socket, 'list-panes', '-a', '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 10000 });
  const owned = new Set((panes.stdout ?? '').trim().split('\n').map(Number).filter((n) => n > 1));
  const table = processTable();
  for (const p of table) {
    const args = p.command.split(/\s+/);
    if (p.pid !== process.pid && ownedCliCommand(p.command, m.paths.installed)) owned.add(p.pid);
    if (p.pid !== process.pid && args[0]?.startsWith(`${join(m.paths.codex, 'packages')}/`)) owned.add(p.pid);
  }
  for (let n = 0; n < table.length; n++) {
    let changed = false;
    for (const p of table) if (!owned.has(p.pid) && owned.has(p.ppid) && p.pid !== process.pid) { owned.add(p.pid); changed = true; }
    if (!changed) break;
  }
  return table.filter((p) => owned.has(p.pid) && p.pid !== process.pid);
}

async function execute(m) {
  if (!values['run-native']) throw new Error('No native launch authorized: add --run-native to opt in to real paid calls');
  if (!values['claude-model'] || !values['codex-model']) throw new Error('Explicit --claude-model and --codex-model are required');
  if (existsSync(join(m.root, 'evidence.json'))) throw new Error('A run already exists; prepare a fresh root to preserve evidence');
  const timeout = Number(values['timeout-ms'] ?? 120000);
  const lowObserve = Number(values['low-observe-ms'] ?? 30000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000 || !Number.isInteger(lowObserve) || lowObserve < 15000 || lowObserve > 60000) throw new Error('Invalid timeout; timeout-ms=1000..600000, low-observe-ms=15000..60000');
  const candidate = artifact(m.candidate.root);
  if (candidate.package_code_sha256 !== m.candidate.package_code_sha256) throw new Error('Candidate package code changed after prepare; prepare a fresh root');
  const env = environment(m);
  // An installer must keep its supervising CLI alive until nested provider commands actually close.
  const cli = (...args) => command(process.execPath, [join(m.paths.installed, 'dist', 'main.js'), ...args], { env, cwd: m.paths.workspace, ...(args[0] === 'install' ? { timeout: 0 } : {}) });
  const tmux = (...args) => command('tmux', ['-L', m.tmux_socket, ...args], { env });
  const evidence = { format: 1, run_id: m.id, started_at: new Date().toISOString(), root: m.root,
    git: gitEvidence(m.candidate.root), candidate, baseline: m.baseline,
    upgrade: m.baseline.version !== candidate.version || m.baseline.package_code_sha256 !== candidate.package_code_sha256,
    models: { claude: values['claude-model'], codex: values['codex-model'] }, providers: {}, scenarios: [
      'preflight', 'initial-native-readiness', 'baseline-delivery-claude', 'baseline-delivery-codex',
      'low-mail-does-not-wake', 'retained-idle-across-broker-replacement', 'retained-busy-across-broker-replacement',
      'claude-reload', 'codex-restart-hook-trust', 'claude-trust-ui', 'codex-trust-ui', 'untrusted-initial-hooks-native-recovery',
    ].map((id) => ({ id, status: 'blocked', reason: 'Not executed.' })), trust_ui: [], native_ui_errors: [],
    cleanup: { status: 'pending' }, out_of_scope: [{ id: 'incompatible-broker-initial-sessionstart-native-recovery', status: 'blocked', reason: 'Not executed: native untrusted-hook recovery has a distinct cause and does not establish incompatible-broker recovery.' }], limitations: ['A public transport receipt alone never passes delivery.', 'No programmatic hook-trust bypass is used.', 'This run does not test npm publication or global provider configuration.'] };
  evidence.harness_files = Object.fromEntries(['scripts/native-acceptance.mjs', 'scripts/native-acceptance/helpers.mjs', 'scripts/native-acceptance/package.mjs', 'scripts/native-acceptance/skew.mjs'].map((path) => [path, hash(readFileSync(join(repo, path)))]));
  const save = () => write(join(m.root, 'evidence.json'), evidence);
  let monitorPostUpgrade = false;
  const record = (id, status, detail = {}) => { if (status === 'pass') assertNativeUiHealthy(); const row = { id, status, at: new Date().toISOString(), ...detail }; const index = evidence.scenarios.findIndex((s) => s.id === id); if (index < 0) evidence.scenarios.push(row); else evidence.scenarios[index] = row; save(); process.stdout.write(`${id}: ${status}\n`); };
  const pane = (agent) => {
    try { return tmux('capture-pane', '-p', '-t', `acceptance:${agent}`).slice(-24000); } catch { return ''; }
  };
  const assertNativeUiHealthy = () => {
    if (!monitorPostUpgrade) return;
    for (const agent of ['claude', 'codex']) {
      const text = sanitizePane(pane(agent));
      const errors = nativeUiErrors(text);
      if (errors.length) {
        evidence.native_ui_errors.push({ agent, phase: currentScenario, at: new Date().toISOString(), lines: errors.slice(0, 10), pane_sha256: hash(text) });
        write(join(m.paths.logs, `post-upgrade-errors-${evidence.native_ui_errors.length}.txt`), text);
        save();
        throw new Error(`Unexpected post-upgrade native hook/schema/identity error in ${agent}; see private evidence`);
      }
    }
  };
  const keys = async (agent, text) => {
    tmux('send-keys', '-t', `acceptance:${agent}`, '-l', text);
    // Native React inputs can receive Enter before the text state has rendered.
    await pause(250);
    tmux('send-keys', '-t', `acceptance:${agent}`, 'Enter');
    await pause(500);
    const alive = tmux('display-message', '-p', '-t', `acceptance:${agent}`, '#{pane_dead}') !== '1';
    const retry = agent === 'codex' && alive && exactPendingPrompt(pane(agent), text);
    if (retry) tmux('send-keys', '-t', `acceptance:${agent}`, 'Enter');
    const observation = { agent, phase: currentScenario, text_sha256: hash(text), text_render_delay_ms: 250, exact_pending_enter_retries: retry ? 1 : 0 };
    evidence.input_dispatch = [...(evidence.input_dispatch ?? []), observation];
    save();
    return observation;
  };
  const screenshots = () => {
    for (const agent of ['claude', 'codex']) {
      // Private bounded text, never emitted in stdout/CI or included in the summary JSON.
      let text;
      try { text = tmux('capture-pane', '-p', '-t', `acceptance:${agent}`, '-S', '-180').slice(-24000); } catch { text = ''; }
      write(join(m.paths.logs, `${agent}-pane.txt`), sanitizePane(text));
    }
  };
  const uiStates = new Map();
  const launchEpoch = { claude: 0, codex: 0 };
  let codexOnlyWigwag = false;
  let codexTrustAction = 'trust';
  const verifyCodexScope = () => {
    const inventory = JSON.parse(command(m.providers.codex, ['plugin', 'list', '--json'], { env }));
    const config = readFileSync(join(m.paths.codex, 'config.toml'), 'utf8');
    codexOnlyWigwag = pluginTrustScope(inventory, config);
    evidence.codex_plugin_inventory = inventory.installed?.map((p) => ({ id: p.pluginId, enabled: p.enabled }));
    save();
    return codexOnlyWigwag;
  };
  const hookCount = () => Object.values(json(join(m.paths.installed, 'plugins', 'codex', '.codex-plugin', 'plugin.json')).hooks?.hooks ?? {}).reduce((sum, groups) => sum + groups.reduce((n, group) => n + group.hooks.length, 0), 0);
  const handleUi = async () => {
    assertNativeUiHealthy();
    const control = join(m.paths.codex, 'app-server-control', 'app-server-control.sock');
    if (existsSync(control) && lstatSync(control).isSymbolicLink()) write(join(m.root, 'runtime-sockets.json'), { run_id: m.id, codex_control_target: nativeControlTarget(control) });
    for (const agent of ['claude', 'codex']) {
      const text = pane(agent);
      const match = recognizeTrustPrompt(agent, text, m.paths.workspace, { onlyWigwag: codexOnlyWigwag, hookCount: hookCount() });
      const key = match ? `${launchEpoch[agent]}:${agent}:${match.kind}:${match.tool ?? ''}` : null;
      for (const [oldKey, state] of uiStates) {
        if (state.agent === agent && state.epoch === launchEpoch[agent] && state.sent && !state.acknowledged && oldKey !== key) {
          state.acknowledged = true;
          state.observation.action = state.defer ? 'continued-without-trusting-native-ui' : 'accepted-native-ui';
          state.observation.acknowledged_at = new Date().toISOString();
          save();
        }
      }
      if (!match) continue;
      const defer = agent === 'codex' && match.kind === 'wigwag-hooks' && codexTrustAction === 'defer';
      const now = Date.now();
      const signature = hash(JSON.stringify({ kind: match.kind, tool: match.tool, selection: uiActionKeys(agent, text, match, defer) }));
      let state = uiStates.get(key);
      if (!state) {
        const observation = { agent, kind: match.kind, tool: match.tool, launch_epoch: launchEpoch[agent], pane_sha256: hash(sanitizePane(text)), at: new Date().toISOString(), action: 'observed-waiting-for-native-acknowledgement', attempts: 0 };
        state = { agent, epoch: launchEpoch[agent], observation, signature, stableSince: now, lastAttempt: 0, defer, sent: false, acknowledged: false };
        uiStates.set(key, state);
        evidence.trust_ui.push(observation);
        write(join(m.paths.logs, `trust-${evidence.trust_ui.length}.txt`), sanitizePane(text));
      }
      if (state.signature !== signature) { state.signature = signature; state.stableSince = now; }
      if (!values['trust-disposable'] || state.acknowledged || state.observation.attempts >= 3 || now - state.stableSince < 1000 || now - state.lastAttempt < 2000) continue;
      if (match.kind.startsWith('wigwag-hooks') && !verifyCodexScope()) continue;
      const current = pane(agent);
      const currentMatch = recognizeTrustPrompt(agent, current, m.paths.workspace, { onlyWigwag: codexOnlyWigwag, hookCount: hookCount() });
      if (currentMatch?.kind !== match.kind || currentMatch?.tool !== match.tool) continue;
      const action = uiActionKeys(agent, current, currentMatch, defer);
      if (!action) continue;
      state.observation.attempts++;
      state.lastAttempt = Date.now();
      for (const key of action.keys.filter((key) => key !== 'Enter')) { tmux('send-keys', '-t', `acceptance:${agent}`, key); await pause(150); }
      if (action.keys.includes('Enter')) {
        const selectedDeadline = Date.now() + 1000;
        let selected;
        do {
          const visible = pane(agent);
          const still = recognizeTrustPrompt(agent, visible, m.paths.workspace, { onlyWigwag: codexOnlyWigwag, hookCount: hookCount() });
          selected = still?.kind === match.kind && still?.tool === match.tool ? uiActionKeys(agent, visible, still, defer) : undefined;
          if (selected?.keys.length === 1 && selected.keys[0] === 'Enter') break;
          await pause(100);
        } while (Date.now() < selectedDeadline);
        if (selected?.keys.length !== 1 || selected.keys[0] !== 'Enter') { save(); continue; }
        tmux('send-keys', '-t', `acceptance:${agent}`, 'Enter');
      }
      state.sent = true;
      state.observation.action = 'native-ui-keys-sent-awaiting-acknowledgement';
      save();
    }
  };
  async function slash(agent, text) {
    await keys(agent, text);
    if (tmux('display-message', '-p', '-t', `acceptance:${agent}`, '#{pane_dead}') === '1') return;
    // Codex's exact pending input retry is handled above, including wrapped prompts.
    if (agent === 'codex') return;
    const inputs = pane(agent).split('\n').map((line) => line.trim()).filter((line) => /^[›>❯]\s*/.test(line));
    if (inputs.at(-1)?.replace(/^[›>❯]\s*/, '') === text) tmux('send-keys', '-t', `acceptance:${agent}`, 'Enter');
  }
  async function until(label, f, budget = timeout) {
    const end = Date.now() + budget;
    let last;
    while (Date.now() < end) {
      await handleUi();
      try { const result = await f(); if (result) return result; } catch (e) { last = e.message; }
      await pause(500);
    }
    screenshots();
    const e = new Error(`${label} was not observed within ${budget}ms${last ? ` (${last})` : ''}`);
    e.blocked = true;
    throw e;
  }
  const ready = (retained, versions) => until('bound expected native identities and push capabilities', async () => {
    const check = assessReadiness(await rpc(m, 'session.who'), m.names, retained, versions);
    return check.ok && check;
  });
  const idle = (retained, versions) => until('both native sessions idle', async () => {
    const check = assessReadiness(await rpc(m, 'session.who'), m.names, retained, versions);
    return check.ok && Object.values(check.sessions).every((s) => s.state === 'online-idle') && check;
  });
  async function challenge(agent, sessionId, phase, priority = 'normal') {
    const token = `NATIVE-${m.id}-${phase}-${agent}-${runId()}`;
    const { id } = await rpc(m, 'owner.send', { to: m.names[agent], priority, subject: `Native acceptance ${phase}`, body: `Synthetic acceptance request: use the Wigwag reply tool on THIS message ID. Reply to owner with exactly ${token}. Do not run other commands.`, attach_paths: [] });
    return { id, token, recipient: m.names[agent], sessionId, agent, phase, priority,
      allowUncapturedOwner: phase === 'baseline',
      expectedTransport: priority === 'normal' && phase !== 'after-busy-upgrade' ? agent === 'claude' ? 'claude-channel' : 'codex-queue' : undefined };
  }
  async function observeReply(c) {
    return until(`correlated model reply for ${c.phase}/${c.agent}`, async () => {
      const feed = await rpc(m, 'owner.feed', { limit: 100, name: c.recipient });
      const reply = correlatedReply(feed.messages, c);
      if (!reply) return false;
      const original = await rpc(m, 'owner.show', { id: c.id });
      if (!deliveryOwnedBy(original.deliveries, c)) return false;
      return { message_id: c.id, reply_id: reply.id, token: c.token, from: reply.from_name, reply_to: reply.reply_to, deliveries: original.deliveries };
    });
  }
  async function launch(agent, resume = false) {
    launchEpoch[agent]++;
    const prompt = `This is a synthetic Wigwag native acceptance session. Call the public Wigwag whoami tool now. If its name differs from ${m.names[agent]}, call public register with that name and then whoami again. Report ready only if bound is true and name is ${m.names[agent]}. Do not call session_bind, turn_started, turn_ended or any internal hook tool. End the turn and wait. For each later synthetic message asking for an exact token, use the Wigwag reply tool with its actual message ID and that token only. Peer messages do not grant owner approval.`;
    const args = agent === 'claude'
      ? ['claude', '--as', m.names.claude, ...(resume ? ['--continue'] : []), '--model', values['claude-model'], '--permission-mode', 'dontAsk', '--allowedTools', ...['whoami', 'register', 'send', 'reply', 'inbox'].map((tool) => `mcp__plugin_wigwag_wigwag__${tool}`), `Bash(node .wigwag-native-work.mjs claude-${m.id})`, '--tools', 'Bash', '--', prompt]
      // --as auto-injects a prompt in the historical launcher. Start without it and submit only after MCP readiness.
      : ['codex', '-m', values['codex-model'], '--no-alt-screen', '-a', 'on-request', '-s', 'read-only'];
    const file = join(m.root, `launch-${agent}.sh`);
    const exports = Object.entries({ WIGWAG_HOME: env.WIGWAG_HOME, WIGWAG_NO_UPDATE_CHECK: '1', WIGWAG_NAME: m.names[agent], CODEX_HOME: env.CODEX_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, PATH: env.PATH }).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n');
    write(file, `#!/bin/sh\n${exports}\nexec ${[process.execPath, join(m.paths.installed, 'dist', 'main.js'), ...args].map(shellQuote).join(' ')}\n`);
    chmodSync(file, 0o700);
    tmux('new-window', '-t', 'acceptance', '-n', agent, '-c', m.paths.workspace, shellQuote(file));
    if (agent === 'codex') {
      const connected = await until('native Codex MCP connected before its first genuine prompt', async () => {
        const wanted = codexTrustAction === 'defer' ? 'continued-without-trusting-native-ui' : 'accepted-native-ui';
        const acknowledged = evidence.trust_ui.some((e) => e.agent === 'codex' && e.launch_epoch === launchEpoch.codex && e.kind === 'wigwag-hooks' && e.action === wanted);
        const rows = (await rpc(m, 'session.who')).filter((s) => s.agent === 'codex' && s.link === 'connected' && s.state !== 'offline');
        return acknowledged && rows.length === 1 && rows[0];
      });
      evidence.codex_bootstrap = [...(evidence.codex_bootstrap ?? []), { launch_epoch: launchEpoch.codex, connected_before_prompt: connected, initial_prompt_submissions: 1 }];
      evidence.codex_bootstrap.at(-1).exact_pending_enter_retries = (await keys('codex', prompt)).exact_pending_enter_retries;
      save();
    }
  }
  const idsOf = (check) => Object.fromEntries(Object.entries(check.sessions).map(([agent, s]) => [agent, s.id]));
  let currentScenario = 'preflight';
  try {
    if (existsSync(join(m.paths.wigwag, 'broker.sock')) || existsSync(join(m.paths.codex, 'app-server-control', 'app-server-control.sock'))) throw new Error('Prepared homes already have a live socket; refusing to adopt another run');
    evidence.providers.claude = { path: m.providers.claude, version: command(m.providers.claude, ['--version'], { env }) };
    evidence.providers.codex = { path: m.providers.codex, version: command(m.providers.codex, ['--version'], { env }) };
    command('tmux', ['-V']);
    const features = command(m.providers.codex, ['features', 'list'], { env });
    if (!/^remote_plugin\s+\S+\s+false\s*$/m.test(features)) throw new Error('Private Codex remote_plugin feature must be disabled to exclude account-synced plugins');
    cli('install', '--codex-binary', m.providers.codex);
    if (!verifyCodexScope()) throw new Error('Native Codex inventory is not exclusively the staged Wigwag plugin; no bulk trust is authorized');
    const preTrustConfig = readFileSync(join(m.paths.codex, 'config.toml'), 'utf8');
    if (/Bearer|Authorization|api[_-]?key\s*=|access[_-]?token|refresh[_-]?token|password\s*=|secret\s*=/i.test(preTrustConfig)) throw new Error('Private config contains possible authentication material; trust reset snapshot is refused');
    write(join(m.root, 'codex-pretrust-config.toml'), preTrustConfig);
    const ping = await rpc(m, 'sys.ping');
    evidence.initial_broker = ping;
    save();
    tmux('new-session', '-d', '-s', 'acceptance', '-n', 'control', '-x', '140', '-y', '50', '-c', m.paths.workspace);
    tmux('set-option', '-g', 'history-limit', '500');
    tmux('set-option', '-g', 'remain-on-exit', 'on');
    record('preflight', 'pass', { baseline: m.baseline.version, native_launch: true });
    currentScenario = 'initial-native-readiness';
    await launch('claude');
    await launch('codex');
    const initial = await idle();
    const retained = idsOf(initial);
    const oldMcp = processes(m);
    record(currentScenario, 'pass', { sessions: initial.sessions, mcp_processes: oldMcp, loaded_artifact: m.baseline });
    for (const agent of ['claude', 'codex']) {
      currentScenario = `baseline-delivery-${agent}`;
      const c = await challenge(agent, retained[agent], 'baseline');
      record(currentScenario, 'pass', await observeReply(c));
    }
    await idle(retained);
    currentScenario = 'low-mail-does-not-wake';
    const low = await Promise.all(['claude', 'codex'].map((agent) => challenge(agent, retained[agent], 'low-across-upgrade', 'low')));
    const lowUntil = Date.now() + lowObserve;
    while (Date.now() < lowUntil) {
      const state = assessReadiness(await rpc(m, 'session.who'), m.names, retained);
      if (!state.ok || !Object.values(state.sessions).every((s) => s.state === 'online-idle')) throw new Error('Low mail woke or changed a native session');
      for (const c of low) {
        const feed = await rpc(m, 'owner.feed', { limit: 100, name: c.recipient });
        if (correlatedReply(feed.messages, c)) throw new Error('Low-priority message caused a native reply without a wake');
        const original = await rpc(m, 'owner.show', { id: c.id });
        if (!original.deliveries.some((d) => d.state === 'held' && d.hold_reason === 'low')) throw new Error('Low mail was not observably held');
      }
      await pause(500);
    }
    record(currentScenario, 'pass', { observed_ms: lowObserve, message_ids: low.map((c) => c.id) });
    currentScenario = 'retained-idle-across-broker-replacement';
    if (artifact(candidate.root).package_code_sha256 !== candidate.package_code_sha256) throw new Error('Candidate package changed during native baseline run');
    evidence.candidate_installation = stagePackage(candidate.root, m.paths.installed, candidate.package_code_sha256);
    cli('init', '--codex', m.providers.codex);
    cli('broker', 'restart', '--expect-version', candidate.version);
    monitorPostUpgrade = true;
    const afterIdle = await ready(retained);
    const idleReplies = [];
    for (const agent of ['claude', 'codex']) idleReplies.push(await observeReply(await challenge(agent, retained[agent], 'after-idle-upgrade')));
    for (const c of low) idleReplies.push(await observeReply(c));
    const afterMcp = processes(m);
    if (oldMcp.length < 2 || !oldMcp.every((p) => afterMcp.some((s) => p.pid === s.pid && p.start === s.start))) throw new Error('Old MCP processes were not retained across broker replacement');
    record(currentScenario, 'pass', { sessions: afterIdle.sessions, broker: await rpc(m, 'sys.ping'), replies: idleReplies, retained_mcp: afterMcp });
    await idle(retained);
    currentScenario = 'retained-busy-across-broker-replacement';
    const workFile = join(m.paths.workspace, '.wigwag-native-work.mjs');
    const releaseFile = join(m.paths.workspace, '.wigwag-native-release');
    if (!existsSync(workFile) || existsSync(releaseFile)) throw new Error('Fresh prepared native work barrier is required');
    const workProcesses = () => Object.fromEntries(['claude', 'codex'].map((agent) => [agent, processTable().find((p) => {
      const args = p.command.split(/\s+/);
      return args[0]?.split('/').at(-1) === 'node' && [workFile, '.wigwag-native-work.mjs'].includes(args[1]) && args[2] === `${agent}-${m.id}` && args.length === 3;
    })]));
    await Promise.all(['claude', 'codex'].map((agent) => keys(agent, `For this acceptance step, run exactly node .wigwag-native-work.mjs ${agent}-${m.id} with your shell tool in the foreground. ${agent === 'claude' ? 'Use Bash timeout 65000.' : 'Use yield_time_ms 30000, then wait for that same shell session until it exits.'} This read-only workspace helper checks for the driver's release file every 200ms for at most 60s. Do not background it or replace it with sleep. After it returns call the public Wigwag whoami tool, then end the turn. Continue replying to synthetic Wigwag messages using their requested exact tokens. Do not call any internal Wigwag hooks or bind tools.`)));
    const busy = await until('both native sessions busy', async () => {
      const state = assessReadiness(await rpc(m, 'session.who'), m.names, retained);
      const work = workProcesses();
      return state.ok && Object.values(state.sessions).every((s) => s.state === 'online-busy') && Object.values(work).every(Boolean) && { ...state, work };
    });
    const busyChallenges = await Promise.all(['claude', 'codex'].map((agent) => challenge(agent, retained[agent], 'after-busy-upgrade')));
    const inFlight = await Promise.all(busyChallenges.map((c) => rpc(m, 'owner.show', { id: c.id })));
    const preReplacementFeed = await rpc(m, 'owner.feed', { limit: 100 });
    if (busyChallenges.some((c) => correlatedReply(preReplacementFeed.messages, c))) throw new Error('A busy challenge completed before broker replacement; in-flight native response was not exercised');
    cli('broker', 'restart', '--expect-version', candidate.version);
    await ready(retained);
    const workAfterReplacement = workProcesses();
    if (!Object.entries(busy.work).every(([agent, p]) => workAfterReplacement[agent]?.pid === p.pid && workAfterReplacement[agent]?.start === p.start)) throw new Error('Native foreground work did not survive through broker replacement');
    write(releaseFile, `Released by native acceptance driver after broker replacement ${m.id}\n`);
    const busyReplies = await Promise.all(busyChallenges.map(observeReply));
    const afterBusy = await idle(retained);
    const busyMcp = processes(m);
    if (!oldMcp.every((p) => busyMcp.some((s) => p.pid === s.pid && p.start === s.start))) throw new Error('Old MCP processes changed during busy replacement');
    record(currentScenario, 'pass', { before: busy.sessions, after: afterBusy.sessions, foreground_work: { script_sha256: hash(readFileSync(workFile)), before: busy.work, after_replacement: workAfterReplacement, released_after_replacement: true }, normal_mail_before_replacement: inFlight.map((m) => ({ id: m.message.id, deliveries: m.deliveries })), replies: busyReplies, retained_mcp: busyMcp });
    currentScenario = 'claude-reload';
    cli('install', '--codex-binary', m.providers.codex);
    command(m.providers.claude, ['plugin', 'update', 'wigwag@wigwag'], { env, cwd: m.paths.workspace, timeout: 0 });
    const claudeInstalled = json(join(m.paths.claude, 'plugins', 'installed_plugins.json')).plugins?.['wigwag@wigwag'];
    if (!Array.isArray(claudeInstalled) || !claudeInstalled.some((p) => p.version === candidate.version)) throw new Error('Native Claude plugin update did not install the candidate plugin version');
    evidence.claude_installed_plugin = claudeInstalled.map((p) => ({ version: p.version, scope: p.scope }));
    launchEpoch.claude++;
    await slash('claude', '/reload-plugins');
    await until('Claude native reload observation', () => /(?:Reloaded|reloaded|successfully reloaded).*(?:plugin|Wigwag)|(?:plugin|Wigwag).*(?:reloaded|reload complete)/.test(pane('claude')));
    await keys('claude', 'Call the public Wigwag whoami tool and report your exact bound status and session name. End this turn.');
    const afterReload = await idle();
    let reloaded = afterReload;
    let remediation = 'reload-only';
    if (afterReload.sessions.claude.client?.version !== candidate.version || afterReload.sessions.claude.client_mode !== 'current' || afterReload.sessions.claude.compatibility_warning !== null) {
      remediation = 'reload-then-native-restart-continue';
      await slash('claude', '/exit');
      await until('old Claude native pane exit', () => tmux('display-message', '-p', '-t', 'acceptance:claude', '#{pane_dead}') === '1');
      tmux('kill-window', '-t', 'acceptance:claude');
      await until('old Claude session naturally offline', async () => !(await rpc(m, 'session.who')).some((s) => s.agent === 'claude' && s.state !== 'offline'));
      await launch('claude', true);
    }
    reloaded = await idle(undefined, { claude: candidate.version });
    record(currentScenario, 'pass', { remediation, reload_observed_client: afterReload.sessions.claude.client, sessions: reloaded.sessions, reply: await observeReply(await challenge('claude', reloaded.sessions.claude.id, 'after-claude-reload')) });
    currentScenario = 'codex-restart-hook-trust';
    await slash('codex', '/quit');
    await until('original Codex pane exit', () => tmux('display-message', '-p', '-t', 'acceptance:codex', '#{pane_dead}') === '1');
    tmux('kill-window', '-t', 'acceptance:codex');
    command(m.providers.codex, ['app-server', 'daemon', 'stop'], { env });
    await until('old Codex session naturally offline', async () => !(await rpc(m, 'session.who')).some((s) => s.agent === 'codex' && s.state !== 'offline'));
    write(join(m.paths.codex, 'config.toml'), preTrustConfig);
    if (!verifyCodexScope()) throw new Error('Restored private config is not Wigwag-only');
    codexTrustAction = 'defer';
    await launch('codex');
    currentScenario = 'untrusted-initial-hooks-native-recovery';
    const unbound = await until('genuine initial hook-trust deferral leaves a connected unbound Codex session', async () => {
      const observed = evidence.trust_ui.some((e) => e.agent === 'codex' && e.launch_epoch === launchEpoch.codex && e.action === 'continued-without-trusting-native-ui');
      const native = (await rpc(m, 'session.who')).find((s) => s.agent === 'codex' && s.state !== 'offline' && s.bound === false && s.link === 'connected');
      return observed && native && /unbound|bound["']?\s*[:=]\s*false/i.test(pane('codex')) && native;
    });
    codexTrustAction = 'trust';
    await slash('codex', '/hooks');
    await until('native Wigwag-only hook review was trusted', () => evidence.trust_ui.some((e) => e.agent === 'codex' && e.launch_epoch === launchEpoch.codex && e.kind === 'wigwag-hooks-review' && e.action === 'accepted-native-ui'));
    tmux('send-keys', '-t', 'acceptance:codex', 'Escape');
    await keys('codex', `Use only the public Wigwag whoami tool. If your name differs from ${m.names.codex}, register that name, then call whoami again. Report bound status and end this turn. Do not call session_bind or any internal hook tool.`);
    const restarted = await idle(undefined, { claude: candidate.version, codex: candidate.version });
    if (restarted.sessions.codex.id !== unbound.id) throw new Error('Hook recovery replaced the unbound MCP session instead of binding it');
    const trust = evidence.trust_ui.filter((e) => e.agent === 'codex' && e.kind === 'wigwag-hooks-review' && e.launch_epoch === launchEpoch.codex);
    const reply = await observeReply(await challenge('codex', restarted.sessions.codex.id, 'after-codex-restart'));
    await idle(undefined, { claude: candidate.version, codex: candidate.version });
    assertNativeUiHealthy();
    record(currentScenario, 'pass', { cause: 'Native initial hooks deliberately left untrusted, then trusted through /hooks; a genuine later user-turn hook bound the same MCP session.', before: unbound, after: restarted.sessions.codex, reply });
    currentScenario = 'codex-restart-hook-trust';
    record(currentScenario, trust.length ? 'pass' : 'blocked', { sessions: restarted.sessions, reply, trust_observed: trust.length > 0, note: trust.length ? 'Native UI observed; binding and correlated model reply followed.' : 'Restart worked but native hook trust UI was not observed.' });
    for (const agent of ['claude', 'codex']) {
      const observed = evidence.trust_ui.some((t) => t.agent === agent && t.action === 'accepted-native-ui' && ['workspace', 'wigwag-hooks', 'wigwag-hooks-review', 'wigwag-development-channel'].includes(t.kind));
      record(`${agent}-trust-ui`, observed ? 'pass' : 'blocked', { note: observed ? 'Native trust prompt captured privately; subsequent binding/delivery verified.' : 'No native trust prompt was observed; persisted trust is not proof of a fresh trust UI transition.' });
    }
  } catch (error) {
    record(currentScenario, error.blocked ? 'blocked' : 'fail', { reason: error.message });
    screenshots();
  } finally {
    screenshots();
    evidence.finished_at = new Date().toISOString();
    if (values['keep-sessions']) evidence.cleanup = { status: 'kept', tmux_socket: m.tmux_socket };
    else evidence.cleanup = await cleanup(m);
    evidence.status = overallVerdict(evidence.scenarios, evidence.cleanup);
    save();
    process.stdout.write(`Evidence: ${join(m.root, 'evidence.json')}\nOverall: ${evidence.status}\n`);
    process.exitCode = evidence.status === 'pass' ? 0 : evidence.status === 'fail' ? 1 : 2;
  }
}

async function cleanup(m) {
  const env = environment(m);
  const result = { status: 'pass', errors: [], notes: [], observed_owned_processes: ownedProcesses(m) };
  const alive = () => { const current = processTable(); return result.observed_owned_processes.filter((p) => current.some((c) => c.pid === p.pid && c.start === p.start)); };
  const tmuxAlive = () => spawnSync('tmux', ['-L', m.tmux_socket, 'has-session', '-t', 'acceptance'], { timeout: 5000, stdio: 'ignore' }).status === 0;
  // This server was created with a fresh random socket identifier recorded in the ownership marker.
  const tmuxStopped = spawnSync('tmux', ['-L', m.tmux_socket, 'kill-server'], { env, timeout: 10000, stdio: 'ignore' });
  if (tmuxStopped.status !== 0) result.notes.push('tmux stop returned nonzero; absence is checked below');
  // The daemon path is unique to this prepared run. Never call daemon stop with the live CODEX_HOME.
  if (existsSync(join(m.paths.codex, 'app-server-control', 'app-server-control.sock'))) {
    try { command(m.providers.codex, ['app-server', 'daemon', 'stop'], { env }); }
    catch (e) { result.notes.push(`private Codex daemon stop: ${e.message}`); }
  }
  await pause(500);
  const isBroker = (p) => ownedCliCommand(p.command, m.paths.installed, ['broker']);
  // Stop reconnecting clients before the final broker stop, so teardown cannot autospawn a new broker.
  for (const p of alive().filter((p) => !isBroker(p))) { try { process.kill(p.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') result.notes.push(`owned pid ${p.pid}: ${e.message}`); } }
  const nativeDeadline = Date.now() + 5000;
  while (Date.now() < nativeDeadline && alive().some((p) => !isBroker(p))) await pause(250);
  for (const p of alive().filter((p) => !isBroker(p))) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') result.notes.push(`owned pid ${p.pid}: ${e.message}`); } }
  try {
    const ping = await rpc(m, 'sys.ping');
    if (Number.isInteger(ping.pid) && ping.pid > 1) {
      const broker = processTable().find((p) => p.pid === ping.pid);
      if (!broker || !isBroker(broker)) { result.errors.push('Broker socket PID does not have this run exact Node/broker argv; not signalled'); throw new Error('Private broker command ownership not verified'); }
      if (broker && !result.observed_owned_processes.some((p) => p.pid === broker.pid && p.start === broker.start)) result.observed_owned_processes.push(broker);
      command(process.execPath, [join(m.paths.installed, 'dist', 'main.js'), 'broker', 'stop'], { env });
    }
  } catch (e) { result.notes.push(`private broker stop: ${e.message}`); }
  const end = Date.now() + 10000;
  while (Date.now() < end && (alive().length || tmuxAlive() || existsSync(join(m.paths.wigwag, 'broker.sock')) || existsSync(join(m.paths.codex, 'app-server-control', 'app-server-control.sock')))) await pause(250);
  result.remaining_owned_processes = alive();
  if (result.remaining_owned_processes.length) result.errors.push('Captured owned processes remain alive with the same start identity');
  if (tmuxAlive()) result.errors.push('Owned tmux server/session still exists');
  if (existsSync(join(m.paths.wigwag, 'broker.sock'))) result.errors.push('Private broker socket still exists');
  if (existsSync(join(m.paths.codex, 'app-server-control', 'app-server-control.sock'))) result.errors.push('Private Codex daemon socket still exists');
  if (result.errors.length) result.status = 'fail';
  return result;
}

try {
  if (values.help) process.stdout.write(help);
  else if (mode === 'prepare') prepare();
  else if (mode === 'run') await execute(ownedManifest());
  else if (mode === 'cleanup') { const result = await cleanup(ownedManifest()); process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.status === 'fail' ? 1 : 0; }
  else { process.stdout.write(help); process.exitCode = 2; }
} catch (e) { process.stderr.write(`native acceptance: ${e.message}\n`); process.exitCode = 2; }
