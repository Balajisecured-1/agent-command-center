# Privacy and security

## Guarantees

- **Observer only.** Every hook records an event and passes it on unchanged. The mod never blocks, rewrites or denies a call and never touches permissions.
- **No model calls, no network.** Nothing is sent anywhere. There is no monitoring agent.
- **Per-chat.** Each chat has its own model. Events from another chat are not recorded.

## Privacy modes (`privacy` setting)

### `strict` (default)

Records only:

- agent, tool and skill names
- statuses and counts
- token counts, quota percentages, context size, cost estimates
- times and durations

Records **no** prompt text, tool commands, file paths, agent outputs, errors, todo text, task names or session titles. Those fields show `(private)` internally; screens show clean labels such as `Request #1`. A skill name is kept only when the summary is a bare name. Because no free text is stored, a secret cannot be recorded, whatever it looks like.

Retries are still detected: a tool input is compared by a keyed one-way fingerprint (a random key held in memory only, no length kept), and the input itself is never stored.

### `standard` (opt-in)

Also records shortened text (about 100 to 160 characters) so the ledger and timeline show what was asked and run. Before anything is kept, text is normalised (Unicode, control characters) and secrets are masked:

- well-known key shapes (OpenAI, Anthropic, GitHub, GitLab, AWS, Google, Stripe, Slack, Azure, npm, Hugging Face, SendGrid, JWTs, PEM keys, bearer and basic auth)
- `password=`, `token:` style pairs, `curl -u`, credentials in URLs and query strings
- secrets split by spaces or newlines, and base64-wrapped secrets
- any long token that looks random

**Limit:** this is pattern based. A short secret or a passphrase made of ordinary words can still be recorded in `standard` mode. If that matters, keep `strict`.

## Ids and names

Ids, agent types, tool names and model names are cleaned separately: control characters stripped, 64-character cap, prototype names such as `__proto__` made safe, and anything shaped like a real key replaced by a short fingerprint while staying distinct.

## What is stored

| Where | What | Lifetime |
| --- | --- | --- |
| Session state (`$.state`) | One model per chat: agents, handoffs, counts, tokens, quota samples, capped event list | The session |
| Plugin store (`$.store`, key `history`) | Learned run times per agent type (30 samples for up to 50 types), numbers only | Across sessions |
| Memory only | The random key used for fingerprints | The process |

The mod writes no files of its own.

## Bounds

Agents (120), tasks (200), models (30), history types (50), events (400), requests (20), quota samples (40) and alert keys (80) are capped, and numbers and timestamps are clamped, so a long or hostile session cannot grow the model without limit. A flood guard skips bursts above 150 events per second while always keeping events that end something.

## How it was tested

An automated red-team style suite feeds hostile input (planted secrets in many encodings, prototype pollution keys, oversized and non-finite values, floods, ReDoS-style strings) in both modes and checks that no planted secret appears in the model, any report or the drawing, that the reducer never writes to the previous state, and that processing stays within time budgets. An independent review found issues that were fixed and are covered by regression tests. This is not a substitute for an independent security audit.

## Reporting a problem

See [SECURITY.md](../../../SECURITY.md).
