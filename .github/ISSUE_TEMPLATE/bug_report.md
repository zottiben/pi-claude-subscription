---
name: Bug report
about: Something isn't working
labels: bug
---

**What happened**

<!-- What you did, what you expected, what you got instead. -->

**Versions**

- pi: <!-- pi --version -->
- pi-claude-subscription:
- Claude Code: <!-- claude --version, if installed separately -->
- Node: <!-- node -v -->
- OS:

**Model and config**

- Model: <!-- e.g. claude-subscription/claude-opus-4-8 -->
- Relevant bits of `claude-subscription.json`, if any:

**Logs**

Re-run with `CLAUDE_SUBSCRIPTION_DEBUG=1` and attach:

- `~/.pi/agent/claude-subscription.log`
- the matching file from `~/.pi/agent/cc-cli-logs/`

For a session-resume failure ("No conversation found"), the `syncResult:` lines from the
first log plus the `cc-cli-logs/` file for the failing query are the most useful part.
