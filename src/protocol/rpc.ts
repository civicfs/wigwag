import { z } from 'zod';
import { type ErrorCode, WigwagError } from '../errors.js';
import { BLOB_REF_RE, NAME_RE } from '../ids.js';
import { AnswersZ } from '../questions/schema.js';
import { SCHEMA_VERSION, VERSION } from '../version.js';
import { HookOriginZ, HostClientZ } from './codex-hook.js';

export const PROTOCOL_VERSION = 1 as const;
export const HANDSHAKE_VERSIONS = {
  protocol: PROTOCOL_VERSION,
  schema_version: SCHEMA_VERSION,
  version: VERSION,
} as const;
export const BROKER_OLDER = 'broker is older than this client: restart it with `wigwag broker stop` then retry';
export const CLIENT_OLDER =
  'client is older than the broker: update/reload the plugin (and update the CLI), then retry';

export const LEGACY_CLIENT_WARNING = 'legacy client 0.2: reload plugin for new features';

/** Protocol/schema are compatibility gates; package releases only advise a convenient reload. */
export function assertPeerVersions(
  raw: unknown,
  peer: 'broker' | 'client',
): { legacy: boolean; warning: string | null } {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const field of ['protocol', 'schema_version'] as const) {
    const value = p[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))
      throw new WigwagError(
        'schema',
        `invalid ${field} from ${peer}: expected a nonnegative integer; ${peer === 'broker' ? 'update/restart the broker' : 'update/reload the plugin and CLI'}, then retry`,
        {
          kind: 'invalid-version',
          peer,
          expected: HANDSHAKE_VERSIONS,
          received: { protocol: p.protocol, schema_version: p.schema_version, version: p.version },
        },
      );
  }
  const oldRole = p.role === 'mcp' || p.role === 'hook' || p.role === 'owner';
  if (
    peer === 'client' &&
    p.protocol === PROTOCOL_VERSION &&
    p.schema_version === undefined &&
    p.version === undefined &&
    oldRole
  )
    return { legacy: true, warning: LEGACY_CLIENT_WARNING };
  const order = [
    typeof p.protocol === 'number' ? p.protocol - PROTOCOL_VERSION : -1,
    typeof p.schema_version === 'number' ? p.schema_version - SCHEMA_VERSION : -1,
  ].find((n) => n !== 0);
  if (order === undefined) {
    if (peer === 'client' && p.version === undefined) return { legacy: true, warning: LEGACY_CLIENT_WARNING };
    const client = peer === 'client' ? p.version : VERSION;
    const broker = peer === 'broker' ? p.version : VERSION;
    return {
      legacy: false,
      warning:
        p.version === VERSION
          ? null
          : `client ${client ?? 'unknown'} differs from broker ${broker ?? 'unknown'}; restart/reload when convenient`,
    };
  }
  const brokerOlder = peer === 'broker' ? order < 0 : order > 0;
  throw new WigwagError('schema', brokerOlder ? BROKER_OLDER : CLIENT_OLDER, {
    kind: 'version-skew',
    peer,
    expected: HANDSHAKE_VERSIONS,
    received: { protocol: p.protocol, schema_version: p.schema_version, version: p.version },
  });
}

export const PriorityZ = z.enum(['urgent', 'normal', 'low']);
export const NameZ = z.string().regex(NAME_RE, 'name must match ^[a-z][a-z0-9-]{1,47}$');
export const ToZ = z.union([NameZ, z.literal('all')]);
export const BlobRefZ = z.string().regex(BLOB_REF_RE, 'blob ref must be sha256:<64 hex>');
export const DeliveryStateZ = z.enum(['pending', 'held', 'pushed', 'failed', 'stuck', 'read']);
const Attach = z.array(BlobRefZ).default([]);
const Subject = z.string().min(1).max(200);
/** Stored when a send names no subject (spec §10: `--subject` is optional). */
export const NO_SUBJECT = '(no subject)';
const OptionalSubject = Subject.default(NO_SUBJECT);
/** Paging maxima (spec §11 fixed constants), shared with the CLI's range checks (R38). */
export const FEED_LIMIT_MAX = 1000;
export const STREAM_READ_LIMIT_MAX = 1000;
export const KV_LIST_LIMIT_MAX = 1000;

