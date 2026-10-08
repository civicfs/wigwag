import { execFileSync } from 'node:child_process';

/** The command line of a live process (`ps -o args=` on macOS and Linux); '' when it cannot be read. */
export function processArgs(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Claude Code only registers a plugin's channel when it is named by one of these flags (variadic: every following
// token up to the next flag is a channel). The channel entry for this plugin is `plugin:wigwag@<marketplace>` or
// `server:wigwag` (.mcp.json).
const CHANNEL_FLAGS = new Set(['--dangerously-load-development-channels', '--channels']);
const WIGWAG_ENTRY = /^(?:plugin:wigwag@[^\s]+|server:wigwag)$/;

/**
 * True when `args` (a claude command line) names the wigwag channel. Claude Code does not advertise channel support
 * in its MCP client capabilities (2.1.294: roots, elicitation, tasks only), so the launch flags of the parent claude
 * process are the evidence that it will accept `notifications/claude/channel` from this server.
 */
export function loadsWigwagChannel(args: string): boolean {
  const tokens = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const eq = tokens[i].indexOf('=');
    const flag = eq < 0 ? tokens[i] : tokens[i].slice(0, eq);
    if (!CHANNEL_FLAGS.has(flag)) continue;
    if (eq >= 0 && WIGWAG_ENTRY.test(tokens[i].slice(eq + 1))) return true;
    for (let j = i + 1; j < tokens.length && !tokens[j].startsWith('-'); j++) {
      if (WIGWAG_ENTRY.test(tokens[j])) return true;
    }
  }
  return false;
}
