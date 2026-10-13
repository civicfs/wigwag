# Native questions routed through an orchestrator

Status: proposed design for user review. Target release: 0.2.0.

## Intended behavior

A worker continues using its native question tool. Wigwag sends the question to
the agent orchestrating that worker's task. The orchestrator answers from the
context it has and decides whether to ask the human through its own native
question tool. Its answer returns to the worker's original question.

Support Claude workers with Codex orchestrators and Codex workers with Claude
orchestrators. An orchestrator with no supervisor asks the human normally.
Question forwarding alone does not satisfy the feature: the worker must receive
the answer and continue, without copying text between terminals.

The user requested orchestrator-first handling. Explicit delegation, one active
assignment per worker, and version 0.2.0 are proposed implementation choices.

## Establishing the orchestrator

Add a Wigwag `delegate` tool taking a worker name, task subject, task body, and
idempotency key. Require both sessions to be live and natively bound when the
assignment is created. The broker derives the orchestrator from the bound calling connection;
the caller does not supply a `from` identity. The operation durably records the
assignment and its task message before attempting delivery.

Resolve names to the actual worker and orchestrator session IDs. Store both
session IDs, their native session bindings, the assignment ID, and the task
message ID. A reused display name must not inherit another session's assignment.
Expose the assignment in `whoami` and owner inspection.

One worker has one active assignment. Repeating the same assignment operation
with its idempotency key returns the existing assignment. Another assignment
conflicts until the current orchestrator or owner explicitly releases or
reassigns it. Reject self-delegation and cycles. Enforce existing workspace
scope rules when assigning, capturing questions, and delivering answers.

Ordinary `send`, `request`, and `reply` messages never create or replace an
assignment. Automatic inference from the last sender, process ancestry, or
the wording of a message is excluded. This keeps the relationship unambiguous
even when reviewers and other peers message the worker.

## Question and answer flow

Capture native question input with its native session, turn, and tool-call
identifiers. Only an actively assigned worker is intercepted. Preserve question
text, choices, descriptions, free-text answers, and Claude multi-select answers.
Give each captured question batch a durable relay ID, uniquely bound to its
assignment and native invocation. Repeated hook events must reuse that ID.

Send a structured Wigwag request to the recorded orchestrator, identifying the
worker, assignment, and original native questions. Provide a `question_answer`
tool that accepts the relay ID and validated answers. Only the assigned
orchestrator can answer. It may gather a human answer before calling this tool.
The broker does not independently escalate to the human because an orchestrator
is slow or unavailable.

Validate complete answer coverage, choice labels, and free-text/multi-select
rules before committing an answer. Reject unknown questions, invalid payloads,
stale assignments, duplicate answers, and answers to cancelled invocations.
Include peer provenance in model-visible answers and audit records.

## Native integrations

Claude: a `PreToolUse` hook matching only `AskUserQuestion` captures the questions
and waits for the relay answer. Return `permissionDecision: allow` with the
original questions and the supplied `answers` in `updatedInput`. The existing
short lifecycle hooks retain their separate deadline. Give the question hook a
bounded wait below its host timeout. On expiry, deny that invocation with a
clear pending-relay status and instructions to wait through Wigwag, without
creating a duplicate question or requesting a worker-side human answer.

Codex: attach a dedicated client to the existing shared app server for explicitly
assigned, bound worker threads. Observe native `request_user_input` and
`request_user_input_async` invocations and correlate their call IDs with
`item/tool/requestUserInput` requests. Return the structured answer on the
matching server request. Never answer other requests received on that connection.
Watch `serverRequest/resolved` and turn termination to stop stale responses.

Before retaining product integration code, prove in an isolated terminal session
that a second app-server client can observe and answer the existing terminal's
native question, dismiss its UI, and preserve its running turn. Prove both Codex
question variants. If that mechanism does not work, report the exact limitation
and revise this design; do not substitute a pushed chat message and call it a
successful native answer.

## Waiting, failures, and recovery

Persist assignments, question payloads, answer payloads, invocation bindings,
and delivery state. Broker restart must not duplicate a question or apply an
answer twice. Reconcile Codex server requests after reconnect; do not replay an
answer into a new turn or a reused session name. Claude hooks reconnect within
their bounded wait and recover the same relay ID.

An offline or busy orchestrator leaves the question pending. The orchestrator
must be able to receive questions while coordinating work: verify delivery at
supported turn boundaries, including a lead waiting for the worker's result.
Do not introduce an indefinite blocking await in the lead that prevents its
question request from being processed. Expose pending and failed relay status.

For supervised workers, known timeout and transport failures must return a clear
pending/error result rather than silently falling through to a human question.
Host hook rejection, missing trust, and unsupported runtime behavior are explicit
activation failures: verify integration readiness before enabling supervision.
Unsupervised sessions retain their normal native question behavior.

Hook timeouts place a limit on keeping Claude's original invocation open. The
normal completion path must finish that original invocation. The documented
timeout path instead ends it with pending status and resumes through Wigwag;
release evidence must distinguish these paths and include the effective wait
budget. Do not claim indefinite native waiting.

Clarification answers remain attributed to the orchestrator. Shell, filesystem,
network, connector approvals, and Claude `ExitPlanMode` are outside this relay.
Peer answers do not become owner authorization for gated actions.

## Verification and release acceptance

- Regression tests cover caller-derived assignment, idempotency, reassignment,
  cycles, workspace scope, name reuse, and visibility.
- Protocol and adapter tests cover full answer validation, native call matching,
  sync/async Codex questions, Claude multi-select, duplicate events, cancellation,
  timeout, concurrent human resolution, and broker restart.
- Isolated live sessions prove Claude lead -> Codex worker and Codex lead ->
  Claude worker: native ask, pushed relay, orchestrator answer, native completion,
  and worker continuation. Tests use diagnostic agents only.
- A live escalation proves that the lead's own native question reaches the
  human and its answer completes the worker's original question.
- Live evidence includes question IDs, assignments, answers, final native state,
  and runtime versions. Mock-only tests cannot satisfy these release checks.
- Run the full existing test suite, typecheck, formatting checks, build, manifest
  consistency checks, and package-content verification after changes.
- Bump package, lockfile root metadata, and both plugin/marketplace versions
  together to 0.2.0. Document setup, supervision, waiting behavior, and tested
  runtime requirements. Preserve the earlier startup and `who` fixes.
- Prepare and verify the release artifact locally. Publication is a separate
  release action; this design's acceptance is an implemented, tested candidate.

## Integration evidence

Claude's documented answer injection:
https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction

Codex native question request/response interface:
https://learn.chatgpt.com/docs/app-server#toolrequestuserinput

Inspected locally: Claude Code 2.1.296, Codex CLI 0.162.1, and the installed
Codex experimental protocol schemas. Cross-client native completion has not yet
been live-verified. This file records a design, not implementation success.
