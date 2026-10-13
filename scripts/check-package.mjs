#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

// Enumerate exact intended artifacts. Directory-wide package.json entries must not silently widen the release.
const allowed = new Set([
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  'LICENSE', 'README.md', 'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'package.json', 'install.sh',
  'dist/main.js', 'dist/main.js.map', 'dist/cli.js', 'dist/cli.js.map',
  'docs/provider-terms.md', 'docs/spec.md', 'docs/native-question-relay-2026-10-13.md',
  'docs/public-release.md', 'docs/task-recovery-design.md', 'docs/security-review-2026-10-13.md', 'docs/images/tui-feed.png',
  'plugins/claude/.claude-plugin/plugin.json', 'plugins/claude/.mcp.json',
  'plugins/claude/hooks/hooks.json', 'plugins/claude/README.md',
  'plugins/codex/.codex-plugin/plugin.json', 'plugins/codex/.mcp.json',
]);
const report = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8', maxBuffer: 16777216,
}))[0];
const required = [
  'package.json', 'LICENSE', 'README.md', 'PRIVACY.md', 'SECURITY.md', 'install.sh',
  'dist/main.js', 'dist/cli.js',
  '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
  'plugins/claude/.claude-plugin/plugin.json', 'plugins/claude/.mcp.json', 'plugins/claude/hooks/hooks.json',
  'plugins/codex/.codex-plugin/plugin.json', 'plugins/codex/.mcp.json',
];
const present = new Set(report.files.map((file) => file.path));
const missing = required.filter((path) => !present.has(path));
const unexpected = report.files.filter((file) => !allowed.has(file.path));
if (unexpected.length || missing.length) {
  if (missing.length) process.stderr.write(`Missing required npm package files:\n${missing.join('\n')}\n`);
  if (unexpected.length) process.stderr.write(`Unexpected npm package files:\n${unexpected.map((file) => file.path).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Package inventory check passed (${report.files.length} files). Build and content checks remain required.\n`);
}
