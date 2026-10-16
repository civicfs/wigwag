# Wigwag privacy notice

Updated October 16, 2026. This notice describes the self-hosted Wigwag CLI and local Claude Code/Codex plugins.
It does not describe a hosted service, and it does not replace your inference provider's privacy policy or your
organization's obligations. Read it before installing or sharing content through the plugin.

## Who operates Wigwag

You or the organization operating the host controls its Wigwag installation and stored data. The shipped runtime
does not send telemetry or stored broker data to the project maintainer, and the maintainer does not receive your
messages merely because you install Wigwag. Installation and updates use package registries and provider plugin
commands; those services have their own data practices. Agent launchers check npm package metadata at most daily to notify you of a release. The request includes no broker data; the registry sees ordinary connection metadata. Set `WIGWAG_NO_UPDATE_CHECK=1` to disable these checks. Installation happens only on an explicit update request.

For questions about this notice, use the [project issue tracker](https://github.com/civicfs/wigwag/issues). Do not post
private message content, credentials, or personal data in a public issue. For access or deletion requests about an
organization-managed installation, contact the organization operating that host.

## Data stored and purposes

| Data | Purpose |
|---|---|
| Session names and native titles/IDs, transcript reference paths, agent type, working directory and repository paths, process identifiers/start identities, state, and timestamps | Bind tools and hooks to the correct session, show availability, and determine workspace scope |
| Message subjects and bodies, sender and recipient metadata, requests and responses, attachment references, and delivery history | Route messages, retry delivery, provide inboxes and the owner feed, and match responses |
| Submitted files or text blobs, hashes, names, media types, and creation metadata | Store and retrieve attachments |
| Shared key/value data and history, stream schemas and records | Coordinate explicitly shared state and notifications |
| Workspace links, subscriptions, mutes, throttles, and configuration | Control scope, notifications, delivery, and runtime behavior |
| Broker and hook diagnostic logs | Diagnose startup, binding, and delivery errors; logs can include paths, identifiers, and error details |

Paths and message contents can identify people or contain confidential information. Wigwag has no provider-login
flow and does not read provider credential stores or forward agent conversation transcripts. Native Codex question recovery can read the assigned thread history locally to match questions and existing answers; that history is not relayed to other agents.
Native naming reads local Claude title sidecars and bounded transcript tails, or Codex thread metadata and bounded
session-index tails. It stores the display title and transcript reference path; it does not relay conversation
transcripts for naming. Resume lineage records keep native IDs, slot IDs, provenance, recovery outcomes, explicit
name choices and claim refusal reasons. Owner recovery reports include names, name sources, timestamps, connection
state, assignment IDs/roles and undelivered-mail counts. Codex automatic slot recovery is disabled because the hook's
shared tree-root ID does not establish a concrete conversation identity.
Tools process the snippets, data, and file paths supplied to them; a blob upload reads the specified file.

Do not send passwords, API keys, authentication tokens, protected health information, or payment-card data through
the plugin. Minimize other personal data and share only what is necessary for the authorized task. The current
implementation does not automatically redact or classify arbitrary message bodies or attachments.

## Storage and recipients

The home directory is `$WIGWAG_HOME`, otherwise `$XDG_STATE_HOME/wigwag`, otherwise `~/.wigwag`. It contains the
SQLite database, blob files, configuration, and logs. The broker listens on a local Unix socket, not a network port.
**Messages are saved in clear text in an unencrypted SQLite file, `state.db`, in
that directory.** Message subjects and bodies, native questions and answers,
requests/responses, and shared state are not encrypted by Wigwag. SQLite WAL and
other sidecar files can contain that content too. Blob files and logs are also
unencrypted. The home directory and socket use OS permissions; those permissions
restrict access but do not encrypt stored data. Processes running as the same OS
user, host administrators, and backups with sufficient access can read it.
Before each schema v3/v4 upgrade, an existing database is copied to
`state.db.pre-v3.bak` or `state.db.pre-v4.bak` with mode 0600. This backup contains the same clear-text data
and remains after a successful upgrade or when the migration outcome cannot be
confirmed. A confirmed rollback removes only the backup created by that attempt.
A pre-existing backup is never overwritten or removed by migration and blocks
an upgrade until the operator inspects and moves or removes it. Include retained
migration backups in your storage and deletion procedures.

Host-level disk or backup encryption is a separate operator control and does not
protect against a process already running with your OS-user access.

The local owner CLI and TUI can read data across workspaces. Agent tools can read data within their workspace scope;
worktrees of one repository share a workspace. Owner-created workspace links are transitive and expand that scope.
Messages go to their addressed recipients; shared data may be available to other sessions in scope, and subscriptions
can deliver change notifications. All processes run as the same OS user: these scope checks are not an isolation
boundary against a process with equivalent filesystem or shell access. Host administrators and backup software may
also have access according to the host's configuration.

**Local broker transport does not mean content remains on the host.** A delivered message, inline tool result, or
attachment fetched into agent context may be sent to Anthropic, OpenAI, or another configured inference provider.
The provider's account settings, contracts, retention, training controls, and processing locations apply to that copy.
An attachment stored locally is not automatically uploaded in full merely by storing it; subsequent tool use or
agent file access can bring its contents into context.

Only share material you are authorized to provide to the recipient sessions and their providers. An organization
operating Wigwag must provide any additional notices and obtain any consents its deployment requires. The project
maintainer has no access to your local installation to sell, inspect, or delete its data.

## Retention and deletion

Wigwag currently has no automatic retention period or per-message erasure feature. Messages, stream records, and
key/value history are append-only and remain until the operator removes the installation's stored data. Expiring a
request, acknowledging a message, deleting a current key/value entry, or unlinking workspaces does not erase history.
Unlinking restricts subsequent scoped access; it cannot recall copies already received. Retiring a slot or resolving
a recovery flag affects eligibility and active diagnostics; neither action erases stored messages, assignments or
lineage history. Forced retirement can exclude slots that still hold work.

`wigwag uninstall` removes plugin registrations and retains the home directory. To remove local stored data:

1. Close all connected Claude Code and Codex sessions so they cannot restart the broker.
2. Run `wigwag broker stop`.
3. Identify the home directory using the precedence above, then manually delete that directory. This permanently
   removes its configuration, database, SQLite sidecar files and any `state.db.pre-v3.bak` / `state.db.pre-v4.bak` backups, history, logs,
   and blobs. Reinitialize before reuse.
4. Separately address exports, destination files written by `blob_get`, backups, and provider-held copies. Deleting
   the Wigwag home directory does not delete those copies or agent conversation history.

## User controls

You control plugin installation, the sessions you launch, messages and attachments you submit, workspace links,
subscriptions, and mutes. Normal muted traffic waits; urgent traffic bypasses a mute. A mute is not revocation of
workspace data access. Unsubscribe or unlink when appropriate, and uninstall the plugin to stop future registration.
Choose your providers' data settings separately; Wigwag does not change them.
