# Changelog

## 0.7.0
- New **Route map** view, inspired by isometric route-map dashboards: the work travels along a rail from the main chat to one station per agent, in launch order. Each station shows the agent's role pictogram, a numbered flag, its state (working ring, handed-off dashed ring, done check, failed cross, waiting mark) and what a working agent is doing. A courier (tram) carries every handoff that is still on its way to its station, with a floating tag ("Courier · Step 3 · name · handed off"); parallel handoffs each get their own courier. Routes longer than five stations turn and come back along a second row; rails fill in once an agent has started and show direction arrows.
- Step cards under the map show the agents working right now (up to three side by side when they run in parallel), and a stepper shows how the request went, step by step.
- Light (cream and orange) and dark looks for the route map, switched with a button. Pipeline and office keep their dark look.
- The pane now has three view buttons: Pipeline (default), Route map, Office.
- Tests for the new view (parts, themes, couriers, bounds, escaping, hostile names, pane switching).

## 0.6.0
- The agent flow is scoped to one chat. Every chat (session id) has its own model, pane, status line and caches. Only agents started in a chat appear in that chat's flow, and events from another chat are never recorded or reacted to: each event carries the id of its chat, classic hooks also say which session they belong to, and a model rejects anything stamped with a different id (counted as "ignored events from another chat" in `/agent-diagnostics`).
- A new chat id (after `/clear` or a resume) starts an empty flow. Chat A and chat B can run agents at the same time and each shows only its own; switching never mixes them.
- Per-chat module state (office movement, SVG cache, status line, request learning, refresh timer) is now keyed by chat id, where it was one shared set.
- What stays shared between chats, on purpose: the learned per-agent-type durations used for ETAs (numbers only, no agent or chat is named) and the settings.
- Stored state is now one model per chat (state shape `acc-3`; an older stored value is read as empty).
- Verified live with two simultaneous runs (2 agents in one, 1 in the other), each showing only its own count.

## 0.5.0
- New default view, the pipeline: every agent is its own lane, one under another in launch order, with four stages (handed off, started, working, report delivered), its own progress bar, elapsed time and tokens. Repeated names are numbered (`mp ref lens #3`). Old finished lanes fold into one row and every running agent stays visible. The animated office is still there: use "Switch to office view".
- Fixed overall progress always reading 100%. It is now steps finished out of steps launched, a running agent counts for part of a step, it never shows 100% while an agent is working, and reaches 100% only when the request has ended.
- Parallel agents: tool calls now come from `tool.call`, which carries the agent id, so each agent shows its own current tool from the moment it starts (before, calls from parallel agents were credited to the main chat). The header and pipeline say how many are running in parallel; more than eight shows eight lanes and a count of the rest. Verified live with three agents launched at once.
- Strict mode no longer shows "(private)" on screen: labels read `Request #1`, `main → mp-planner`.

## 0.4.1
- Found in a live run: prompts the engine injects (a background agent finished, peer messages) were counted as new requests. Only prompts the person typed now start a request.

## 0.4.0
- Private by default: `privacy` now defaults to `strict`, which records no prompt, command, path, output, error, todo, task or title text, only agent, tool and skill names, statuses, counts, tokens, quota and times. Only an explicit `standard` records shortened, masked text.
- Tool inputs are kept only as a keyed one-way fingerprint (random key held in memory, no length), in both modes; retry detection still works.
- Faster reducer: copy-on-write instead of a deep copy of the whole model on every event, one combined pre-check before the secret patterns, plain status checks on hot paths, and cap checks only where a list grows. 10,000 agents reduce in about 1.5 s and 50,000 events in about 2.5 s (previously 15 s+ and 20 s+). A frozen-model test proves the reducer never writes to the previous state.
- Fixes from an independent review: real tool ids, turn ids and model names (which look random) are no longer masked, so every turn's tokens are counted and models stay distinct; an id carrying a real key shape is replaced by a fingerprint. A refused spawn is never taken over by a later agent, and a spawn recorded after its agent started is shown as acknowledged. Handoff ids stay unique. Wrong-typed cost or context values are dropped and reports never throw. History keeps at most 50 agent types.
- Hooks never wait on the monitor: every event is recorded beside the session's own work, including session set-up. The flood guard always keeps events that end a turn, agent, tool call or session.

## 0.3.2
- Security hardening after a red-team pass: far wider secret masking (Stripe, npm, GitLab, Hugging Face, SendGrid, Slack, Azure, PEM keys, Basic/Token auth, `curl -u`, `DB_PASSWORD=`-style names, spaced values, 32-64 hex strings); Unicode and control-character normalisation; every id, name, model and tool field is cleaned and clipped to 64 characters.
- Prototype-name keys (`__proto__`, `constructor`) are made safe; agents (120), tasks and model lists are capped; non-finite or huge numbers and event times are clamped; the pane falls back to a message instead of failing.
- New `privacy` option: `strict` records no free text at all.
- Secrets split by newlines or spaces, or hidden in base64, are now detected and masked. Flood guard: more than 150 events in one second are skipped.
- Catch-all masking: any long token that mixes letters and digits and looks random is masked, even if its shape is not on any list.
- Known limits: a reducer fed 10,000+ distinct agents or 50,000 events back-to-back in a test is still slow (each event copies the model); the hook-level flood guard protects real sessions.

## 0.3.1
- Privacy: API keys, tokens, bearer headers, JWTs, passwords and credentials in URLs are masked before anything is recorded or persisted.
- Token display falls back to context size and cost when no turn has finished; unusable usage values count as zero.

## 0.3.0
- The office is five independent SVGs (header, floor, activity, communication, timeline), drawn 18% larger by default (`officeWidth`, default 900 px). Each part reloads only when its own structure changes, at most once per 2 s; redraw tick is 3 s.

## 0.2.1
- Fix flicker: the office SVG is only swapped when the scene really changes (no frame reload every 500 ms). Office drawn at its real size.

## 0.2.0
- Request ledger (`/agent-requests`): runtime, tokens, agents, tools and retries per request.
- Telemetry diagnostics (`/agent-diagnostics`) built from event-coverage counters.
- Stalled-agent detection, cache hit rate, quota burn-rate projection.
- Toast alerts (quota, context, failed agent, finished request) with de-duplication; status line.
- Initial usage snapshot at session start; settings via `userConfig`.
- State pruning (stale running tools, capped history) and a bounded model.
- Office: validated colour palette, status glyphs, tooltips, pause-animation toggle, collision-free manager room.
- Tests: fuzz, performance budget, ledger, alerts, projection, diagnostics, stalled, animation-off.

## 0.1.0
- Observer-only pane, 12 commands, animated office with handoff choreography, persistence.
