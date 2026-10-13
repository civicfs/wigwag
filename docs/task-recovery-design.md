# Task recovery and transfer (proposed)

Status: design only; not implemented.

A delegated task should outlive an individual agent session. The orchestrator
owns recovery decisions and should resolve routine failures without asking the
human. Human escalation is reserved for essential missing information or a real
approval the orchestrator cannot supply.

## Recovery flow

1. Detect a lost or failed worker. Distinguish an offline process from a closed
   terminal whose daemon thread is still running, and from a slow active turn.
2. Reconnect or resume the original native session first. Preserve its assignment
   identity when it is genuinely the same worker, rather than duplicating work.
3. If it cannot resume, the orchestrator selects an available replacement worker.
   Transfer a compact checkpoint: goal, scope, current step, working branch and
   commit, changed files, verification results, decisions, open questions, and
   any in-flight external operation that needs reconciliation.
4. Atomically advance the task's assignment generation and retire the old worker.
   Old-generation messages, question answers, and completion reports cannot
   become authoritative again if the old session returns.
5. Resume from the checkpoint with bounded attempts and backoff. Repeated failure
   is surfaced to the orchestrator with a specific reason and useful next action.

## Required boundaries

- No automatic full-transcript transfer. Additional history is fetched only when
  explicitly requested and needed.
- Existing user instructions and approval limits travel with the task. A peer
  reply or worker replacement does not manufacture a human approval.
- A broker generation fence controls Wigwag coordination; it cannot by itself
  prevent a stale process from writing directly to a shared checkout. Replacement
  requires confirming the old worker is stopped, or isolating worktrees and
  reconciling changes before accepting new writes.
- Before repeating an external side effect, reconcile whether the previous worker
  already performed it. Use operation identifiers and durable receipts.
- Session creation is currently disabled. Automatic spawning would be a separate,
  explicitly configured capability; reassignment can initially use existing peers.

The first implementation slice should be durable task checkpoints plus explicit
orchestrator-controlled transfer to an existing worker. Automatic detection and
resume can then build on that proven state machine.
