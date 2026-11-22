# Usage guide

## The pane

The **Agent Command Center** pane opens when a session starts (the desktop app draws graphics, the terminal draws text). From top to bottom:

1. **Graphic area (desktop only):** the pipeline, the route map or the office view.
2. **Buttons:** hide or show the graphic area, choose the view (Pipeline, Route map, Office), switch the route map between its light and dark look, pause or play the animation.
3. **Headline:** the current request, overall progress bar and key numbers.
4. **Agents:** one row per agent. Click a row to open its details (task, handoff status, runtime, tokens, tools, skills, failures).
5. **More detail:** Summary, Handoffs, Tokens, Quota, Time & ETA, History, Completion, Requests and Diagnostics. Click to open or close, or use `[expand all]`.

A one-line status also stays in the status line while work is live, for example `◆ 3 agents · 62% · ETA 1m20s · 5h 12%`.

## Pipeline view

One lane per agent, in the order they were launched:

| Stage | Meaning |
| --- | --- |
| Handed off | Claude dispatched the task to the agent |
| Started | The agent confirmed it started |
| Working | The agent is running; its current tool is shown |
| Report delivered | The agent's report came back |

Each lane also has its own progress bar, elapsed time and token count. Repeated names are numbered (`researcher #2`). If more than eight agents exist, the eight most relevant lanes are shown (every running agent stays visible) and a row counts the rest.

**Overall progress** is steps finished out of steps launched. A running agent counts for part of a step. It never reads 100% while an agent is still working, and reaches 100% only when the request has ended.

## Route map view (desktop)

Choose **Route map**. The work travels along a rail from the **main chat** (the depot) to **one station per agent**, in the order the agents were launched.

| What you see | Meaning |
| --- | --- |
| Numbered flag on a station | The agent's step number (the same number as in the pipeline and the stepper) |
| Pictogram on the building | The agent's role: magnifier = research, list = planner, shield = QA, pencil = designer, `</>` = developer, star = manager |
| Pulsing ring | The agent is working now; a chip above names its current tool or skill |
| Dashed ring | The task was handed to the agent and it has not started yet |
| Green check, red cross, amber mark | Report delivered, failed or stopped, waiting or blocked |
| Rail: solid in the agent's colour, with an arrow | The agent has started; a dashed grey leg means the handoff is still on its way |
| Courier (tram) with a tag | A handoff on its way, for example "Courier · Step 3 · reviewer · handed off". Each parallel handoff gets its own courier (up to three are drawn). |
| Parked courier | "Waiting on N agents" at the main chat while agents work, or "All reports delivered" at the last station |

Under the map, **step cards** show the agents working right now (up to three side by side when they run in parallel), with progress, time and tokens. **How it went** is a stepper with one node per agent, filled up to the last agent in a row that has delivered. A route of more than five stations turns at the right edge and comes back along a second row, right to left. With more than eight agents the eight most relevant stations are drawn (every running agent stays) and a note counts the rest.

**Light or dark:** the button *Switch to dark look / light look* appears in this view. The light look is cream and orange; the dark look matches the rest of the pane. The pipeline and the office keep their dark look.

## Office view (desktop)

Choose **Switch to office view**. Each agent is a character: it walks in from the entrance, takes the task from its parent, works at a desk (with the skill it uses shown), then hands the result over and rests. Hover a character for a tooltip. **Pause animation** gives a still frame (use it for reduced motion, or turn `animations` off in the settings).

## Parallel agents

Tool calls are attributed to the agent that made them, using the agent id the engine attaches to each call. Every parallel agent therefore shows its own current tool from the moment it starts. The header says how many agents run in parallel.

## One chat, one flow

The flow belongs to the chat it runs in. In chat A you see only agents started in chat A, and chat B shows only its own, even when both run agents at the same time. A new chat (a new session id, for example after `/clear`) starts empty. `/agent-diagnostics` shows how many events from another chat were ignored, if any. The only data shared between chats is the learned typical duration per agent type, used for ETAs.

## Commands

All commands print plain text and make no model call.

| Command | Shows |
| --- | --- |
| `/agent-status` | Agents at a glance |
| `/agent-activity` | What each agent is doing right now |
| `/agent-handoffs` | Source → destination handoffs and their confirmed status |
| `/agent-progress` | Per-agent and overall completion |
| `/token-usage` | Tokens by total, agent and model; cache hit rate and retries |
| `/session-usage` | Session (5-hour) quota and context window |
| `/weekly-usage` | Weekly (7-day) quota |
| `/task-runtime` | Runtime of the current task and each agent |
| `/request-runtime` | Runtime of the whole request |
| `/task-eta` | ETA of the current task |
| `/request-eta` | ETA of the entire request |
| `/agent-requests` | Per-request ledger: runtime, tokens, agents, retries |
| `/agent-diagnostics` | Which telemetry the host delivered, and which gaps remain |
| `/execution-report` | Full execution report |

## Handoffs

A handoff has one of these states:

- `dispatched, NOT yet acknowledged`: Claude sent the task, the agent has not started
- `acknowledged`: the agent started
- `returned`: the agent's report arrived
- `refused`: the dispatch was denied

A handoff is never marked `returned` before the destination's report arrives. The parent's acknowledgement is not exposed by the hooks, so it is not shown.

## Alerts

Toasts (turn off with `alerts`) fire once when the 5-hour or weekly quota passes `quotaWarn`, when the context window passes `ctxWarn`, when an agent fails, and when a request finishes.

## ETAs

An ETA comes from the task list when one exists, otherwise from the learned typical durations for each agent type. It is shown as a range with a confidence label, and as "unavailable" when there is no basis. Learned durations are kept between sessions (30 samples for each of up to 50 agent types) and hold numbers only.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Pane is empty | Run `/reload-plugins`. The pane fills when a request starts. A new chat starts empty by design. |
| Quota shows "unavailable" | Your account does not report quota (it needs a subscription plan), or no measurement has arrived yet. See `/agent-diagnostics`. |
| Text shows `(private)` or no prompt text | Expected in the default `strict` privacy mode. Set `privacy` to `standard` to record shortened, masked text. |
| Office view flickers or is too wide | Lower `officeWidth`, or pause the animation. |
| An agent seems stuck | A running agent silent for 5 minutes is labelled "stalled (inferred)". |
| Something looks wrong | Run `/agent-diagnostics` and include its output in an issue. |
