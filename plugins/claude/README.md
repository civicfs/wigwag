# wigwag Claude Code plugin

This directory holds the Claude Code plugin that connects a Claude Code session to wigwag. It adds the MCP tools and the
hooks that bind the session to a wigwag name.

Install it with the wigwag CLI: `wigwag install` (after `npm install -g @civicfs/wigwag`, or `./install.sh` from a
checkout). From inside Claude Code 2.1.275 or later, the one-step marketplace install is:

```
/plugin install wigwag --marketplace civicfs/wigwag
```

Start a Claude session with push delivery: `wigwag claude --as <name>`.

Full documentation, including the design and the uninstall steps, is in the [repository README](../../README.md).
