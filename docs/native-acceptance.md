# Real native upgrade acceptance

`scripts/native-acceptance.mjs` runs genuine interactive Claude Code and Codex
processes in a private tmux server. It is an opt-in local acceptance check and can
make paid model calls. Unit tests and hosted CI do not establish this coverage.

The runner stages a separate installation, Wigwag home, provider homes and empty
workspace. It never edits the user's provider configuration, copies credentials,
injects internal hook calls, manually binds sessions, or accepts general command
permissions. It uses the normal Wigwag launchers and provider plugin installers.

## Prepare and authenticate

Use Node 24+, tmux, authenticated provider CLIs, and an already built candidate.
Build the historical baseline separately from its exact source commit, using its
own build record. Both package roots must contain executable `dist` output and
the provider plugin/marketplace files. Dependencies must be available beside the
package if its bundle needs them.

```sh
node scripts/native-acceptance.mjs prepare \
  --root /tmp/wwn-my-check \
  --baseline /path/to/historical/package \
  --baseline-commit FULL_40_CHARACTER_COMMIT
```

`--candidate` defaults to this checkout. `--claude-bin` and `--codex-bin` can select
installed native CLI executables. Omitting the baseline tests replacement of the
same package; its evidence explicitly distinguishes that from an upgrade.

Prepare creates a **fresh** root and prints its private `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, and `WIGWAG_HOME`. Authenticate these provider homes with the
account's supported workflow before running acceptance. The runner can inherit
`CLAUDE_CODE_OAUTH_TOKEN` or another provider-supported authentication environment.
It does not extract credentials from the OS store, print them, or copy an account
home. Native onboarding or login that remains incomplete blocks the run. Complete
unrelated onboarding in these private homes separately.

The installed path stays constant across the upgrade. Running old MCP processes
keep their loaded package while files at that path are replaced with the candidate.
The runner stages an exact new tree, moves the previous tree into private history,
swaps the new tree into the same path and verifies its actual file fingerprint.
It refreshes the package dependency link and restores the previous tree if the swap
fails. No recursive deletion is used.
Every staged code and manifest file is hashed, including `dist/cli.js`; source
head, dirty status, provider versions, selected models and timestamps are recorded.
`--baseline-commit` verifies the baseline's source/manifests against the specified
Git object. Recorded bundle hashes do not by themselves prove how a bundle was built.

## Run

```sh
node scripts/native-acceptance.mjs run \
  --root /tmp/wwn-my-check \
  --run-native \
  --claude-model sonnet \
  --codex-model YOUR_SMALL_CODEX_MODEL \
  --trust-disposable
