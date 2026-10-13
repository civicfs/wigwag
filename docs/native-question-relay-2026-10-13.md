# Wigwag 0.2.0 verification — 2026-10-13

Tested with Codex CLI/app-server 0.162.1 and Claude Code 2.1.296, using isolated
diagnostic agents, a disposable workspace, and a separate Wigwag broker.

## Results

- Full suite after autonomy, update and public-file follow-ups: 67 files, 560 tests passed.
- TypeScript check, build, formatting check and package-content checks passed.
- Fresh code review found no remaining material issues after its findings were fixed.
- Actual Claude lead → Codex worker: task delegation, pushed native question,
  orchestrator answer, native completion, and worker continuation passed.
- Actual Codex lead → Claude worker: the same native round trip passed.
- Codex async questions passed with both an active and a yielded worker.
- Automated regression tests cover stable identities, name reuse, readiness,
  scope, cycles after asynchronous preflight, idempotency, answer validation,
  cancellation, human-first recovery, bounded responses and throttled leads.

Native question relays carry questions, choices, routing IDs, and answers with
peer provenance. They do not forward transcripts or replay task bodies.
Recovery reads the assigned Codex thread internally without exposing that history
to the orchestrator. Native permission approvals remain outside the relay.

The local broker upgrade preserved every previously live agent binding. Local
plugin installation and doctor checks passed. Existing agents keep their loaded
MCP tool definitions until reload or restart; changed Codex hooks require trust.

## Verification boundaries

- Real-person escalation through the lead's native asker was not manually exercised.
- Not every recovery/race scenario was repeated with two live LLMs; those cases
  have automated regression coverage.
- Terminal titles are suggested metadata, not automatic window renaming.
- Claude applied state records handoff to the hook; process death before native
  stdout consumption remains an ambiguous boundary.
- Ambiguous Codex async acknowledgement is reported as failed instead of blindly
  submitting a possibly duplicate answer.
- The release artifact was prepared locally, not published.

Operational logs, session identifiers, local paths and detailed diagnostic records
are intentionally excluded from the public repository.

## Update and repository checks

The npm updater notifies first and installs only on an explicit request. Controlled
runner tests cover exact-version installation, single-provider scope, custom
Codex binaries, install failures, linked-development-install refusal, and verified
broker replacement. The live registry check reported no published npm release;
a real registry upgrade was therefore not performed.

The public tracked tree and package were checked for private/generated files and
common credential patterns. A local history audit scanned 649 blobs without a
credential-pattern match. Internal execution plans remain local and ignored;
operational details were removed from the unpublished implementation commit.
These checks supplement review and do not guarantee detection of every secret.

Recovery/transfer is a proposed next layer, documented separately; it is not an
implemented feature in this release.
