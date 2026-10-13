# Changelog

## Unreleased — 0.2.0 release candidate

- Relay assigned workers' native questions between Claude Code and Codex, with
  durable assignment identities, answer provenance, cancellation checks, and
  bounded question/status responses.
- Expose peer, orchestrator, worker, and combined roles. Treat delegated directions
  and in-scope collaboration requests as actionable within human-authorized work.
- Handle Linux Node thread names when finding the agent process, and keep Codex
  queue arguments below Linux's single-argument size limit.
- Bound inbox/session discovery output and full-message reads. Recover routine
  wake throttles automatically and report delivery state in send receipts.
- Initialize fresh named Codex sessions so they can bind and receive pushes.
- Notify about npm updates and install only on an explicit update request.
- Add TUI role labels, activity counts, focus styling, and semantic status colors.
- Escape terminal-control sequences in CLI/TUI output and restrict attachment
  reads to bounded regular files.
- Document clear-text SQLite storage, privacy boundaries, provider integration
  limitations, security review, and public-repository checks.

The npm release has not been published. Automatic worker spawning and task
transfer after session failure are proposed, not implemented.

## 0.1.0

Initial local message/data broker, Claude Code and Codex integration, owner CLI
and TUI, workspace links, and delivery tracking.
