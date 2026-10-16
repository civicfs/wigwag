# Changelog

## Unreleased

- Hold Codex queue pushes unless metadata proves a single loaded root with no
  loaded descendant sharing its ID. Recheck before queueing; show the hold reason
  in session, capability, TUI and recovery diagnostics. Hooks/inbox remain usable.
- Upgrade to schema v4 with a mode-0600 `state.db.pre-v4.bak` snapshot, preserving
  deliveries and adding `codex-untrusted` holds. The v3 backup safeguards also apply
  to v4: refuse pre-existing backups and remove only this attempt's redundant copy
  after a confirmed rollback.

- Adopt native session names (Claude `/rename`, Codex thread names), sanitized and
  suffixed on collision; an explicit `register` wins and `register native=true`
  reverts. Codex's index can supply the first native name; later updates require
  an authoritative app-server answer.
- Forward undelivered mail and the session's own active subscriptions and mutes
  on every rename; notify live sessions in scope and owners. Deferred forwarding
  stops if another session claims the old name.
- Reclaim eligible slots through Claude hook binds, preserving explicit names and
  same-parent polling questions. Codex automatic recovery is unavailable in 0.3.0
  until a trusted concrete thread ID exists; root metadata alone is insufficient.
- Exclude empty provisional/refused shells from recovery candidates, including
  after flag resolution. Report duplicate slot details and require force to
  retire slots with active assignments or undelivered mail. Resolve related flags
  on adoption/retirement while retaining lineage history.
- Replace an older connected Claude MCP only when its own process is verified
  gone, preventing two live MCP servers from taking the slot back and forth.
- Keep a session, its name and assignments while its parent remains open after an
  MCP disconnect or broker restart. Hold Claude pushes for the next hook and
  recheck after two seconds, then every ten seconds. Mark offline when the parent
  is confirmed gone or unverifiable past its grace period. macOS identities use
  UTC start time plus uid with one-second resolution.
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
