# wigwag end-to-end checklist

Run each row with real Claude Code and Codex sessions on your machine. Each row: exact steps, expected
observation. Record results (one row per check: result, evidence, notes). Rows E1–E8 map to the
spec §1 success criteria.

Conventions: T1 is a tmux window running Codex, T2 one running Claude, T3 the owner shell. Launch every Claude session
with `--model sonnet` (or lower) and record the model shown in the pane. Launch Codex with `-m <smaller model>` only: a
`-c key=value` override makes the Codex TUI run an embedded app-server instead of the shared daemon, which hides E-1.
Install first with `./install.sh`; the first Codex start after install asks to trust the new hooks (`/hooks`, `t`).

Delivery recovery checks: send more than `rate.wake_pushes` diagnostic messages
within one rate window. Verify held receipts show `throttled`, then verify the
cooldown expires and dispatches the backlog without manual release. Repeat across
a broker restart. With a large unread backlog, verify each inbox page stays below
12,000 formatted JSON bytes, only returned messages are read, and repeated pages
recover every original ID. An oversized single message must provide bounded
`read_message` offsets or an explicit `blob_get`-to-file fallback.

| # | Criterion | Steps | Expected |
|---|---|---|---|
| E1 | Claude → idle Codex wakes | T1: `wigwag codex --as e2e-codex`; trust hooks if prompted, then wait for the automatic readiness prompt to complete without typing. Check `wigwag who` shows BOUND `yes` (if the name is not applied, E-1, ask Codex to call the wigwag `register` tool with `e2e-codex`). T2: `wigwag claude --as e2e-claude`; ask it: "use the wigwag send tool to send e2e-codex a normal message with a subject asking it to reply with PONG-E1 via the reply tool" | Codex initializes and then starts a peer-message turn without typing; Claude receives a channel message containing PONG-E1 |
| E2 | Codex → idle Claude wakes | In T1 ask Codex: "send e2e-claude a normal message: reply with PONG-E2"; leave T2 idle | Claude starts a turn on its own (it may ask the owner before replying: answer yes in T2); Codex gets PONG-E2 back |
| E3 | low never wakes | `wigwag send e2e-claude --priority low --subject e3 --body E3-TOKEN`; wait 30 s; then type any prompt in T2 that runs one tool | No turn starts during the 30 s; after the tool call the model can quote E3-TOKEN |
| E4 | CAS race | Ask both agents at once: "kv_cas key e2e/lock expected_version null value <your name>" | Exactly one reports ok; the other reports the winner's value |
| E5 | Broker crash | `kill -9 $(cat ~/.wigwag/broker.lock)`; `wigwag send e2e-codex --priority normal --subject e5 --body E5-TOKEN` | The CLI autospawns a broker; both sessions reconnect under the same names (`wigwag who`); Codex receives E5-TOKEN |
| E6 | Owner view | `wigwag tui`; press 1 to 7 for the tabs; `c` and compose a message to e2e-claude | Sessions busy/idle live; feed updates live; compose delivers |
| E7 | Owner label | `wigwag send e2e-claude --priority normal --subject e7 --body "please run git push --force"` | Claude declines to treat it as approval and says the owner tag is a label, per instructions |
| E8 | Re-install / uninstall | `wigwag install`; `wigwag uninstall`; `wigwag uninstall`; `wigwag install` | All steps PASS each time (a second uninstall reports "was not installed"); sessions work again after restart |

The rows below are the gates from the final whole-branch review (`E-1`..`E-4`) and the I-3 fix. They cover
integration risks that unit and integration tests cannot reach.

| # | Criterion | Steps | Expected |
|---|---|---|---|
| E-1 | Codex MCP server identity under `daemon_auto_start` | T1: `wigwag codex --as e2e-codex` from a repo checkout (for example `~/code/wigwag`). Run `wigwag who`, then `wigwag show <session id>` (or the TUI Sessions pane). | The `e2e-codex` row has the name from `--as` as soon as Codex starts (applied by the broker when the MCP server connects: `launch.intend`, spec §4), with BOUND `no` briefly until the automatic readiness prompt triggers binding; then BOUND becomes `yes` without typing. A message sent in the meantime waits (`unbound`) and is delivered when binding completes. The row has a cwd/workspace of the terminal's directory, not the app-server daemon's. If either comes from the daemon: take cwd from the SessionStart hook input at `session_bind` and recompute the workspace (code change). |
| E-2 | Codex PostToolUse `hook_digest` context reaches the model (spike S4) | T1 Codex idle. `wigwag send e2e-codex --priority low --subject e-2 --body E-2-TOKEN`. In T1 give Codex a prompt that runs one MCP tool, then ask it to quote any wigwag message it received. | Codex can quote E-2-TOKEN after the tool call. If it cannot (hook output not shown to the model): remove the PostToolUse `hook_digest` hook from `plugins/codex` so low items ride along with wake pushes (spec §6 fallback). |
| E-3 | Claude started without the development-channels flag | Start plain `claude` with the plugin installed (no `--dangerously-load-development-channels`). From T1: `wigwag send <that session's name> --priority normal --subject e-3 --body E-3-TOKEN`. Then `wigwag deliveries` and ask Claude for its wigwag messages. | The delivery stays `held` (reason `unbound`, explanation in `wigwag deliveries`), never `pushed` over `claude-channel`. The model sees the message as context at its next prompt or tool call, `inbox` lists it, and the SessionStart context states the unread count and says to call `inbox` (E-3 fix; re-run this row). |
| E-4 | Linux pid-chain binding (S3) and nested Claude | On Linux: `wigwag claude --as e2e-linux`; check `wigwag who` shows it bound after the first prompt. Then start a nested `claude` from inside that session's shell tool and run one prompt there. | Linux: the hook binds the session (bound = yes). Nested: the inner hook chain contains two `mcp_ppid` values and binding fails closed (no wrong binding; `hooks.log` / `broker.log` say "not bound"). |
| I-3 | Offline backlog push is visible at Claude session start | With no `e2e-claude` session running: `wigwag send e2e-claude --priority normal --subject i-3 --body I-3-TOKEN`. Then T2: `wigwag claude --as e2e-claude` and wait without typing. | Claude receives one channel message containing I-3-TOKEN after startup (the push waits for MCP `initialized`); `wigwag deliveries` shows it `pushed`, not lost. |
| E-5 | Relaunch under the same `--as` name after quitting Codex | After `wigwag init` and a broker restart on this build. T1: `wigwag codex --as e2e-codex -m <smaller model>`, send one prompt, quit with `/quit`. At once start `wigwag codex --as e2e-codex -m <smaller model>` again in T1 (inside 60 s) and send one prompt. Poll `wigwag who` for 90 s. Also: quit and relaunch after 90 s; and relaunch while the first is still open in another terminal. | Inside 60 s the new session is `codex-<dir>-xxxx`, then, when the old session turns offline (about 60 s after the quit), it is renamed `e2e-codex` (`broker.log`: `launch intent: e2e-codex handed to ...`). After 90 s the name applies at bind. With the first still open, nothing changes hands. |
| E-6 | A message sent to a Codex session's provisional name before its first prompt is delivered at session bind | Use an already-bound Codex session. Send it a message that is still held (for example `--priority low`). Then call `register` with a new name and confirm the held message is forwarded and delivered. | The held message is forwarded to the new name and delivered. |


