import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exactPendingPrompt,
  hookTableSelection,
  initialSkewFailure,
  ownedCliCommand,
  ownedDaemonSocket,
  trustedSessionStart,
} from '../../scripts/native-acceptance/skew.mjs';

describe('native incompatible-broker evidence gates', () => {
  const oneFailure =
    '• Hook failed\n  └ MCP tool returned an error: schema: broker is older than this client: restart it with wigwag broker stop';
  const genuineFailure = `${oneFailure}\n${oneFailure}\n• Called wigwag.whoami({})\n└ schema: broker is older than this client`;

  it('requires paired real native failures before the first model tool in exactly one initial prompt', () => {
    expect(initialSkewFailure(genuineFailure, 1)).toBe(true);
    expect(initialSkewFailure(genuineFailure, 0)).toBe(false);
    expect(initialSkewFailure(genuineFailure, 2)).toBe(false);
    expect(initialSkewFailure(genuineFailure.replaceAll('Hook failed', 'whoami failed'), 1)).toBe(false);
    expect(initialSkewFailure(genuineFailure.replaceAll('schema:', 'bad_request:'), 1)).toBe(false);
    expect(initialSkewFailure(`${oneFailure}\n• Called wigwag.whoami({})\n${oneFailure}`, 1)).toBe(false);
    expect(initialSkewFailure(`${oneFailure}\n${oneFailure}\n${oneFailure}\n• Called wigwag.whoami({})`, 1)).toBe(
      false,
    );
  });

  it('observes trusted native SessionStart source and never toggles hooks from its detail view', () => {
    const detail =
      'SessionStart hooks\nEvent SessionStart\nSource Plugin - wigwag@wigwag\nMCP Server wigwag\nMCP Tool session_bind\nTrust Trusted\nspace/enter toggle · esc back';
    expect(trustedSessionStart(detail)).toBe(true);
    expect(trustedSessionStart(detail.replace('Plugin - wigwag@wigwag', 'Plugin - other@remote'))).toBe(false);
    expect(trustedSessionStart(detail.replace('session_bind', 'whoami'))).toBe(false);
    expect(trustedSessionStart(detail.replace('Trust Trusted', 'Trust Untrusted'))).toBe(false);
    const table =
      'Event Installed Active Review Description\n› PostToolUse 2 1 1 After a tool\nPreCompact 0 0 0 Before compact\nPostCompact 0 0 0 After compact\nSessionStart 1 1 0 When a new session starts';
    expect(hookTableSelection(table, 'SessionStart')).toEqual(['Down', 'Down', 'Down']);
    expect(
      hookTableSelection(table.replace('SessionStart 1 1 0', 'SessionStart 1 0 1'), 'SessionStart'),
    ).toBeUndefined();
    expect(hookTableSelection(table.replace('›', ' '), 'SessionStart')).toBeUndefined();
    const withoutReview =
      'Event Installed Active Description\n› PreToolUse 1 1 Before tool\nPostToolUse 1 1 After tool\nSessionStart 1 1 When a new session starts';
    expect(hookTableSelection(withoutReview, 'SessionStart')).toEqual(['Down', 'Down']);
    expect(
      hookTableSelection(withoutReview.replace('Event Installed Active Description', ''), 'SessionStart'),
    ).toBeUndefined();
  });

  it('resubmits only the exact visible pending user prompt across native line wraps', () => {
    const text = 'Use only public whoami. End this turn and wait.';
    expect(exactPendingPrompt('› Use only public whoami. End this turn\n  and wait.\n\n GPT model default', text)).toBe(
      true,
    );
    expect(
      exactPendingPrompt(
        '› Use only public whoami. End this turn and wait.\n\n• Called wigwag.whoami({})\n\n› Ask Codex to do anything',
        text,
      ),
    ).toBe(false);
    expect(exactPendingPrompt('› Use only public whoami. End this turn and wait. extra', text)).toBe(false);
    expect(exactPendingPrompt('› unknown command', text)).toBe(false);
  });

  it('preserves exact identifiers across native hard wraps without adding spaces', () => {
    const text = 'Initialize this Wigwag session as native-codex-4c2c8b09ff. Call public whoami.';
    const pane =
      '› Initialize this Wigwag session as native-codex-\n  4c2c8b09ff. Call public\n  whoami.\n\n GPT model default';
    expect(exactPendingPrompt(pane, text)).toBe(true);
    expect(exactPendingPrompt(pane.replace('4c2c8b09ff', '4c2c8b09fe'), text)).toBe(false);
    expect(exactPendingPrompt(pane.replace('4c2c8b09ff', '4c2c 8b09ff'), text)).toBe(false);
    expect(exactPendingPrompt(pane.replace('  whoami.', '  whoami. extra'), text)).toBe(false);
    expect(exactPendingPrompt(pane.replace('  whoami.\n\n', '  whoami.\n  extra\n\n'), text)).toBe(false);
    expect(exactPendingPrompt(pane.replace('Call public\n  whoami.', 'Call'), text)).toBe(false);
  });

  it('does not claim unrelated processes merely mentioning the private CLI path', () => {
    const root = '/private/tmp/wws-own/installed';
    expect(ownedCliCommand(`node ${root}/dist/main.js mcp --agent codex`, root)).toBe(true);
    expect(ownedCliCommand(`node ${root}/dist/main.js broker run`, root, ['broker'])).toBe(true);
    expect(ownedCliCommand(`editor ${root}/dist/main.js`, root)).toBe(false);
    expect(ownedCliCommand(`rg ${root}/dist/main.js diagnostic.log`, root)).toBe(false);
    expect(ownedCliCommand(`rg ${root}/dist/main.js mcp`, root)).toBe(false);
    expect(ownedCliCommand(`echo ${root}/dist/main.js broker`, root)).toBe(false);
    expect(ownedCliCommand(`node unrelated.js ${root}/dist/main.js mcp`, root)).toBe(false);
    expect(ownedCliCommand(`node ${root}-other/dist/main.js mcp`, root)).toBe(false);
    expect(ownedCliCommand(`node ${root}/dist/main.js --help`, root)).toBe(false);
  });

  it('accepts only owned socket metadata inside the private home or the native UID-scoped layout', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'wws-test-')));
    const home = join(root, 'codex');
    const control = join(home, 'app-server-control');
    mkdirSync(control, { recursive: true });
    const socketPath = join(control, 'app-server-control.sock');
    const server = createServer();
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(socketPath, yes);
    });
    try {
      expect(ownedDaemonSocket(socketPath, home)?.target).toBe(socketPath);
      expect(() => ownedDaemonSocket(socketPath, home, (process.getuid?.() ?? 0) + 1)).toThrow('ownership or type');
      expect(ownedDaemonSocket(join(control, 'missing.sock'), home)).toBeUndefined();
      const escapedSocket = join(control, 'escape.sock');
      symlinkSync(socketPath, escapedSocket);
      expect(() => ownedDaemonSocket(escapedSocket, home)).toThrow('unexpected symlink target');
      const other = join(root, 'other');
      mkdirSync(other);
      expect(() => ownedDaemonSocket(socketPath, other)).toThrow('escaped its home');
    } finally {
      await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())));
    }
  });
});