export const HelloZ = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION),
    schema_version: z.number().int().nonnegative().optional(),
    version: z.string().min(1).max(100).optional(),
    role: z.enum(['mcp', 'hook', 'owner']),
    agent: z.enum(['claude', 'codex']).optional(),
    // final m-2: the workspace is computed from cwd; a relative one would resolve against the broker's own cwd
    cwd: z.string().startsWith('/', 'cwd must be an absolute path').optional(),
    pid_chain: z.array(z.number().int()).optional(),
    mcp_ppid: z.number().int().optional(),
    requested_name: NameZ.optional(),
    // E-3: an MCP server in Claude mode reports whether the channel can deliver pushes to this client. Absent from an
    // older or non-Claude peer, which the broker treats as capable.
    channel: z.boolean().optional(),
    resume_session_id: z.string().optional(),
    host_client: HostClientZ.optional(),
  })
  .strict();
export type Hello = z.infer<typeof HelloZ>;

/** Broker-only event: the MCP process remembers its current slot without exposing it to the model. */
export const SessionIdentityZ = z
  .object({
    session_id: z
      .string()
      .regex(/^ses-[a-z0-9-]+$/)
      .max(100),
  })
  .strict();

export type Access = 'any' | 'session' | 'hook' | 'owner' | 'session+owner';

const m = <P extends z.ZodType>(access: Access, params: P) => ({ access, params });
const NativeHookZ = z.object({
  agent: z.enum(['claude', 'codex']),
  native_session_id: z.string().min(1),
  cwd: z.string().startsWith('/'),
  agent_pid: z.number().int().nullable(),
  pid_chain: z.array(z.number().int()),
});

