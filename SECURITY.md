# Security policy

Agent Command Center is an observer: it records Claude Code hook events, passes them through unchanged, makes no model or network calls and writes no files of its own. See [Privacy and security](mods/agent-command-center/docs/PRIVACY.md) for exactly what is recorded.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Include the privacy mode, the Claude Code version and the smallest input that reproduces it.

Of particular interest:

- any way for text typed, run or returned in a session to appear in the model, a report or the drawing while `privacy` is `strict`
- any way for events or agents of one chat to appear in another chat's flow
- inputs that make the mod slow or large (the reducer has speed and size budgets)

Known limit, not a vulnerability: in `standard` mode masking is pattern based, so a short secret or a passphrase of ordinary words can still be recorded. `strict` is the default for that reason.
