#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|id_rsa|id_ed25519|\.DS_Store|node_modules(?:\.shared)?|dist|coverage|\.superpowers|\.wigwag|\.claude|\.codex)(?:\/|$)|\.(?:db(?:-[^/]*)?|sqlite3?(?:-[^/]*)?|pem|key|tgz|log)$/;
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential pattern', /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/],
  ['personal home path', /\/(?:Users|home)\/(?!(?:x|m|dev|test|user|example)(?:\/|\b))[A-Za-z0-9._-]+\//],
];
const findings = [];
for (const path of files) {
  if ((forbidden.test(path) && path !== '.env.example') || path.startsWith('docs/superpowers/plans/'))
    findings.push(`${path}: private/generated file`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { findings.push(`${path}: tracked file unavailable`); continue; }
  for (const [name, rule] of rules) if (rule.test(text)) findings.push(`${path}: ${name}`);
}
if (process.argv.includes('--history')) {
  const commits = execFileSync('git', ['rev-list', '--objects', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  for (const object of commits) {
    const space = object.indexOf(' ');
    if (space < 0) continue;
    const oid = object.slice(0, space), path = object.slice(space + 1);
    if (execFileSync('git', ['cat-file', '-t', oid], { encoding: 'utf8' }).trim() !== 'blob') continue;
    if ((forbidden.test(path) && path !== '.env.example') || /^docs\/(?:superpowers\/)?plans\//.test(path)) findings.push(`${path}: private/generated file in branch history`);
    const text = execFileSync('git', ['cat-file', 'blob', oid], { encoding: 'utf8', maxBuffer: 16777216 });
    for (const [name, rule] of rules) if (rule.test(text)) findings.push(`${path}: ${name} in branch history`);
  }
}
if (findings.length) {
  process.stderr.write(`${findings.join('\n')}\n`); // Never print matching secret values.
  process.exitCode = 1;
} else process.stdout.write(`Public-file check passed (${files.length} tracked files). Pattern checks are not a guarantee that no secrets exist.\n`);
