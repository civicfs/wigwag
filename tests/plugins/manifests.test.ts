import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

describe('plugin manifests', () => {
  it('claude plugin wires the MCP server and four hooks to the wigwag binary', () => {
    expect(json('plugins/claude/.mcp.json').mcpServers.wigwag).toEqual({
      command: 'wigwag',
      args: ['mcp', '--agent', 'claude'],
    });
    const hooks = json('plugins/claude/hooks/hooks.json').hooks;
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      expect(hooks[ev][0].hooks[0].command).toBe(`wigwag hook claude ${ev}`);
    }
    expect(json('.claude-plugin/marketplace.json').plugins[0]).toMatchObject({
      name: 'wigwag',
      source: './plugins/claude',
    });
  });
  it('codex plugin declares mcp_tool hooks against its own server', () => {
    const p = json('plugins/codex/.codex-plugin/plugin.json');
    expect(p.mcpServers).toBe('./.mcp.json');
    expect(p.hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: 'mcp_tool',
      server: 'wigwag',
      tool: 'session_bind',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Codex hook placeholder
      input: { session_id: '${session_id}' },
    });
    for (const [ev, tool] of [
      ['UserPromptSubmit', 'turn_started'],
      ['Stop', 'turn_ended'],
      ['Interrupt', 'turn_ended'],
      ['PostToolUse', 'hook_digest'],
    ]) {
      expect(p.hooks.hooks[ev][0].hooks[0]).toMatchObject({ type: 'mcp_tool', server: 'wigwag', tool });
    }
    expect(json('plugins/codex/.mcp.json').mcpServers.wigwag.args).toEqual(['mcp', '--agent', 'codex']);
    // Final review I-8: Codex gives MCP servers a minimal environment; every variable that picks the home must pass.
    expect([...json('plugins/codex/.mcp.json').mcpServers.wigwag.env_vars].sort()).toEqual([
      'WIGWAG_HOME',
      'WIGWAG_NAME',
      'XDG_STATE_HOME',
    ]);
    expect(json('.agents/plugins/marketplace.json').plugins[0].source).toEqual({
      source: 'local',
      path: './plugins/codex',
    });
  });
});