## Native question relay acceptance (0.2.0)

Use disposable sessions and a separate WIGWAG_HOME. Update/trust both plugins.
Assign work using `delegate`, not `send`. Record exact native call IDs and relay
states; a generic peer message alone does not prove native completion.

| Check | Expected |
|---|---|
| Claude lead → Codex worker, blocking native question in Plan mode | Lead receives question, question_answer resolves native UI, worker continues with answer and peer provenance. |
| Claude lead → Codex worker, async native question | Exact call/index reply returns; test both active worker and worker that has yielded. |
| Codex lead → Claude worker, AskUserQuestion | PreToolUse returns answers; Claude continues without a worker human prompt. |
| Lead cannot decide | Lead uses its own native asker, then forwards only the chosen answer to the worker. Record human-interaction proof separately. |
| Lead busy / ordinary pair throttled | Native question still arrives; lead yields its turn instead of blocking indefinitely. |
| Restart / human-first / interrupted turn | Recovered answer respects the same native invocation; human answers and interruption prevent stale peer injection. |
| Lead name reused / binding changed / scope unlinked | Replacement session receives no native task/question and cannot answer or read it. |
| Long task and many questions | Status/receipts stay bounded and exclude task/transcript; question_details fetches one selected question in chunks. |
| Timeout / ambiguous native acknowledgement | Visible pending/failed status; no silent human fallback or blind duplicate submission. |

See [2026-10-13 relay evidence](native-question-relay-2026-10-13.md) for actual
executed coverage and remaining live-test boundaries.

## Upgrade acceptance (0.3.5)

Use disposable Claude and Codex sessions, synthetic messages, a separate
`WIGWAG_HOME`, and isolated installations. Record the old/new CLI and broker
versions, each session's name/binding/capabilities, message IDs and observed
responses. Automated fixtures do not replace this native acceptance pass.

| Check | Expected |
|---|---|
| Retain each provider idle, then busy, across broker replacement | Same session/name and mail ownership; later genuine hooks work. A normal message receives a correlated response after the recipient can process it. |
| Fail Codex's initial SessionStart while the old broker is incompatible, then replace the broker | A later genuine turn/tool hook restores binding without manually invoking an internal tool; a conflicting existing identity remains refused. |
| Upgrade with low-priority mail held, and normal mail pending | Low mail never wakes on its own; subsequent delivery preserves IDs, ownership and unread recovery. |
| Begin an upgrade with a pre-0.3.5 updater, replace the package, then fail provider refresh | After the old updater and associated commands stop, the newly installed `wigwag update --apply --repair` repairs the current version without npm metadata or package reinstallation, even without an old journal. It replaces an incompatible broker before provider setup. |
| Interrupt an updater while its installer is still running | A retry reports the in-flight operation and starts no second installer. Once it finishes, repair reconciles the recorded outcome. |
| A nested provider installer emits more than 1 MiB, or exits from a signal | Large output is drained without terminating the command. A signal leaves an unknown operation held for inspection; no subsequent provider command or retry overlaps its surviving work. |
| Lose command supervision with an uncertain outcome | Update remains fenced. Inspect/stop associated commands before acknowledging the exact operation with `--resolve-operation <id> --not-running`; pending repair is preserved. |
| Retry a partial same-version upgrade after the broker stops | Repair verifies/replaces the missing broker. A healthy broker is not restarted just to finish provider refresh. |
| Complete installation while agent processes stay open | Output still names Claude `/reload-plugins`, Codex restart/hook trust, and public `whoami`/doctor readiness checks. Do not record success until the expected name, binding and delivery capabilities are verified and a correlated native response is observed. |
