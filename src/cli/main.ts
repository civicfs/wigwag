import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';
import { WigwagError } from '../errors.js';
import { type ClaudeHookEvent, runClaudeHook } from '../hooks/claude.js';
import { install, packageRoot, uninstall } from '../install/install.js';
import { runMcp } from '../mcp/server.js';
import { runQuestionHook } from '../questions/hook.js';
import {
  assertNativeAllowed,
  assertRehearsalAccess,
  assertRehearsalHome,
  assertRehearsalStorage,
  clearRehearsal,
  homeRehearsalMode,
} from '../rehearsal.js';
import { terminalText } from '../terminal.js';
import { runTui } from '../tui/run.js';
import { applyUpdate, checkUpdate, describeUpdate } from '../update/update.js';
import { VERSION } from '../version.js';
import { cmdBroker } from './commands/broker.js';
import { CLAUDE_LAUNCH, cmdDoctor } from './commands/doctor.js';
import { cmdInit } from './commands/init.js';
import { cmdLaunch } from './commands/launch.js';
import {
  cmdDeliveries,
  cmdKv,
  cmdLink,
  cmdLinks,
  cmdQuestions,
  cmdRecovery,
  cmdReleaseThrottle,
  cmdSend,
  cmdShow,
  cmdStreams,
  cmdTail,
  cmdUnlink,
  cmdWho,
} from './commands/owner.js';
import { commandHelp, topHelp, usageError } from './help.js';
import { cliEntry, out, table, UsageError } from './util.js';

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  const tail = argv.slice(1);
  // Help never starts a broker or reads the home directory. Arguments after send's and the launchers' own flags
  // belong to those commands, so only a leading --help counts there.
  const wantsHelp = (flag: string) => flag === '--help' || flag === '-h';
  if (
    cmd &&
    cmd !== 'help' &&
    (cmd === 'send' || cmd === 'claude' || cmd === 'codex' ? wantsHelp(sub ?? '') : tail.some(wantsHelp))
  )
    return out(commandHelp(cmd));
  const noHome = cmd === undefined || ['--help', '-h', 'help', '--version'].includes(cmd);
  // An explicit rehearsal hook does no home discovery; lifecycle hooks must stay fail-open even with a typo.
  if (cmd === 'hook' && process.env.WIGWAG_REHEARSAL === '1') return;
  if (
    !noHome &&
    cmd !== 'hook' &&
    process.env.WIGWAG_REHEARSAL === '1' &&
    (!process.env.WIGWAG_HOME || !isAbsolute(process.env.WIGWAG_HOME))
  )
    throw new UsageError('Rehearsal requires an explicit absolute WIGWAG_HOME');
  if (!noHome && cmd !== 'hook') {
    const home = resolveHome(),
      mode = homeRehearsalMode(home);
    if (cmd === 'rehearsal' && sub === 'clear' && rest.length === 0) {
      if (!process.env.WIGWAG_HOME || !isAbsolute(process.env.WIGWAG_HOME))
        throw new UsageError('wigwag rehearsal clear requires an explicit absolute WIGWAG_HOME');
      const removed = await clearRehearsal(home);
      out(
        removed
          ? 'Rehearsal marker removed. Normal starts may contact native integrations and apply retained answers. Disable rehearsal.enabled/unset WIGWAG_REHEARSAL before normal use.'
          : 'No rehearsal marker; nothing removed.',
      );
      return;
    }
    assertRehearsalAccess(home, mode);
    if (mode.enabled) {
      if (!process.env.WIGWAG_HOME || !isAbsolute(process.env.WIGWAG_HOME))
        throw new UsageError('Rehearsal requires an explicit absolute WIGWAG_HOME');
      assertRehearsalHome(home);
      assertRehearsalStorage(home);
      if (['claude', 'codex', 'install', 'uninstall', 'update', 'mcp'].includes(cmd ?? ''))
        assertNativeAllowed(home, cmd as string);
    }
  }
  // Native hooks fail open without even process discovery in rehearsal; owners inspect the copy via owner RPCs.
  if (cmd === 'hook' && homeRehearsalMode(resolveHome()).enabled) return;
  switch (cmd) {
    case undefined:
    case '--help':
    case '-h':
      return out(topHelp());
    case 'help':
      return out(sub === undefined ? topHelp() : commandHelp(sub === '--help' || sub === '-h' ? 'help' : sub));
    case '--version':
      return out(VERSION);
    case 'update': {
      const { values } = parseArgs({
        args: tail,
        options: { apply: { type: 'boolean' }, check: { type: 'boolean' }, json: { type: 'boolean' } },
      });
      if (values.apply && values.check) throw new UsageError('--apply and --check are exclusive');
      const root = packageRoot();
      const status = await checkUpdate();
      if (values.apply) {
        if (status.reason) throw new UsageError(status.reason);
        await applyUpdate(root, status);
        if (status.update_available) {
          out(
            'Wigwag updated. Existing agents keep running. Claude: /reload-plugins; Codex: restart and trust changed hooks.',
          );
          return;
        }
      }
      return out(values.json ? JSON.stringify(status) : describeUpdate(status));
    }
    case 'install':
    case 'uninstall': {
      const { values } = parseArgs({
        args: tail,
        options: {
          'claude-only': { type: 'boolean' },
          'codex-only': { type: 'boolean' },
          'codex-binary': { type: 'string' },
        },
      });
      if (values['claude-only'] && values['codex-only'])
        throw new UsageError('--claude-only and --codex-only are exclusive');
      const which = { claude: !values['codex-only'], codex: !values['claude-only'] };
      const steps =
        cmd === 'install' ? await install({ ...which, codexBinary: values['codex-binary'] }) : uninstall(which);
      out(
        table([
          ['STATUS', 'TARGET', 'STEP', 'DETAIL'],
          ...steps.map((s) => [s.ok ? 'PASS' : 'FAIL', s.target, s.action, s.detail]),
        ]),
      );
      if (cmd === 'install') {
        out(`\nStart Claude with push delivery:  wigwag claude --as <name>   (runs: ${CLAUDE_LAUNCH})`);
        out('Start Codex:                      wigwag codex --as <name>');
        out('Check:                            wigwag doctor');
      } else out('\nPlugins removed; data kept in the wigwag home directory.');
      process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
      return;
    }
    case 'init':
      return cmdInit(tail);
    case 'doctor':
      return cmdDoctor(tail);
    case 'broker':
      return cmdBroker(sub, rest);
    case 'who':
      return cmdWho();
    case 'send':
      return cmdSend(tail);
    case 'tail':
      return cmdTail(tail);
    case 'show':
      return cmdShow(tail);
    case 'kv':
      return cmdKv(tail);
    case 'streams':
      return cmdStreams(tail);
    case 'deliveries':
      return cmdDeliveries(tail);
    case 'release-throttle':
      return cmdReleaseThrottle(tail);
    case 'link':
      return cmdLink(tail);
    case 'unlink':
      return cmdUnlink(tail);
    case 'links':
      return cmdLinks(tail);
    case 'questions':
      return cmdQuestions(tail);
    case 'recovery':
      return cmdRecovery(tail);
    case 'tui':
      return runTui();
    case 'claude':
    case 'codex':
      return cmdLaunch(cmd, tail);
    case 'mcp': {
      const i = argv.indexOf('--agent');
      const agent = argv[i + 1];
      if (i < 0 || (agent !== 'claude' && agent !== 'codex')) throw usageError('mcp');
      return runMcp(agent, cliEntry());
    }
    case 'hook': {
      if ((sub === 'claude' || sub === 'codex') && (rest[0] === 'QuestionReady' || rest[0] === 'PreToolUse'))
        return runQuestionHook(sub, rest[0]);
      const event = rest[0] as ClaudeHookEvent;
      if (sub === 'claude' && ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event))
        return runClaudeHook(event);
      return; // hooks must never break a session
    }
    default:
      throw new UsageError(`unknown command: ${cmd}\n\n${topHelp()}`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof UsageError) {
    process.stderr.write(terminalText(`${e.message}\n`));
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    terminalText(
      `wigwag: ${e instanceof WigwagError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)}\n`,
    ),
  );
  process.exitCode = 1;
});
