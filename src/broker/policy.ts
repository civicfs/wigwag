import type { HoldReason, Priority } from '../store/messages.js';
import type { RecipientState } from './registry.js';

export type Decision = { action: 'push' } | { action: 'hold'; reason: HoldReason };

const hold = (reason: HoldReason): Decision => ({ action: 'hold', reason });

/** Spec §6. Pure; the engine applies it. */
export function decide(i: {
  priority: Priority;
  recipient: RecipientState;
  muted: boolean;
  throttled: boolean;
}): Decision {
  if (i.recipient === 'offline') return hold('offline');
  if (i.recipient === 'unbound') return hold('unbound');
  if (i.throttled) return hold('throttled');
  // W8: a Claude session whose MCP link is down cannot take a push; the next hook boundary delivers the digest.
  if (i.recipient === 'disconnected') return hold('disconnected');
  // A Claude session that cannot take channel pushes is not woken: the item waits for the next turn-boundary hook or an
  // inbox call (E-3). It reuses the `unbound` reason: the stored reasons are fixed by the schema's CHECK constraint.
  const wake: Decision = i.recipient === 'no-channel' ? hold('unbound') : { action: 'push' };
  if (i.priority === 'urgent') return wake;
  if (i.muted) return hold('muted');
  if (i.priority === 'low') return hold('low');
  return wake;
}
