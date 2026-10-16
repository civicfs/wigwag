import { VERSION } from '../version.js';
import { UsageError } from './util.js';

export interface CommandHelp {
  name: string;
  summary: string;
  /** Full invocations, each starting with `wigwag`. */
  usage: string[];
  /** Flag or argument, then its meaning. */
  flags: [string, string][];
}

/** The single source for `--help`, `help`, and every usage error. */
export const COMMANDS: CommandHelp[] = [
  {
    name: 'update',
    summary: 'check for updates, or explicitly apply one',
    usage: ['wigwag update [--check | --apply] [--json]'],
    flags: [
      ['--check', 'read-only update check (default)'],
      ['--apply', 'install a newer npm release, refresh plugins and broker'],
      ['--json', 'print check results as JSON'],
    ],
  },
  {
    name: 'install',
    summary: 'set up config, the broker, and both plugins',
    usage: ['wigwag install [--claude-only | --codex-only] [--codex-binary <path>]'],
    flags: [
      ['--claude-only', 'install only the Claude plugin'],
      ['--codex-only', 'install only the Codex plugin'],
      ['--codex-binary <path>', 'codex executable to record in config.json'],
    ],
  },
  {
    name: 'uninstall',
    summary: 'remove the plugins (keeps the wigwag home directory data)',
    usage: ['wigwag uninstall [--claude-only | --codex-only]'],
    flags: [
      ['--claude-only', 'remove only the Claude plugin'],
      ['--codex-only', 'remove only the Codex plugin'],
    ],
  },
  {
    name: 'init',
    summary: 'write config only',
    usage: ['wigwag init [--codex <path>]'],
    flags: [['--codex <path>', 'codex executable to record in config.json']],
  },
  {
    name: 'doctor',
    summary: 'check the installation',
    usage: ['wigwag doctor [--claude-only | --codex-only] [--codex-binary <path>]'],
    flags: [
      ['--claude-only', 'check only Claude'],
      ['--codex-only', 'check only Codex'],
      ['--codex-binary <path>', 'codex executable to check'],
    ],
  },
  {
    name: 'claude',
    summary: 'start Claude with push delivery',
    usage: ['wigwag claude [--as <name>] [claude arguments]'],
    flags: [
      ['--as <name>', 'session name, matching ^[a-z][a-z0-9-]{1,47}$ and not owner, all, or wigwag'],
      ['claude arguments', 'passed through to claude'],
    ],
  },
  {
    name: 'codex',
    summary: 'start Codex under a wigwag name; initialize fresh named sessions automatically',
    usage: ['wigwag codex [--as <name>] [codex arguments]'],
    flags: [
      ['--as <name>', 'session name, matching ^[a-z][a-z0-9-]{1,47}$ and not owner, all, or wigwag'],
      ['codex arguments', 'passed through; a readiness prompt is added to fresh named sessions with no prompt'],
    ],
  },
  {
    name: 'who',
    summary: 'list sessions',
    usage: ['wigwag who'],
    flags: [],
  },
  {
    name: 'send',
    summary: 'send a message as owner',
    usage: [
      'wigwag send <to|all> --priority urgent|normal|low [--subject <s>] (--body <text> | --body-file <path|->) [--attach <path>]',
    ],
    flags: [
      ['<to|all>', 'recipient session name, or all'],
      ['--priority urgent|normal|low', 'required'],
      ['--subject <s>', 'optional subject line'],
      ['--body <text>', 'message text (exclusive with --body-file)'],
      ['--body-file <path|->', 'read the message text from a file, or from stdin with -'],
      ['--attach <path>', 'attach a file; repeat for several'],
    ],
  },
  {
    name: 'tail',
    summary: 'show recent messages, or follow the live feed',
    usage: ['wigwag tail [-f] [--name <session>] [--limit <n>]'],
    flags: [
      ['-f', 'keep following new messages'],
      ['--name <session>', 'only messages to or from this session'],
      ['--limit <n>', 'number of messages to show'],
    ],
  },
  {
    name: 'show',
    summary: 'show one message, request, or blob',
    usage: ['wigwag show <msg-id|req-id|sha256:hash>'],
    flags: [['<msg-id|req-id|sha256:hash>', 'public id of the item to show']],
  },
  {
    name: 'kv',
    summary: 'read the shared key-value store',
    usage: [
      'wigwag kv get <key>',
      'wigwag kv list [prefix] [--limit <n>] [--cursor <cursor>] [--json]',
      'wigwag kv history <key>',
    ],
    flags: [
      ['get <key>', 'print the current value'],
      ['list [prefix]', 'list keys, optionally under a prefix'],
      ['history <key>', 'print every version of the key'],
      ['--limit <n>', 'KV list page size (default 50, maximum 1000; also capped at 12 KB)'],
      ['--cursor <cursor>', 'continue KV list with the returned next_cursor and the same prefix'],
      ['--json', 'print a KV list page with its continuation metadata'],
    ],
  },
  {
    name: 'streams',
    summary: 'read shared streams',
    usage: ['wigwag streams list', 'wigwag streams read <name> [--after <seq>] [--limit <n>]'],
    flags: [
      ['list', 'list streams'],
      ['read <name>', 'print entries of a stream'],
      ['--after <seq>', 'only entries after this sequence number'],
      ['--limit <n>', 'number of entries to show'],
    ],
  },
  {
    name: 'deliveries',
    summary: 'show delivery states and last errors',
    usage: ['wigwag deliveries [--stuck]'],
    flags: [['--stuck', 'only deliveries that are not progressing']],
  },
  {
    name: 'release-throttle',
    summary: 'clear loop protection between two sessions',
    usage: ['wigwag release-throttle <from> <to>'],
    flags: [
      ['<from>', 'sender session name'],
      ['<to>', 'recipient session name'],
    ],
  },
  {
    name: 'link',
    summary: 'let two workspaces talk',
    usage: ['wigwag link <a> <b>'],
    flags: [['<a> <b>', 'workspace paths or session names']],
  },
  {
    name: 'unlink',
    summary: 'remove a link',
    usage: ['wigwag unlink <a> <b>'],
    flags: [['<a> <b>', 'workspace paths or session names']],
  },
  {
    name: 'links',
    summary: 'list links',
    usage: ['wigwag links'],
    flags: [],
  },
  {
    name: 'recovery',
    summary: 'show resume-recovery flags and duplicate session slots',
    usage: ['wigwag recovery [--json]', 'wigwag recovery retire <session-id> [--force]'],
    flags: [
      ['--json', 'print the raw report'],
      ['retire <session-id>', 'exclude an offline slot from automatic resume recovery'],
      ['--force', 'retire despite active assignments or undelivered mail'],
    ],
  },
  {
    name: 'tui',
    summary: 'open the owner view',
    usage: ['wigwag tui'],
    flags: [],
  },
  {
    name: 'broker',
    summary: 'run or control the broker',
    usage: ['wigwag broker run|start|stop|restart|status'],
    flags: [
      ['run', 'run the broker in the foreground'],
      ['start', 'start the broker in the background'],
      ['stop', 'stop the running broker'],
      ['restart [--expect-version <version>]', 'wait for and verify a replacement broker'],
      ['status', 'show whether the broker is running'],
    ],
  },
  {
    name: 'mcp',
    summary: 'MCP server (run by the plugins)',
    usage: ['wigwag mcp --agent claude|codex'],
    flags: [['--agent claude|codex', 'which agent the server speaks for']],
  },
  {
    name: 'hook',
    summary: 'hook handler (run by the Claude plugin)',
    usage: ['wigwag hook claude <SessionStart|UserPromptSubmit|PostToolUse|Stop>'],
    flags: [],
  },
  {
    name: 'help',
    summary: 'show this help, or help for one command',
    usage: ['wigwag help [command]', 'wigwag --help', 'wigwag <command> --help'],
    flags: [],
  },
];

