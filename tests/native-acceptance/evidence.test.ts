import { describe, expect, it } from 'vitest';
import {
  assessReadiness,
  correlatedReply,
  deliveryOwnedBy,
  nativeUiErrors,
  overallVerdict,
  ownedCliCommand,
  pluginTrustScope,
  recognizeTrustPrompt,
  sanitizePane,
  shellQuote,
  uiActionKeys,
} from '../../scripts/native-acceptance/helpers.mjs';

const names = { claude: 'native-claude', codex: 'native-codex' };
const sessions = [
  { id: 'c', name: names.claude, agent: 'claude', bound: true, state: 'online-idle', link: 'connected' },
  {
    id: 'x',
    name: names.codex,
    agent: 'codex',
    bound: true,
    state: 'online-idle',
    link: 'connected',
    bind_origin: 'hook-verified',
    codex_push_reason: null,
  },
];

describe('native acceptance evidence gates', () => {
  it('requires both expected names, binding, native hook trust and live delivery capability', () => {
    expect(assessReadiness(sessions, names).ok).toBe(true);
    for (const patch of [
      { bound: false },
      { bind_origin: 'unverified' },
      { codex_push_reason: 'app-server-unavailable' },
      { state: 'offline' },
      { link: 'disconnected' },
    ]) {
      expect(assessReadiness([sessions[0], { ...sessions[1], ...patch }], names).ok).toBe(false);
    }
    expect(assessReadiness(sessions, { ...names, codex: 'wrong' }).ok).toBe(false);
    expect(assessReadiness([...sessions, { ...sessions[1], id: 'duplicate' }], names).ok).toBe(false);
  });

  it('refuses a new session that has taken a retained provider name', () => {
    expect(assessReadiness(sessions, names, { claude: 'c', codex: 'old-x' }).ok).toBe(false);
  });

  it('requires a model reply from the expected provider to the exact message ID and token', () => {
    const challenge = { id: 'msg-challenge', token: 'NATIVE-unique', recipient: 'native-codex', sessionId: 'x' };
    const reply = {
      id: 'msg-reply',
      from_name: 'native-codex',
      to_target: 'owner',
      reply_to: challenge.id,
      body: challenge.token,
      sender_session_id: 'x',
    };
    expect(correlatedReply([reply], challenge)).toEqual(reply);
    for (const patch of [
      { from_name: 'owner' },
      { reply_to: 'other' },
      { body: 'wrong' },
      { sender_session_id: 'other' },
      { to_target: 'other' },
    ]) {
      expect(correlatedReply([{ ...reply, ...patch }], challenge)).toBeUndefined();
    }
    expect(correlatedReply([{ state: 'pushed', message_id: challenge.id }], challenge)).toBeUndefined();
    expect(correlatedReply([{ state: 'read', message_id: challenge.id }], challenge)).toBeUndefined();
  });

  it('keeps unknown gates blocked and cleanup failures failed', () => {
    expect(overallVerdict([], { status: 'pass' })).toBe('blocked');
    expect(overallVerdict([{ status: 'pass' }, { status: 'blocked' }], { status: 'pass' })).toBe('blocked');
    expect(overallVerdict([{ status: 'pass' }], { status: 'fail' })).toBe('fail');
    expect(overallVerdict([{ status: 'pass' }], { status: 'pass' })).toBe('pass');
    expect(overallVerdict([{ status: 'fail' }], { status: 'pass' })).toBe('fail');
  });

  it('requires retained mail ownership, and requires an actual wake transport when requested', () => {
    const c = { id: 'm', sessionId: 's', recipient: 'native-claude', expectedTransport: 'claude-channel' };
    const d = { message_id: 'm', recipient: c.recipient, recipient_session_id: 's', transport: 'claude-channel' };
    expect(deliveryOwnedBy([d], c)).toBe(true);
    expect(deliveryOwnedBy([{ ...d, recipient_session_id: 'different' }], c)).toBe(false);
    expect(deliveryOwnedBy([{ ...d, transport: 'hook' }], c)).toBe(false);
    expect(deliveryOwnedBy([{ ...d, recipient: 'different' }], c)).toBe(false);
  });

  it('does not mistake ordinary permission or authentication screens for disposable trust', () => {
    expect(recognizeTrustPrompt('codex', 'Do you want to run this command?')).toBeUndefined();
    expect(recognizeTrustPrompt('claude', 'Sign in to your account')).toBeUndefined();
    expect(recognizeTrustPrompt('codex', 'Trust all hooks from unknown-plugin?')).toBeUndefined();
    expect(
      recognizeTrustPrompt('claude', 'Do you trust the files in this folder?\n/tmp/elsewhere', '/tmp/own'),
    ).toBeUndefined();
  });

  it('accepts the observed Codex review menu only for the sole staged plugin and expected hook count', () => {
    const pane =
      "Hooks need review\n6 hooks are new or changed.\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting (hooks won't run)";
    expect(recognizeTrustPrompt('codex', pane)).toBeUndefined();
    expect(recognizeTrustPrompt('codex', pane, '/tmp/own', { onlyWigwag: true, hookCount: 6 })).toEqual({
      kind: 'wigwag-hooks',
      keys: ['Down', 'Enter'],
    });
    expect(recognizeTrustPrompt('codex', pane, '/tmp/own', { onlyWigwag: true, hookCount: 5 })).toBeUndefined();
    expect(
      recognizeTrustPrompt('codex', pane.replace('6 hooks', '16 hooks'), '/tmp/own', {
        onlyWigwag: true,
        hookCount: 6,
      }),
    ).toBeUndefined();
  });

  it('accepts only the observed own-workspace and exact development-channel prompts', () => {
    const workspace =
      'Accessing workspace:\n\n /private/tmp/own/workspace\nIs this a project you created or one you trust?\nNo, exit\nYes, I trust this folder';
    expect(recognizeTrustPrompt('claude', workspace, '/private/tmp/own/workspace')?.keys).toEqual(['Down', 'Enter']);
    expect(recognizeTrustPrompt('claude', workspace, '/private/tmp/other')).toBeUndefined();
    expect(
      recognizeTrustPrompt('claude', workspace.replace('/workspace', '/workspace-other'), '/private/tmp/own/workspace'),
    ).toBeUndefined();
    expect(
      recognizeTrustPrompt(
        'claude',
        `Earlier workspace /private/tmp/own/workspace\n${workspace.replace('/workspace', '/workspace-other')}`,
        '/private/tmp/own/workspace',
      ),
    ).toBeUndefined();
    expect(
      recognizeTrustPrompt(
        'claude',
        'WARNING: Loading development channels\nChannels: plugin:wigwag@wigwag\nplugin:other@elsewhere\n1. I am using this for local development',
      ),
    ).toBeUndefined();
    expect(
      recognizeTrustPrompt(
        'claude',
        'WARNING: Loading development channels\nChannels: plugin:wigwag@wigwag\n1. I am using this for local development',
      )?.kind,
    ).toBe('wigwag-development-channel');
    expect(
      recognizeTrustPrompt(
        'claude',
        'WARNING: Loading development channels\nChannels: plugin:other@elsewhere\n1. I am using this for local development',
      ),
    ).toBeUndefined();
  });

  it('allows only named synthetic Wigwag tools through the native Codex session permission UI', () => {
    const prompt =
      'Allow the wigwag MCP server to run tool "whoami"?\n1. Allow\n2. Allow for this session\n3. Always allow\n4. Cancel';
    expect(recognizeTrustPrompt('codex', prompt)).toEqual({
      kind: 'wigwag-tool-permission',
      tool: 'whoami',
      keys: ['Down', 'Enter'],
    });
    expect(recognizeTrustPrompt('codex', prompt.replace('whoami', 'session_bind'))).toBeUndefined();
    expect(recognizeTrustPrompt('codex', prompt.replace('wigwag MCP', 'other MCP'))).toBeUndefined();
    expect(recognizeTrustPrompt('codex', `${prompt}\n${prompt.replace('whoami', 'reply')}`)?.tool).toBe('reply');
    expect(recognizeTrustPrompt('codex', `${prompt}\n${prompt.replace('whoami', 'session_bind')}`)).toBeUndefined();
  });

  it('withholds authentication screens and redacts token-like strings from private pane logs', () => {
    expect(sanitizePane('Sign in using secret-device-code')).toBe('[authentication screen withheld]');
    expect(sanitizePane(`Bearer sensitive-token\n${['sk', 'ant', 'api'].join('-')}${'0'.repeat(24)}`)).not.toContain(
      'sensitive-token',
    );
    expect(sanitizePane('ordinary synthetic output')).toBe('ordinary synthetic output');
  });

  it('requires observed enabled plugin inventory and refuses unknown config hooks before bulk trust', () => {
    const inventory = {
      installed: [
        { pluginId: 'wigwag@wigwag', enabled: true },
        { pluginId: 'other@remote', enabled: true },
      ],
    };
    expect(pluginTrustScope(inventory, '')).toBe(false);
    inventory.installed[1].enabled = false;
    expect(pluginTrustScope(inventory, '')).toBe(false);
    const policy = '[plugins._default]\nenabled = false\n';
    expect(pluginTrustScope(inventory, policy)).toBe(true);
    expect(pluginTrustScope(inventory, `${policy}[features]\nremote_plugin = false\nhooks = true\n`)).toBe(true);
    expect(pluginTrustScope(inventory, 'hooks = [{ command = "other" }]\n[features]\nhooks = true')).toBe(false);
    expect(pluginTrustScope(inventory, '[hooks.Stop]\ncommand="other"')).toBe(false);
    expect(pluginTrustScope(inventory, `${policy}[hooks.state."wigwag@wigwag:SessionStart"]\ntrusted_hash="abc"`)).toBe(
      true,
    );
    expect(pluginTrustScope({}, '')).toBe(false);
  });

  it('never chooses a default exit or global permission when retrying native UI', () => {
    expect(uiActionKeys('claude', '❯ No, exit', { kind: 'workspace' })?.keys).toEqual(['Down', 'Enter']);
    expect(uiActionKeys('claude', '❯ Yes, I trust this folder', { kind: 'workspace' })?.keys).toEqual(['Enter']);
    expect(uiActionKeys('codex', '› 2. Allow for this session', { kind: 'wigwag-tool-permission' })?.keys).toEqual([
      'Enter',
    ]);
    expect(uiActionKeys('codex', '› 3. Always allow', { kind: 'wigwag-tool-permission' })?.keys).toEqual([
      'Up',
      'Enter',
    ]);
    expect(uiActionKeys('codex', '› 1. Review hooks', { kind: 'wigwag-hooks' }, true)?.keys).toEqual([
      'Down',
      'Down',
      'Enter',
    ]);
    expect(uiActionKeys('claude', 'unknown selection', { kind: 'workspace' })).toBeUndefined();
  });

  it('requires actual Node/script/verb argv for direct CLI process ownership', () => {
    const root = '/tmp/own/installed';
    expect(ownedCliCommand(`node ${root}/dist/main.js mcp`, root)).toBe(true);
    expect(ownedCliCommand(`/usr/bin/node ${root}/dist/main.js broker run`, root, ['broker'])).toBe(true);
    expect(ownedCliCommand(`rg ${root}/dist/main.js mcp`, root)).toBe(false);
    expect(ownedCliCommand(`editor ${root}/dist/main.js broker`, root)).toBe(false);
    expect(ownedCliCommand(`node /tmp/other.mjs ${root}/dist/main.js mcp`, root)).toBe(false);
  });

  it('detects native hook/schema/identity failures without flagging ordinary hook prohibitions', () => {
    expect(nativeUiErrors('Do not call session_bind or any internal hook tool.')).toEqual([]);
    expect(nativeUiErrors('Hook failed: bad_request: wrong native identity')).toHaveLength(1);
    expect(nativeUiErrors('Error: schema: broker is older than this client')).toHaveLength(1);
  });

  it('requires the actual per-session candidate stamp after native refresh', () => {
    const current = sessions.map((s) => ({
      ...s,
      client: { version: '0.3.5' },
      client_mode: 'current',
      compatibility_warning: null,
    }));
    expect(assessReadiness(current, names, {}, { claude: '0.3.5' }).ok).toBe(true);
    expect(assessReadiness(current, names, {}, { claude: '0.3.6' }).ok).toBe(false);
  });

  it('quotes literal shell arguments without executing dollar or command substitutions', () => {
    expect(shellQuote("a'b$(secret)`other`")).toBe("'a'\"'\"'b$(secret)`other`'");
  });
});
