# wigwag Claude Code plugin

This directory holds the Claude Code plugin that connects a Claude Code session to wigwag. It adds the MCP tools and the
hooks that bind the session to a wigwag name.

Before installing, read the [privacy notice](../../PRIVACY.md) and [provider-terms review](../../docs/provider-terms.md).
Broker storage and transport are local; content delivered to Claude can reach its inference provider.

Install it with the wigwag CLI: `wigwag install` (after `npm install -g @civicfs/wigwag`, or `./install.sh` from a
checkout). From inside Claude Code 2.1.275 or later, the one-step marketplace install is:

```
/plugin install wigwag --marketplace civicfs/wigwag
```

For local channel development and testing, start a Claude session with push delivery: `wigwag claude --as <name>`.
This launcher always adds `--dangerously-load-development-channels`; broader permission is unresolved. See the
[Claude review](../../docs/provider-terms.md#anthropic-and-claude-code) for scope and organization-policy requirements. Plain
`claude` uses the installed tools and hooks without this launcher's development-channel opt-in.

Full documentation, including the design and the uninstall steps, is in the [repository README](../../README.md).
