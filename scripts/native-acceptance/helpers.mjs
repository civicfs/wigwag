/** These gates consume observations; they never create native hook metadata or bind a session. */
export function assessReadiness(sessions, names, retained = {}, expectedVersions = {}) {
  const reasons = [];
  const selected = {};
  for (const [agent, name] of Object.entries(names)) {
    const matches = sessions.filter((s) => s.agent === agent && s.name === name && s.state !== 'offline');
    if (matches.length !== 1) {
      reasons.push(`${agent}: expected exactly one live ${name}, found ${matches.length}`);
      continue;
    }
    const s = matches[0];
    selected[agent] = s;
    if (s.bound !== true) reasons.push(`${agent}: bound is not true`);
    if (s.link !== 'connected') reasons.push(`${agent}: MCP link is not connected`);
    if (!['online-idle', 'online-busy'].includes(s.state)) reasons.push(`${agent}: native session is not live`);
    if (retained[agent] && retained[agent] !== s.id) reasons.push(`${agent}: retained session identity changed`);
    if (expectedVersions[agent] && (s.client?.version !== expectedVersions[agent] || s.client_mode !== 'current' || s.compatibility_warning !== null)) reasons.push(`${agent}: running MCP artifact is not the expected current client`);
    if (agent === 'codex') {
      if (s.bind_origin !== 'hook-verified') reasons.push('codex: native hook binding is not verified');
      if (s.codex_push_reason !== null) reasons.push(`codex: push is blocked or unobserved (${s.codex_push_reason})`);
    }
  }
  return { ok: reasons.length === 0, reasons, sessions: selected };
}

export function correlatedReply(messages, challenge) {
  return messages.find((m) =>
    typeof m.id === 'string' && m.from_name === challenge.recipient && m.to_target === 'owner' &&
    m.reply_to === challenge.id && m.body?.trim() === challenge.token &&
    (m.sender_session_id === undefined || m.sender_session_id === challenge.sessionId));
}

export function overallVerdict(scenarios, cleanup) {
  if (cleanup.status === 'fail' || scenarios.some((s) => s.status === 'fail')) return 'fail';
  return scenarios.length > 0 && scenarios.every((s) => s.status === 'pass') ? 'pass' : 'blocked';
}

export function deliveryOwnedBy(deliveries, challenge) {
  return deliveries.some((d) => d.message_id === challenge.id && d.recipient === challenge.recipient &&
    (challenge.allowUncapturedOwner && d.recipient_session_id === undefined || d.recipient_session_id === challenge.sessionId) &&
    (!challenge.expectedTransport || d.transport === challenge.expectedTransport));
}

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

export function sanitizePane(pane) {
  if (/sign[ -]?in|log[ -]?in|device.{0,10}code|oauth|authenticate|authentication/i.test(pane)) return '[authentication screen withheld]';
  return pane.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|sess)-[a-zA-Z0-9_-]{16,}\b/g, '[redacted-token]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted-token]');
}

export function pluginTrustScope(inventory, config) {
  if (!Array.isArray(inventory.installed) || !inventory.installed.every((p) => typeof p.pluginId === 'string' && typeof p.enabled === 'boolean')) return false;
  const active = inventory.installed.filter((p) => p.enabled);
  if (active.length !== 1 || active[0].pluginId !== 'wigwag@wigwag') return false;
  let section = '';
  let defaultDisabled = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      section = line.match(/^\[\[?([^\]]+)\]/)?.[1] ?? '';
      if (/^hooks(?:\.|$)/.test(section) && !/^hooks\.state(?:\.|$)/.test(section)) return false;
    } else if (['plugins._default', 'plugins."_default"'].includes(section) && /^enabled\s*=/.test(line)) {
      defaultDisabled = /^enabled\s*=\s*false\s*(?:#.*)?$/.test(line);
    } else if (/^(?:hooks|"hooks"|'hooks')(?:\s*=|\.)/.test(line)) {
      if (section !== 'features' || !/^(?:hooks|"hooks"|'hooks')\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(line)) return false;
    }
  }
  return defaultDisabled;
}

