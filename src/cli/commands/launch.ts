import { spawn } from 'node:child_process';
import { loadConfig, resolveHome } from '../../config.js';
import { NAME_RE, RESERVED_NAMES } from '../../ids.js';
import { ownerConnect, UsageError } from '../util.js';

/** Runs the agent in THIS terminal (not session spawning, spec §16). Adds the channel flag for Claude. */
export async function cmdLaunch(agent: 'claude' | 'codex', args: string[]): Promise<void> {
  let name: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--as') {
      name = args[++i];
      if (name === undefined) throw new UsageError('--as requires a name');
    } else rest.push(args[i]);
  }
  if (name !== undefined && (!NAME_RE.test(name) || RESERVED_NAMES.has(name))) {
    throw new UsageError(`--as ${name}: names match ^[a-z][a-z0-9-]{1,47}$ and cannot be owner/all/wigwag`);
  }
  const bin = agent === 'claude' ? 'claude' : loadConfig(resolveHome()).codex.binary;
  const argv = agent === 'claude' ? ['--dangerously-load-development-channels', 'plugin:wigwag@wigwag', ...rest] : rest;
  // E-1: a Codex session under the shared app-server daemon gets its MCP server from the daemon, which never sees
  // WIGWAG_NAME. The broker is told the intended name (keyed by this directory) and applies it when the new session
  // binds; the intent lives as long as this connection, i.e. as long as codex runs.
  let intent: { close(): void } | null = null;
  if (agent === 'codex' && name !== undefined) {
    try {
      const { client } = await ownerConnect();
      await client.call('launch.intend', { agent: 'codex', name, cwd: process.cwd() });
      intent = client;
    } catch (e) {
      process.stderr.write(
        `wigwag: could not register the name "${name}" with the broker (${(e as Error).message}); ` +
          'if the session comes up under another name, ask the agent to call the wigwag register tool\n',
      );
    }
  }
  const child = spawn(bin, argv, { stdio: 'inherit', env: { ...process.env, ...(name ? { WIGWAG_NAME: name } : {}) } });
  const ignore = () => {}; // the child owns the terminal and gets Ctrl-C directly
  const forward = () => {
    child.kill('SIGTERM');
  };
  process.on('SIGINT', ignore);
  process.on('SIGTERM', forward);
  const cleanup = () => {
    intent?.close();
    process.off('SIGINT', ignore);
    process.off('SIGTERM', forward);
  };
  return new Promise((resolve, reject) => {
    child.once('error', (e) => {
      cleanup();
      reject(new Error(`cannot start ${bin}: ${e.message}`));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}
