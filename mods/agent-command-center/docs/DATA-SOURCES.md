# Data sources

Everything shown comes from events Claude Code already emits to mods. Each value is tagged **actual** (reported by the host), **inferred** (derived, and labelled as such on screen) or **unavailable** (shown honestly as unavailable).

| Data | Source event | Kind |
| --- | --- | --- |
| Request start and end, main turns | `prompt.submit`, `turn.start`, `turn.complete` | actual |
| Subagent dispatch, start, report | `agent.spawn`, `classic.SubagentStart/Stop`, `agent.report` | actual |
| Tool start (attributed to the calling agent) | `tool.call` (carries the agent id) | actual |
| Tool success and failure | `classic.PostToolUse`, `classic.PostToolUseFailure` | actual |
| Subtasks and progress | `TodoWrite` input, `classic.TaskCreated/Completed` | actual when a task list exists, otherwise unavailable |
| Tokens (input, output, cache read, cache write), cache hit rate | `turn.complete` usage, de-duplicated by turn id | actual, per turn |
| Tokens per request | difference of session totals across the request | actual, turn granularity |
| Quota (5-hour, weekly), context, cost | `session.measure`, `$.session.usage()` | actual, only when the account reports it |
| Quota burn rate and time to limit | linear projection over sampled quota history (needs two or more samples) | inferred |
| Compaction, model change, interruption | `classic.PreCompact/PostCompact`, `classic.PostModelSwitch`, `session.stop` | actual |
| Waiting or blocked | `classic.Notification`, `classic.TeammateIdle`, running children | actual or inferred |
| Stalled agent | running but silent for 5 minutes | inferred |
| Retries | the same tool with the same input after a failure | inferred |
| ETA | task-list rate, otherwise learned durations per agent type | estimate with a confidence label |

## What is not available

- Token counts finer than a turn
- The token cost of retries
- Verification status
- Messages between agents that do not go through the Agent tool
- The parent's acknowledgement of a handoff
- Quota on accounts that do not report it

`/agent-diagnostics` lists which of these events the host really delivered in the current chat, so a gap is visible instead of hidden.

## Which events are ignored

- Events stamped with another chat's id (counted, never recorded)
- Prompts the engine injects itself (a background agent finished, a peer's message): only prompts the person typed start a request
- Bursts above 150 events per second, except events that end something (a turn, agent, tool call, request or session), which are always kept
