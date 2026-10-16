import { WigwagError } from '../errors.js';
import { type HookOrigin, type HostClient, validateHookOrigin } from '../protocol/codex-hook.js';

/** Codex 0.162.1 hook calls have host threadId, while model calls also have callId. Never read origin from arguments. */
export function hookOrigin(host: HostClient | undefined, meta: unknown, args: Record<string, unknown>): HookOrigin {
  if (
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    ['_meta', 'threadId', 'thread_id', 'callId', 'call_id', 'hook_origin', 'host_client', 'agent_session_id'].some(
      (key) => Object.hasOwn(args, key),
    )
  )
    throw new WigwagError(
      'bad_request',
      'Codex internal tools require host hook-origin metadata, never argument-supplied identity',
    );
  const m = meta as Record<string, unknown>;
  const origin = validateHookOrigin(
    {
      name: host?.name,
      version: host?.version,
      thread_id: m.threadId,
      ...(Object.hasOwn(m, 'callId') ? { call_id: m.callId } : {}),
    },
    host,
  );
  if (Object.hasOwn(args, 'session_id') && args.session_id !== origin.thread_id)
    throw new WigwagError('bad_request', 'Codex hook session_id does not match the concrete host threadId; not bound');
  return origin;
}