```

Without `--run-native`, no providers launch. Models must be supplied explicitly.
`--timeout-ms` bounds each observation (default 120000); `--low-observe-ms` defaults
to 30000 and cannot be lower than 15000.

`--trust-disposable` authorizes only narrowly recognized native UI transitions in
this run: trust its exact workspace, accept the exact Wigwag development channel,
trust the expected Wigwag hook count in an otherwise empty Codex home, and grant
session permission for the public synthetic-message Wigwag tools. It never uses
`--dangerously-bypass-hook-trust`. Unknown prompts remain blocked. Without that
flag an operator can attach to the private tmux server and handle the UI:

```sh
tmux -L SOCKET_FROM_MANIFEST attach -t acceptance
```

The trust recognizers are based on observed Claude 2.1.308 and Codex 0.163.0 UIs.
Native versions can change prompts; a timeout on a changed prompt is a blocked
acceptance result, not permission to accept a broader dialog. Private pane logs
retain bounded, redacted text. Authentication screens are withheld.

The prepared private Codex configuration sets `[plugins._default] enabled=false`,
disables `remote_plugin`, and enables `hooks`; the native installer explicitly enables
Wigwag. The default plugin policy prevents account-synced remote hooks from entering
the disposable runtime. `remote_plugin=false` and a CLI inventory alone are insufficient.
The policy and the native installed-plugin inventory must both pass before the runner
accepts bulk hook trust. Only the private configuration changes.

UI actions wait for a stable recognized prompt and inspect the selected option. They
verify the intended option is selected before Enter, space arrow keys apart, and retry
at most three times. Evidence records the public tool and attempt count. Sending keys
alone does not count as accepting trust: the native prompt must acknowledge the action.
Prompt and slash-command dispatch waits 250 ms for native input rendering before
Enter. Codex gets one further Enter only when its current pending input still
exactly matches the submitted text, including wrapped prompts.

## What constitutes evidence

The runner requires one live session under each expected name, `bound: true`, a
connected MCP link, and verified native Codex hook/push capability. It sends a
unique synthetic token and accepts delivery only when a model-generated Wigwag
reply comes from the expected provider, references the exact original message ID,
and contains the requested token. `pushed` and `read` receipts alone never pass.

It checks low-priority mail remains held without waking either idle provider,
retains the original messages across replacement, replaces the broker while both
providers are idle and again while both are busy, and checks that the original
MCP process IDs/start identities survived. Genuine later turn/tool hooks must
restore the observed idle/bound state. No prompt asks the model to call an
internal binding or hook tool.

The busy interval uses a prepared workspace Node helper with a unique provider/run
tag. Both exact helper processes and both busy sessions must be visible before
the driver sends challenges or replaces the broker. The same processes must remain
alive after replacement; only then does the driver create its own release file.
The fixture checks for its release file every 200 ms and times out after 60 seconds.
Claude receives permission only for its exact tagged fixture command.

It then runs the genuine provider installation and explicit Claude plugin-update
steps, verifies the installed plugin version, sends Claude `/reload-plugins`, and
observes its native reload response. Reload can retain the existing MCP process when
its command is unchanged. If the per-session public `client.version` still differs
from the candidate, the runner exits only its own Claude session and relaunches it
with native `--continue`. The running client version, current client mode, binding,
capabilities and a correlated reply must then pass. Broker version warnings are
historical observations and cannot substitute for the per-connection client stamp.
The harness uses compatible versionless owner probes to inspect both broker
generations; these probes can themselves add a historical legacy-client warning.

The runner quits and restarts Codex. It restores a snapshot of this run's pre-trust private configuration
after the old native session/daemon stop; snapshots containing possible credential
fields are refused. It selects the real native **Continue without trusting** option,
observes a connected unbound MCP session and the model's unbound report, opens
`/hooks`, and trusts the reviewed native hooks UI. A genuine subsequent prompt must
bind the same MCP session and produce a correlated reply. No internal binding or
hook tool is manually invoked. Persisted trust alone is not fresh UI evidence.

An initial hook failure caused by an **incompatible old broker** is a separate
scenario. This runner does not execute that fault and records it as **blocked** in
`out_of_scope`; the untrusted-hook recovery pass does not establish it. Run the
incompatible-broker fault with the companion runner below and add its exact evidence to release
acceptance. This runner also does not establish npm
publication, global installs, interrupted installer recovery, Linux PID binding,
or every row in [the E2E checklist](e2e-checklist.md).

`ROOT/evidence.json` records each scenario as `pass`, `fail`, or `blocked`.
Exit codes are 0, 1 and 2 respectively. Any untested required gate keeps the
overall core result blocked. Out-of-scope gates are listed separately. A failure to reach native readiness is never reported as
a passed delivery check. Keep the evidence private; it is not a CI upload artifact.

## Cleanup

The default run closes its own tmux server, private broker and private Codex
daemon. `--keep-sessions` leaves them for inspection. Afterwards:

```sh
node scripts/native-acceptance.mjs cleanup --root /tmp/wwn-my-check
```

Cleanup uses the prepared ownership marker and private runtime paths. It does not
enumerate or stop the user's live provider sessions, default broker or tmux server.
It preserves the run directory, synthetic transcripts and evidence for review.
It checks the captured owned process IDs and start identities, private sockets and
own tmux session disappear within a bounded wait; surviving resources fail cleanup.
Provider installation commands retain their supervising CLI until the installer
actually exits rather than terminating its parent on an arbitrary timeout.

## Incompatible-broker native recovery

The companion runner pins a genuine 0.3.0 broker and a 0.3.5 MCP in another fresh
private home. Run it separately from the combined acceptance runner:

```sh
npm run test:native:skew -- prepare \
  --root /tmp/wws-my-check \
  --baseline /path/to/historical/package
# Authenticate the printed private CODEX_HOME before continuing.
npm run test:native:skew -- run \
  --root /tmp/wws-my-check \
  --run-native \
  --codex-model YOUR_CODEX_MODEL \
  --trust-disposable
```

It requires paired native schema errors before the first model tool call, observes
the trusted Wigwag SessionStart hook through the native UI, replaces the broker,
and verifies the same MCP process reconnects to an unbound session. A later genuine
user-turn hook must bind that same session; a correlated model reply and owned
cleanup must pass. Codex 0.163.0 does not expose event names for these initial
failure notifications, so SessionStart attribution is explicitly an inference
from the paired failures and trusted hook configuration. The unbound checkpoint
and subsequent same-session recovery are observed directly.

Results are private at `ROOT/skew-evidence.json`, with the same pass/fail/blocked
exit codes. The combined runner and this companion must both pass for the native
upgrade acceptance covered here. Their evidence records hashes of the tested
package and loaded harness sources. Re-run after changes to those sources.
