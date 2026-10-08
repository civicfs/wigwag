#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_CODEX_MODE === 'fail-echo') {
  process.stderr.write(`fake-codex: rejected input\n${process.argv.at(-1)}\n`);
  process.exit(3);
}
if (process.env.FAKE_CODEX_MODE === 'fail') {
  process.stderr.write('fake-codex: simulated failure\n');
  process.exit(3);
}
if (process.env.FAKE_CODEX_SLEEP_MS) {
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_SLEEP_MS)));
}
if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
}
