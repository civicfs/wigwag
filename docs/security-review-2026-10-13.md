# Local security review — October 13, 2026

This is a focused source review with isolated regression tests and npm dependency
audits, not an independent penetration-test certification. It covers the local
broker, message/data handlers, CLI/TUI display, native question relay, npm update
path, and public repository/package contents for the 0.2.0 release candidate.

## Storage and trust boundary

**Messages are stored in clear text in an unencrypted SQLite file, `state.db`,
under the configured Wigwag home directory (`~/.wigwag` by default).** Subjects,
bodies, requests/responses, native questions/answers, and shared state can be read
by anyone with sufficient filesystem access. SQLite WAL/sidecar files, blobs,
logs, and backups may also contain unencrypted content. Wigwag does not provide
encryption at rest. File permissions and host disk encryption are different
controls; neither isolates Wigwag from another process already running as your
OS user. See [the privacy notice](../PRIVACY.md#storage-and-recipients).

The broker uses a local Unix socket with mode `0600` and a home directory with
mode `0700`. Workspace scopes reduce accidental sharing between cooperating
agents. They are not a security sandbox against a process that can read the home
directory or invoke the owner CLI. The `owner` label is not proof of human approval.
Delivered content can enter an inference provider's context and retention systems.

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| Medium | Peer-controlled content could include terminal commands, allowing display spoofing or clipboard changes in terminals supporting OSC52. | CLI output/errors and TUI text escape control characters and directional overrides before rendering. Raw stored message content stays intact; Ink adds its own trusted styling afterward. Layout counts the escaped text. |
| Medium | File uploads and owner attachments checked path size before an unrestricted synchronous read. Devices can report size zero; pipes can block the broker. | A shared reader opens nonblocking, checks the opened descriptor is a regular file, enforces the byte bound while reading, rejects size changes, and closes the descriptor on success or failure. Symlinks to regular files remain supported. |

Relevant implementation: `src/terminal.ts`, `src/tui/Text.tsx`, `src/tui/layout.ts`,
`src/cli/util.ts`, `src/cli/main.ts`, `src/files.ts`, and the data/owner handlers.

Regression coverage includes terminal-command escaping in CLI and TUI output;
regular, empty, symlinked, oversized, and nonregular upload sources; a source that
grows while read; descriptor closure after rejection; both broker upload entry
points; and existing display-width, scrolling, scope, and delivery behavior.
Exploit checks used synthetic content and isolated fixtures. No payload was sent
to an existing agent or the owner's terminal, and no working session was stopped
for the review.

## Other reviewed protections

- Scope checks apply to message/data reads, subscriptions, and attachment access.
  SQL values use parameters; identifiers with dynamic structure come from fixed
  code or validated inputs.
- Native question answers are checked against the assignment, recorded agent
  identities, workspace scope, native question/turn, cancellation, and existing
  human answers. Their provenance does not grant human approval.
- Updates use a fixed HTTPS npm metadata endpoint and a validated stable version.
  Installation uses argument arrays, an exact version, and `--ignore-scripts`.
  Development checkout symlinks are rejected; the replacement broker version is
  checked. Trust in npm/package maintainers and the configured install registry
  remains necessary. Real npm upgrade installation is unverified while the
  package is unpublished.
- The public-tree/history scanner checks known sensitive paths and credential
  patterns. It supplements manual review and cannot guarantee secret detection.
  The README screenshot uses illustrative data from the real renderer.

## Dependency audit

`npm audit --omit=dev --json` reported **zero runtime vulnerabilities** at review
time. The complete `npm audit --json` reported **one low-severity development
finding**, [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr),
for esbuild 0.27.7. The audit describes a Windows development-server file-read
issue. Wigwag uses esbuild through its build/test tooling, does not start that
server, and does not ship it as a runtime dependency. The finding remains open;
resolving it requires moving the build tooling to a patched compatible esbuild
version. Re-run both audits before publication because advisory results change.

## Verification and limits

Run:

```sh
npm run typecheck
npm test
npm audit --omit=dev
npm audit
npm run check:public -- --history
```

Local verification after these fixes: **69 test files / 569 tests passed**,
type checking passed, and the public-file/history check passed for **181 tracked
files**. The npm package preview contained 23 intended files, with no runtime
state or diagnostic logs.

The full audit exits nonzero for the remaining development advisory. The review
found no additional must-fix defect in the inspected authentication/scope,
native-relay, or update paths under the same-user threat model. This is not proof
that those paths contain no vulnerabilities. Linux/Windows end-to-end behavior,
host/backup encryption, provider-side handling, malicious filesystem drivers,
and account/registry compromise were not tested. Regular-file reads are bounded
in bytes; a slow or malfunctioning filesystem can still delay synchronous I/O.
