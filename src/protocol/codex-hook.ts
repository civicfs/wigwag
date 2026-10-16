import { z } from 'zod';
import { WigwagError } from '../errors.js';

/** Source-audited host contract, not cryptographic attestation. Real hook metadata still needs live acceptance. */
export const VERIFIED_CODEX_HOST_VERSIONS = ['0.162.1'] as const;
export const HostClientZ = z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }).strict();
export type HostClient = z.infer<typeof HostClientZ>;
export const HookOriginZ = HostClientZ.extend({
  thread_id: z.string().min(1).max(200),
  call_id: z.unknown().optional(),
}).strict();
export type HookOrigin = z.infer<typeof HookOriginZ>;

export const trustedCodexHost = (host: HostClient | null | undefined, extra: readonly string[] = []): boolean =>
  host?.name === 'codex-mcp-client' && [...VERIFIED_CODEX_HOST_VERSIONS, ...extra].includes(host.version);

/** Used again at the broker boundary; an MCP tool argument can never establish this envelope. */
export function validateHookOrigin(value: unknown, host: HostClient | null | undefined): HookOrigin {
  const parsed = HookOriginZ.safeParse(value);
  if (
    !parsed.success ||
    !host ||
    host.name !== 'codex-mcp-client' ||
    parsed.data.name !== host.name ||
    parsed.data.version !== host.version ||
    Object.hasOwn(parsed.data, 'call_id')
  )
    throw new WigwagError(
      'bad_request',
      'Codex internal tools require matching host hook-origin metadata; model-origin calls are refused',
    );
  return parsed.data;
}

export function codexHostWarning(s: {
  bind_origin: string;
  host_client_name: string | null;
  host_client_version: string | null;
}): string | null {
  if (s.bind_origin === 'hook-verified') return null;
  const host =
    s.host_client_name && s.host_client_version ? { name: s.host_client_name, version: s.host_client_version } : null;
  return host && !trustedCodexHost(host)
    ? `Codex host ${host.name} ${host.version} not in the verified list: pushes held, inbox delivery works; see README`
    : 'Codex push held: reload the Wigwag plugin / restart this Codex session to enable push; inbox delivery works';
}
