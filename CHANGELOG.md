# Changelog

## Unreleased

- Before upgrading an existing database to schema v3, save a mode-0600 clear-text
  copy at `state.db.pre-v3.bak`. Keep it after success or an uncertain outcome.
  A confirmed rollback removes only the backup created by that attempt so retry
  can proceed. A pre-existing backup is retained and blocks migration pending
  operator inspection.

## 0.2.0 — 2026-10-13

- Relay assigned workers' native questions between Claude Code and Codex, with
  durable assignment identities, answer provenance, cancellation checks, and
  bounded question/status responses.
- Expose peer, orchestrator, worker, and combined roles. Treat delegated directions
  and in-scope collaboration requests as actionable within human-authorized work.
- Handle Linux Node thread names when finding the agent process, and keep Codex
  queue arguments below Linux's single-argument size limit.
- Bound inbox/session discovery output and full-message reads. Recover routine
  wake throttles automatically and report delivery state in send receipts.
- Add byte-bounded KV-list and stream-record pages with continuation metadata,
  lossless blob references for oversized entries, and KV paging controls in the
  CLI and TUI.
- Initialize fresh named Codex sessions so they can bind and receive pushes.
- Notify about npm updates and install only on an explicit update request.
- Add TUI role labels, activity counts, focus styling, and semantic status colors.
- Escape terminal-control sequences in CLI/TUI output and restrict attachment
  reads to bounded regular files.
- Document clear-text SQLite storage, privacy boundaries, provider integration
  limitations, security review, and public-repository checks.

Automatic worker spawning and task transfer after session failure are proposed,
not implemented. GitHub source releases and npm packages are published separately.

## 0.1.0

Initial local message/data broker, Claude Code and Codex integration, owner CLI
and TUI, workspace links, and delivery tracking.
