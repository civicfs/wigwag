# Changelog

## 0.3.0 — 2026-10-16

- Add Codex host `codex-mcp-client` 0.163.0 to the built-in verified push list
  (owner-approved; 0.162.1 remains the source-audited version).

- Block rehearsal symlink/parent-component escapes and hard-linked storage.
  Use validated canonical paths for I/O, guard opened leaves before truncation,
  recheck database/sidecar paths before open, and refuse copies nested in live homes.

- Refuse raw Claude binds that change a native ID or claim another canonical
  slot. Trusted same-workspace hooks detach only positively recorded raw/legacy
  holders, preserving their work on the old offline slot. Protect unstamped
  historical holders and show `binding-origin-unknown` in doctor/recovery.
- Refuse Claude conversation changes reported while the MCP is disconnected;
  reconnect and a later trusted hook split the slots without exposing old mail.
- On V4 upgrade, mark answered Codex sync/async relays as submission unknown and
  applied relays as confirmed. Inspect unknown outcomes with `wigwag questions`
  and explicitly resolve them with `wigwag questions resolve <id> --cancel` or
  `--delivered`; neither operation sends native input or permits automatic retry.

- Refuse rehearsal through case/firmlink or HOME-override aliases by comparing
  account/default-home filesystem identity, including missing leaves. Startup
  rejects every recorded broker.sock entry before probing or migrating.

- Contain all rehearsal storage through one shared inventory, including blobs,
  archive/SQLite sidecars, backups, logs, sockets and managed temporary files.
  Recheck dynamic blob and export paths before I/O; outside exports are refused
  even with the external-native-path override. Hooks remain fail-open without
  writing through escaped log paths.

- Ignore stale reconnect hints for every MCP when the earlier conversation split
  could not record a complete verified process identity; a later successful
  capture cannot expose the previous conversation’s mailbox before a trusted hook.

- Claim native Codex question submissions durably before I/O, preventing duplicate
  async replies across MCP handover and repeat sync/async replies after broker
  restart. Unknown outcomes remain held and visible; the owner can cancel or
  confirm delivery after inspection with `wigwag questions resolve`. Amend
  unshipped V4 with submission_state, preserving migration backups and relay data.

- Require rehearsal-mode broker evidence on owner CLI connections, including
  autospawn and broker control; reject socket symlinks and escaped storage before
  any connection so rehearsal commands cannot reach a normal broker.

- Diagnose malformed protocol/schema stamps separately from valid older/newer
  versions, avoiding misleading restart advice for fractional schema values.

- Add owner-only rehearsal for copied homes, disabling native readers, question
  adapters, watchers, process probes, pushes and updates by construction. Refuse
  live/default homes and escaped paths; external native paths need an explicit
  warning-bearing override that never enables I/O. Write a private sticky marker
  before migration; normal updated clients refuse the marked copy until the
  owner explicitly runs `wigwag rehearsal clear` with its broker stopped.
  Doctor reports rehearsal and skips native executable probes.

- Share one deadline-bounded Codex metadata snapshot per liveness pass, recheck
  the loaded set after reads, and keep Claude process probes independent of
  stalled native I/O. Stop cancels outstanding snapshots and ignores late results.

- Reattach a restarted Codex MCP to one verified disconnected slot after fresh
  loaded-root metadata and current trust/generation checks, retaining its name,
  mail and assignment. General Codex resume recovery remains unavailable.
  Preserve native questions through that handover and revalidate pending request
  replay before answering; unavailable or mismatched evidence submits nothing.
  Protect historical unverified slots with doctor/recovery diagnostics; retained
  work stays on the old slot pending a future explicit owner resolution operation.

- Document the upgrade boundary: never open upgraded v3/v4 state with the 0.2
  CLI/broker, which lacks newer-schema checks. Crash-left migration snapshots
  block another migration until operator inspection/removal; completed-upgrade
  snapshots remain safely retained. A stamped Claude plugin reload can reclaim
  a unique legacy slot with its name, mail, assignments and live relays; still-old
  MCPs remain degraded. Explain unverified-bind push holds and unverified-root
  recovery refusals with the corresponding reload/inspection steps.

- Attach and reserve the native question relay before an assigned Codex queue
  push, then recheck fresh push trust after attachment. Fail closed into a visible
  hold while retaining inbox delivery. Release reservations on failure/shutdown;
  queued turns and questions retain the existing turn and idle-grace lifecycle.

- Warn on every doctor inspection that requires ordinary read-only SQLite access,
  including existing WAL/SHM paths: bookkeeping files may change, database content does not.

- Distinguish overloaded and unreadable Codex metadata from unavailable listings.
  Reuse a fresh engine verdict only within the same push for less than one second,
  with current slot checks on every chunk. Apply Claude liveness before Codex I/O.

- Split Claude slots on an in-process conversation change, preserving the old
  conversation's name, mail, assignments and relays. Recover only the destination's
  unique eligible slot; ambiguous or live-held destinations remain unbound.
  Update the MCP's remembered slot internally and ignore stale switched-away
  hints from the same verified process after a crash, without redirecting them.

- Preserve in-flight rename ownership durably, including already-pushed chunks.
  Reclaiming the old name cannot expose those deliveries; settlement or broker
  restart forwards them to the owning slot's current inbox. Adoption transfers
  durable ownership in the same transaction; counts and reads honor that owner.

- Hide internal Codex hook tools from the model and require host-origin metadata
  matching the bound thread. Only verified host versions enable queue pushes;
  unsupported versions keep messaging with a visible hold and owner-configurable
  verified-version extension. Expose bind origin and observed host name/version.
  Legacy/pre-guard Codex bindings retain messaging but lose push until the Wigwag
  plugin is reloaded or the Codex session restarted. The host metadata contract
  remains subject to live throwaway-session acceptance; recovery stays disabled.
  Amend unshipped V4 with origin/host fields, additional diagnostic reasons and a
  nullable durable forwarding destination for the rename-ownership fix.

- Accept package-version skew with a soft reload warning; only protocol/schema
  incompatibility rejects a handshake. Preserve unstamped 0.2 clients in degraded
  mode, including explicit remembered-slot reconnects across broker restarts.
  Persist and display legacy status; disable identity, recovery/adoption and
  Codex push trust until a valid stamped reconnect or trusted stamped Claude
  hook recovery after plugin reload upgrades that same slot.

- Hold Codex pushes while its MCP link is disconnected, including a disconnect
  during metadata I/O. Reuse disconnected holds, retain throttle precedence and
  release on reattach or hook delivery; fresh loaded-root trust remains required.

- Stop idle Codex assignments from pinning threads: attach on turn-start/question
  demand, retain outstanding questions, then unsubscribe after a configurable
  grace. Never resume unloaded/unknown threads to maintain the relay; show waiting
  demand and await unsubscribe cleanup on broker stop.

- Make doctor read-only: report schema/backup permissions, liveness/identity gaps,
  recovery flags/duplicates, Codex push holds and compatibility without starting
  a broker or migrating local state.

- Reject broker/client protocol and schema incompatibility at hello with restart or
  update/reload advice; surface recent warnings in whoami/doctor. Lifecycle hooks
  fail open; supervised native question hooks preserve their explicit denial.

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
  retains original session ownership if another session claims the old name.
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