export const METHODS = {
  'sys.ping': m('any', z.object({})),

  'session.register': m(
    'session',
    z
      .object({
        name: NameZ.optional(),
        native: z.literal(true).optional().describe('Follow the native session title again instead of a custom name.'),
      })
      .refine((p) => (p.name === undefined) !== (p.native === undefined), 'pass exactly one of name or native'),
  ),
  'assignment.delegate': m(
    'session',
    z.object({ to: NameZ, subject: Subject, body: z.string(), idempotency_key: z.string().min(1).max(200) }).strict(),
  ),
  'assignment.release': m('session+owner', z.object({ assignment_id: z.string().min(1) })),
  'question.answer': m('session', z.object({ relay_id: z.string().min(1), answers: AnswersZ })),
  'owner.resolve_question': m(
    'owner',
    z.object({ relay_id: z.string().min(1), outcome: z.enum(['cancel', 'delivered']) }).strict(),
  ),
  'question.list': m(
    'session+owner',
    z.object({
      include_history: z.boolean().default(false),
      limit: z.number().int().min(1).max(10).default(10),
      before: z.string().min(1).optional(),
    }),
  ),
  'question.details': m(
    'session+owner',
    z.object({ relay_id: z.string().min(1), offset: z.number().int().min(0).default(0) }),
  ),
  'hook.question_ready': m('hook', NativeHookZ),
  'hook.question_capture': m(
    'hook',
    NativeHookZ.extend({
      tool_name: z.string(),
      tool_use_id: z.string().min(1),
      turn_id: z.string().min(1),
      tool_input: z.unknown(),
    }),
  ),
  'hook.question_poll': m('hook', NativeHookZ.extend({ relay_id: z.string().min(1) })),
  'hook.question_applied': m('hook', NativeHookZ.extend({ relay_id: z.string().min(1) })),
  'session.whoami': m('session', z.object({})),
  'session.who': m(
    'session+owner',
    z.object({
      include_offline: z.boolean().optional().describe('Include offline sessions (agents default to live sessions).'),
      limit: z.number().int().min(1).max(50).optional().describe('Page size, 1-50; agents default to 25.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Skip this many matching sessions; increment to read the next page.'),
    }),
  ),
  'session.bind': m(
    'session',
    z
      .object({
        agent_session_id: z.string().min(1),
        question_relay_version: z.literal(1).optional(),
        hook_origin: HookOriginZ.optional(),
      })
      .strict(),
  ),
  'session.turn': m('session', z.object({ phase: z.enum(['started', 'ended']), hook_origin: HookOriginZ.optional() })),
  'session.digest': m('session', z.object({ hook_origin: HookOriginZ.optional() })),
  // Iteration-2 provisions (spec §16 P3): reserved, no handler in v1.
  // E-1: `wigwag codex --as <name>` tells the broker which name the Codex session it is about to start should take.
  'launch.intend': m(
    'owner',
    z.object({
      agent: z.literal('codex'),
      name: NameZ,
      cwd: z.string().startsWith('/', 'cwd must be an absolute path'),
    }),
  ),
  'session.spawn': m('session+owner', z.looseObject({})),
  'session.stop': m('session+owner', z.looseObject({})),

  'hook.event': m(
    'hook',
    z.object({
      agent: z.literal('claude'),
      event: z.enum(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']),
      agent_session_id: z.string().min(1),
      cwd: z.string(),
      pid_chain: z.array(z.number().int()),
      // The hook's nearest `claude` ancestor (its own agent process), or null when it has none.
      agent_pid: z.number().int().nullable(),
      // W2/W7 (S-B, S-E): Claude's optional custom title, transcript location and SessionStart source.
      session_title: z.string().max(1000).optional(),
      transcript_path: z.string().startsWith('/').max(4096).optional(),
      source: z.string().max(32).optional(),
    }),
  ),

  'msg.send': m(
    'session',
    z.object({ to: ToZ, subject: OptionalSubject, body: z.string(), priority: PriorityZ, attachments: Attach }),
  ),
  'msg.reply': m(
    'session',
    z.object({
      msg_id: z.string().min(1),
      body: z.string(),
      priority: PriorityZ.default('normal'),
      attachments: Attach,
    }),
  ),
  'msg.inbox': m(
    'session',
    z.object({
      include_read: z.boolean().default(false),
      limit: z.number().int().positive().max(500).default(50),
      before: z.string().min(1).optional(),
    }),
  ),
  'msg.read': m(
    'session',
    z.object({
      msg_id: z.string().min(1),
      body_offset: z.number().int().min(0).default(0),
      attachment_offset: z.number().int().min(0).default(0),
    }),
  ),
  'msg.ack': m('session', z.object({ ids: z.array(z.string()).min(1) })),
  'mute.add': m('session', z.object({ target: z.string().regex(/^(sender|stream):.+$/) })),
  'mute.remove': m('session', z.object({ target: z.string().regex(/^(sender|stream):.+$/) })),

  'blob.put': m(
    'session',
    z
      .object({
        path: z.string().optional(),
        text: z.string().optional(),
        media_type: z.string().min(1),
        name: z.string().optional(),
      })
      .refine((p) => (p.path === undefined) !== (p.text === undefined), 'exactly one of path or text is required'),
  ),
  'blob.get': m('session+owner', z.object({ ref: BlobRefZ, dest_path: z.string().optional() })),

  'kv.get': m('session+owner', z.object({ key: z.string() })),
  'kv.list': m(
    'session+owner',
    z.object({
      prefix: z.string().max(200).default(''),
      limit: z.number().int().positive().max(KV_LIST_LIMIT_MAX).default(50),
      cursor: z
        .string()
        .min(1)
        .max(8192)
        .optional()
        .describe('Pass next_cursor from the previous page; keep the same prefix.'),
    }),
  ),
  'kv.history': m('session+owner', z.object({ key: z.string() })),
  'kv.cas': m(
    'session',
    z.object({ key: z.string(), expected_version: z.number().int().positive().nullable(), value: z.json() }),
  ),
  'kv.delete': m('session', z.object({ key: z.string(), expected_version: z.number().int().positive() })),
  'kv.watch': m('session', z.object({ prefix: z.string(), priority: PriorityZ.default('low') })),

  'stream.create': m(
    'session',
    z.object({ name: z.string(), json_schema: z.json().nullable(), description: z.string().min(1) }),
  ),
  'stream.append': m('session', z.object({ name: z.string(), record: z.json() })),
  'stream.read': m(
    'session+owner',
    z.object({
      name: z.string(),
      after_seq: z.number().int().min(0).default(0),
      limit: z.number().int().positive().max(STREAM_READ_LIMIT_MAX).default(100),
    }),
  ),
  'stream.subscribe': m(
    'session',
    z.object({
      name: z.string(),
      priority: PriorityZ.default('low'),
      filter: z.record(z.string(), z.json()).nullable().default(null),
    }),
  ),
  'stream.list': m('session+owner', z.object({})),

  'req.request': m(
    'session',
    z.object({
      to: NameZ,
      subject: Subject,
      body: z.string(),
      attachments: Attach,
      expires_in_s: z.number().int().positive().optional(),
    }),
  ),
  'req.respond': m(
    'session',
    z.object({ request_id: z.string().min(1), body: z.string(), status: z.enum(['ok', 'error']), attachments: Attach }),
  ),
  'req.await': m('session', z.object({ request_id: z.string().min(1), wait_s: z.number().int().min(0) })),
  'req.list': m('session+owner', z.object({ status: z.enum(['open', 'answered', 'expired', 'all']).default('all') })),

  'owner.subscribe': m('owner', z.object({})),
  'owner.snapshot': m('owner', z.object({ feed_limit: z.number().int().positive().max(1000).default(200) })),
  'owner.feed': m(
    'owner',
    z.object({
      before: z.string().optional(),
      limit: z.number().int().positive().max(FEED_LIMIT_MAX).default(100),
      name: NameZ.optional(),
    }),
  ),
  'owner.send': m(
    'owner',
    z.object({
      to: ToZ,
      subject: OptionalSubject,
      body: z.string(),
      priority: PriorityZ,
      attach_paths: z.array(z.string()).default([]),
    }),
  ),
  'owner.release_throttle': m('owner', z.object({ from: z.string(), to: z.string() })),
  'owner.deliveries': m('owner', z.object({ states: z.array(DeliveryStateZ).min(1) })),
  'owner.show': m('owner', z.object({ id: z.string() })),
  'owner.blobs': m('owner', z.object({ limit: z.number().int().positive().max(1000).default(200) })),
  // Spec §17: `a`/`b` are an absolute path inside a workspace, or a session name (resolved to its workspace).
  'owner.link': m('owner', z.object({ a: z.string().min(1), b: z.string().min(1) })),
  'owner.unlink': m('owner', z.object({ a: z.string().min(1), b: z.string().min(1) })),
  'owner.links': m('owner', z.object({})),
  // W7: resume-recovery flags and duplicate slots; retiring excludes an offline slot from automatic recovery.
  'owner.recovery': m('owner', z.object({ limit: z.number().int().positive().max(200).default(50) })),
  'owner.retire_slot': m('owner', z.object({ session_id: z.string().min(1), force: z.boolean().default(false) })),
} as const;

export type MethodName = keyof typeof METHODS;
export type Params<M extends MethodName> = z.output<(typeof METHODS)[M]['params']>;

export type WireError = { code: ErrorCode; message: string; data?: unknown };
export type RequestFrame = { id: number; method: string; params?: unknown };
export type ResponseFrame = { id: number; result: unknown } | { id: number; error: WireError };
export type EventFrame = { event: 'push' | 'feed'; data: unknown };
export type PushData = { content: string; meta: Record<string, string> };
export type FeedData = { type: 'message' | 'delivery' | 'session' | 'throttle' | 'link'; payload: unknown };
