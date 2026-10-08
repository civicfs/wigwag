import { realpathSync } from 'node:fs';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { ensureBroker, sockPath } from '../client/autospawn.js';
import { Client } from '../client/client.js';
import { type Config, loadConfig, resolveHome } from '../config.js';
import { frameLimit } from '../protocol/frame.js';
import type { MessageRow } from '../store/messages.js';

export const out = (s: string): void => {
  process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
};

export class UsageError extends Error {}

export const cliEntry = (): string => realpathSync(process.argv[1]);

export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')).join('\n');
}

export async function ownerConnect(
  onEvent?: (name: string, data: unknown) => void,
): Promise<{ client: Client; home: string; config: Config }> {
  const home = resolveHome();
  const config = loadConfig(home);
  await ensureBroker(home, config, cliEntry());
  const { client } = await Client.connect(sockPath(home), { protocol: 1, role: 'owner' }, frameLimit(config), onEvent);
  return { client, home, config };
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');

export const formatMessage = (m: MessageRow): string =>
  [
    `${m.created_at}  ${m.id}  ${m.from_name} → ${m.to_target}  [${m.priority}/${m.kind}]${m.reply_to ? `  re ${m.reply_to}` : ''}`,
    `  ${m.subject}`,
    indent(m.body),
    ...(m.attachments.length ? [`  attachments: ${m.attachments.join(', ')}`] : []),
  ].join('\n');

/** parseArgs with its errors surfaced as usage errors (exit 2). */
export function parseCli<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** A numeric flag within the RPC's bounds (R38), so an out-of-range value is a usage error (exit 2), not exit 1. */
export function parseCount(
  value: string | undefined,
  flag: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < range.min || n > range.max) {
    throw new UsageError(`${flag} must be an integer from ${range.min} to ${range.max}`);
  }
  return n;
}
