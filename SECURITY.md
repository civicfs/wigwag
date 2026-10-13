# Security policy

Wigwag is an early-stage local tool. Security fixes target the latest source
revision; no older release has a separate maintenance guarantee.

## Report a vulnerability

Please report security issues privately before disclosing exploit details.
Use **Security → Report a vulnerability** on the
[GitHub repository](https://github.com/civicfs/wigwag/security).
If private reporting is unavailable, open an issue asking the maintainer for a
private reporting channel, without the vulnerability details or a working exploit.

Include the affected version, operating system, a minimal reproduction with
synthetic data, the expected impact, and any suggested fix. Never attach live
Wigwag databases, transcripts, provider credentials, or unredacted diagnostic logs.
There is no guaranteed response time or bug-bounty program.

## Security model

**Messages are saved in clear text in an unencrypted SQLite database.** SQLite
sidecars, blobs, logs, and backups can also contain clear-text content. Filesystem
permissions restrict access; Wigwag does not encrypt that data.

The broker uses a local Unix socket. Workspace scoping protects against accidental
sharing by cooperating agents, not another process running as your OS user.
Agents with shell access can invoke the owner CLI. An `owner` label or an
orchestrator's answer is not proof of human approval. Content delivered into an
agent's context may be sent to its inference provider.

Read the [privacy notice](PRIVACY.md) and
[security review](docs/security-review-2026-10-13.md) for the threat model, resolved
findings, remaining development dependency advisory, and verification limits.
