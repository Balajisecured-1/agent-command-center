# Roadmap

Planned improvements, in rough priority order. These are intentions, not promises, and the order can change. Every item keeps the core rules: observer only, no extra model calls, private by default.

## Next

| Item | Why |
| --- | --- |
| **Check the Desktop pane on more machines and long sessions** | The pipeline and office views have been checked by hand on one machine, and the automated tests do not paint pixels. More screen sizes, long runs and many-agent runs are needed. |
| **Independent security review** | The privacy and hardening work was tested by an automated red-team suite and one independent review. A human review of the masking and the per-chat scoping would give more confidence. |
| **Choose and add a license** | The repo has none yet, so by default all rights are reserved and others cannot reuse it. |
| **Light and dark for every view** | The light/dark switch only covers the route map today. The pipeline and the office are dark only. |
| **Real screenshots** | The docs show a generated sample of the pipeline view. Screenshots of the live pane (pipeline, office, text view) would show it better. |
| **Continuous integration** | Run `claude plugin validate` and `claude plugin test` on every push so a change cannot land with a failing test. |

## Later

| Item | Why |
| --- | --- |
| **Click a station for details** | Open the agent's detail panel from the map, as the pipeline lanes do. Needs the host to deliver clicks inside drawings. |
| **Richer scenery** | More buildings per role, a second floor for nested agents (an agent that launches its own agents), and a real camera zoom. |
| **Stronger masking in `standard` mode** | Masking is pattern based, so a short secret or a passphrase of ordinary words can still be recorded. Ideas: an allow-list mode that records only known-safe fields, and optional user-defined patterns. `strict` stays the default. |
| **Export a report** | Save the execution report and the request ledger as a file you can attach to a ticket or share, with the same privacy rules applied. |
| **Per-request token detail** | Tokens are per turn today. Finer detail depends on what the host reports. |
| **Compare runs** | Show how a request compares with earlier ones of the same shape (time, tokens, agents, retries). |
| **ETA improvements** | Use more history (per task type, per model) and show how far past ETAs were off, so the confidence label can be checked. |
| **Accessibility pass** | Keyboard-only use of the pane, screen-reader labels for the graphics, a high-contrast palette. |
| **Settings to clear learned history** | One command to forget the stored per-agent-type durations. |

## Known limits that depend on the host

These cannot be fixed inside the mod. If Claude Code starts reporting them, the mod can show them.

- Messages between agents that do not go through the Agent tool
- The parent's acknowledgement of a handoff
- Quota for accounts that do not report it
- Verification status

## Ideas and bugs

Open an issue on the repository. For anything security related, use the private route in [SECURITY.md](../../../SECURITY.md).