const find = (name: string): CommandHelp | undefined => COMMANDS.find((c) => c.name === name);

/** The text of a usage error for one command, from the same table as `--help`. */
export function usageText(name: string): string {
  const c = find(name);
  if (!c) throw new Error(`no help entry for ${name}`);
  return `usage: ${c.usage.join('\n       ')}`;
}

export const usageError = (name: string): UsageError => new UsageError(usageText(name));

export function topHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 'wigwag '.length;
  return [
    `wigwag ${VERSION}: messages and shared data between local Claude Code and Codex sessions`,
    '',
    'usage: wigwag <command> [options]     (ww is an alias for wigwag)',
    '',
    'commands:',
    ...COMMANDS.map((c) => `  ${`wigwag ${c.name}`.padEnd(width)}  ${c.summary}`),
    '',
    'wigwag <command> --help shows the usage and flags of one command.',
    'The home directory is $WIGWAG_HOME, else $XDG_STATE_HOME/wigwag, else ~/.wigwag.',
    '',
  ].join('\n');
}

export function commandHelp(name: string): string {
  const c = find(name);
  if (!c) throw new UsageError(`unknown command: ${name}\n\n${topHelp()}`);
  const width = Math.max(0, ...c.flags.map(([f]) => f.length));
  return [
    `wigwag ${c.name}: ${c.summary}`,
    '',
    usageText(name),
    ...(c.flags.length ? ['', 'flags:', ...c.flags.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`)] : []),
    '',
  ].join('\n');
}