export function ownedCliCommand(commandLine, root, allowed = ['mcp', 'broker', 'claude', 'codex']) {
  const args = commandLine.split(/\s+/);
  return /(?:^|\/)node$/.test(args[0]) && args[1] === `${root}/dist/main.js` && allowed.includes(args[2]);
}

export function nativeUiErrors(pane) {
  return pane.split('\n').filter((line) => /\bHook failed\b|\bhook error\b|Error:\s*(?:schema|bad_request)|Codex internal tools require|Codex hook session_id does not match|broker is older than this client|client is older than the broker|Session changed while validating native identity/i.test(line));
}

export function uiActionKeys(agent, pane, match, defer = false) {
  if (match.kind === 'wigwag-hooks-review') return { keys: ['t'] };
  let selected = Number([...pane.matchAll(/^\s*[›❯>]\s*(\d+)\./gm)].at(-1)?.[1]);
  let target;
  if (match.kind === 'workspace' && agent === 'claude') {
    selected = /^\s*[›❯>]\s*Yes, I trust this folder/m.test(pane) ? 2 : /^\s*[›❯>]\s*No, exit/m.test(pane) ? 1 : NaN;
    target = 2;
  } else if (match.kind === 'wigwag-hooks') target = defer ? 3 : 2;
  else if (match.kind === 'wigwag-tool-permission') target = 2;
  else if (match.kind === 'wigwag-development-channel') target = 1;
  if (!Number.isInteger(selected) || !Number.isInteger(target) || selected < 1 || selected > 4) return undefined;
  return { keys: [...Array(Math.abs(target - selected)).fill(target > selected ? 'Down' : 'Up'), 'Enter'], selected, target };
}

/** Only source-specific trust UIs belong here. Never match general command permissions or accept auth prompts. */
export function recognizeTrustPrompt(agent, pane, workspace, context = {}) {
  if (agent === 'claude' && workspace && pane.match(/Accessing workspace:\s*([^\s]+)/)?.[1] === workspace &&
      /Is this a project you created or one you trust\?/.test(pane) &&
      /No, exit/.test(pane) && /Yes, I trust this folder/.test(pane)) {
    return { kind: 'workspace', keys: ['Down', 'Enter'] };
  }
  if (agent === 'codex' && context.onlyWigwag === true && Number.isInteger(context.hookCount) &&
      Number([...pane.matchAll(/\b(\d+) hooks are new or changed\./g)].at(-1)?.[1]) === context.hookCount &&
      /Hooks need review/.test(pane) && /1\. Review hooks/.test(pane) &&
      /2\. Trust all and continue/.test(pane) &&
      /3\. Continue without trusting \(hooks won't run\)/.test(pane)) {
    return { kind: 'wigwag-hooks', keys: ['Down', 'Enter'] };
  }
  if (agent === 'codex' && context.onlyWigwag === true && Number.isInteger(context.hookCount) &&
      /Lifecycle hooks from config and enabled plugins\./.test(pane) &&
      Number(pane.match(/\b(\d+) hooks need review before they can run\./)?.[1]) === context.hookCount &&
      /t trust all\s*·\s*enter review\s*·\s*esc close/.test(pane)) {
    return { kind: 'wigwag-hooks-review', keys: ['t'] };
  }
  if (agent === 'claude' && /WARNING: Loading development channels/.test(pane) &&
      /Channels:\s*plugin:wigwag@wigwag\s*(?:\n|$)/.test(pane) &&
      [...pane.matchAll(/\b(?:plugin|server):[^\s,]+/g)].length === 1 &&
      /1\. I am using this for local development/.test(pane)) {
    return { kind: 'wigwag-development-channel', keys: ['Enter'] };
  }
  const permission = [...pane.matchAll(/Allow the ([^\s]+) MCP server to run tool "([^"]+)"\?/g)].at(-1);
  if (agent === 'codex' && permission?.[1] === 'wigwag' && ['whoami', 'register', 'send', 'reply', 'inbox'].includes(permission[2]) &&
      /1\. Allow/.test(pane) && /2\. Allow for this session/.test(pane) &&
      /3\. Always allow/.test(pane) && /4\. Cancel/.test(pane)) {
    return { kind: 'wigwag-tool-permission', tool: permission[2], keys: ['Down', 'Enter'] };
  }
  return undefined;
}
