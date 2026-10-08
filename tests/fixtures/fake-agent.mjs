#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const bin = basename(process.argv[1]);
const argv = process.argv.slice(2);
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ bin, argv })}\n`);
const line = argv.join(' ');
if (process.env.FAKE_AGENT_OUTPUT && new RegExp(process.env.FAKE_AGENT_MATCH ?? '').test(line)) {
  process.stderr.write(`${process.env.FAKE_AGENT_OUTPUT}\n`);
  process.exit(1);
}
const already = process.env.FAKE_AGENT_ALREADY === '1';
const isAdd =
  (argv[0] === 'plugin' && ['install', 'add'].includes(argv[1])) || (argv[1] === 'marketplace' && argv[2] === 'add');
if (already && isAdd) {
  process.stderr.write(`${bin}: ${argv[argv.length - 1]} already installed\n`);
  process.exit(1);
}
if (argv[0] === '--version') process.stdout.write('2.1.293 (Claude Code)\n');
