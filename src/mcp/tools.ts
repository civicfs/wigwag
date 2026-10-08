import { z } from 'zod';
import { METHODS, type MethodName } from '../protocol/rpc.js';
import type { Agent } from '../store/sessions.js';

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodType;
  method: MethodName;
  map?: (args: Record<string, unknown>) => unknown;
  format?: (result: unknown) => string;
  /**
   * Repairs argument shapes some MCP clients produce (E4: Claude Code sends `expected_version: null` as the string
   * "null" and JSON-typed values as JSON text). It only rewrites representation; `input` still validates strictly.
   */
  coerce?: (args: Record<string, unknown>) => Record<string, unknown>;
  hookOnly?: boolean;
  agents: Agent[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string argument whose contract is "any JSON value": valid JSON text is decoded, any other string stays itself. */
const decodeJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** "null" -> null (create-only CAS) and a decimal integer string -> number; everything else is left for zod to judge. */
const decodeVersion = (v: unknown, allowNull: boolean): unknown => {
  if (v === 'null' && allowNull) return null;
  return typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : v;
};

/** Rewrites only the named keys that are present, so a missing required key still fails validation. */
const coerceKeys =
  (fns: Record<string, (v: unknown) => unknown>) =>
  (args: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...args };
    for (const [k, f] of Object.entries(fns)) if (k in out) out[k] = f(out[k]);
    return out;
  };

/** Coerces then validates a tool call's arguments with the tool's strict schema. */
export function parseToolInput(tool: ToolDef, raw: unknown) {
  return tool.input.safeParse(tool.coerce && isRecord(raw) ? tool.coerce(raw) : raw);
}

const both: Agent[] = ['claude', 'codex'];
const t = (name: string, method: MethodName, description: string, extra: Partial<ToolDef> = {}): ToolDef => ({
  name,
  method,
  description,
  input: METHODS[method].params,
  agents: both,
  ...extra,
});

export const TOOLS: ToolDef[] = [
  t(
    'register',
    'session.register',
    "Set this session's wigwag name (a role, e.g. codex-merger). Rejected if a live session holds it.",
  ),
  t('whoami', 'session.whoami', "Show this session's wigwag name, state and unread count."),
  t('who', 'session.who', 'List wigwag sessions: name, agent, busy/idle/offline, unread.'),
  t('send', 'msg.send', 'Send a message to a session name or "all". priority: urgent | normal | low.'),
  t('reply', 'msg.reply', 'Reply to a message by msg_id; goes to its sender.'),
  t(
    'inbox',
    'msg.inbox',
    'Fetch undelivered messages (marks them read); pushed and digested ones are already read. include_read to see history.',
  ),
  t('ack', 'msg.ack', 'Mark message ids as read.'),
  t(
    'mute',
    'mute.add',
    'Mute a sender ("sender:<name>") or stream ("stream:<name>"): its normal messages wait for your next turn. Urgent still wakes you.',
  ),
  t('unmute', 'mute.remove', 'Undo a mute.'),
  t(
    'blob_put',
    'blob.put',
    'Store a file (absolute path) or text as an immutable blob; returns its sha256 ref for attachments.',
  ),
  t(
    'blob_get',
    'blob.get',
    'Fetch a blob by ref: small text inline, or write to an absolute dest_path (never overwrites).',
  ),
  t('kv_get', 'kv.get', 'Read a shared key.'),
  t('kv_list', 'kv.list', 'List shared keys under a prefix.'),
  t(
    'kv_cas',
    'kv.cas',
    'Compare-and-set a shared key. expected_version null = create only (the string "null" is also accepted). value is any JSON value; a string that is valid JSON text is stored decoded (to store the string 42, pass "\\"42\\""). On conflict returns the current value.',
    {
      coerce: coerceKeys({
        expected_version: (v) => decodeVersion(v, true),
        value: decodeJson,
      }),
    },
  ),
  t('kv_delete', 'kv.delete', 'Delete a shared key at an expected version (history is kept).', {
    coerce: coerceKeys({ expected_version: (v) => decodeVersion(v, false) }),
  }),
  t('kv_watch', 'kv.watch', 'Get notified when keys under a prefix change (default priority low).'),
  t('kv_history', 'kv.history', 'All versions of a key.'),
  t('stream_create', 'stream.create', 'Create a named append-only stream with an optional JSON Schema for records.', {
    coerce: coerceKeys({ json_schema: decodeJson }),
  }),
  t(
    'stream_append',
    'stream.append',
    'Append a record to a stream (validated against its schema). record is any JSON value; a string that is valid JSON text is decoded first.',
    {
      coerce: coerceKeys({ record: decodeJson }),
    },
  ),
  t('stream_read', 'stream.read', 'Read stream records after a sequence number.'),
  t(
    'stream_subscribe',
    'stream.subscribe',
    'Get notified of new records (optional exact-match filter on top-level fields).',
    { coerce: coerceKeys({ filter: decodeJson }) },
  ),
  t('stream_list', 'stream.list', 'List streams.'),
  t('request', 'req.request', 'Ask a session something that needs an answer; returns request_id.'),
  t('respond', 'req.respond', 'Answer a request addressed to you (once).'),
  t('await_response', 'req.await', 'Wait up to wait_s seconds (capped by the broker) for a response to your request.'),
  t('requests', 'req.list', 'List requests you sent or received, by status.'),

  // Codex hooks call these through `mcp_tool` hooks (plugins/codex). Hidden from Claude.
  t('session_bind', 'session.bind', 'Internal: called by the wigwag SessionStart hook. Do not call.', {
    input: z.object({ session_id: z.string().min(1) }),
    map: (a) => ({ agent_session_id: a.session_id }),
    hookOnly: true,
    agents: ['codex'],
  }),
  t('turn_started', 'session.turn', 'Internal: called by the wigwag UserPromptSubmit hook. Do not call.', {
    input: z.looseObject({}),
    map: () => ({ phase: 'started' }),
    hookOnly: true,
    agents: ['codex'],
  }),
  t('turn_ended', 'session.turn', 'Internal: called by the wigwag Stop/Interrupt hooks. Do not call.', {
    input: z.looseObject({}),
    map: () => ({ phase: 'ended' }),
    hookOnly: true,
    agents: ['codex'],
  }),
  t('hook_digest', 'session.digest', 'Internal: called by the wigwag PostToolUse hook. Do not call.', {
    input: z.looseObject({}),
    map: () => ({}),
    format: (r) => {
      // Codex parses mcp_tool hook output as hook JSON; plain text is rejected ("invalid post-tool-use JSON output").
      const text = (r as { text: string | null }).text;
      return JSON.stringify(
        text ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } : {},
      );
    },
    hookOnly: true,
    agents: ['codex'],
  }),
];

export const toolsFor = (agent: Agent): ToolDef[] => TOOLS.filter((x) => x.agents.includes(agent));
