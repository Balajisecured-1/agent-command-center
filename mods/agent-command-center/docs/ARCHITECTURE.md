# Architecture

```
hooks (register.tsx)  ->  Ev (+ chat id)  ->  reduce(model, ev, cfg)  ->  Model (one per chat, in the $.state Book)
                                                                           |
        derive.ts (progress, ETA, stalled, projection, diagnostics) <- pure functions of Model + History
                                                                           |
        sections.ts (text reports, 14 commands)    compact.ts (headline, rows, view input)
                                                                           |
                       flow.ts (pipeline SVG)  /  office.ts (office SVG)  /  Text view on the terminal
```

## Principles

- **One reducer.** `lib/model.ts` is a pure function from (model, event) to a new model. Hooks only translate engine events into `Ev` values; nothing else changes state. A test freezes the previous model to prove it is never written to.
- **Copy-on-write.** `reduce` clones the model shallowly and copies a sub-map or agent the first time an event writes to it (`own`, `wa`, `wh`, `bump`). A deep copy per event took about 8 s for 5,000 agents; this takes about 2 s.
- **Observer only.** Hooks `await next(e)` (alongside recording the event, never in front of it) and return its result. They never deny, rewrite or call `$.model`.
- **Bounded state.** Agents (120), tasks (200), models (30), history types (50), requests (20), quota samples (40), alert keys (80) and the event list are capped.
- **Honest provenance.** Inferred values carry an `inferred` tag. `cov` counts each event kind seen so `/agent-diagnostics` can say what the host did not deliver.
- **Privacy at the door.** `cleanEv` runs on every event before the reducer touches it: control characters stripped, ids cleaned by `ident()`, free text replaced by `(private)` in `strict` mode or masked and shortened in `standard`. See [PRIVACY.md](PRIVACY.md).

## Chat scope

One chat = one session id.

- `emit()` stamps every event with the chat id (`Ev.chat`). Classic hooks carry their own `session_id`, which equals `$.session.id()`, and that claim is used as the stamp.
- `reduce()` returns the model unchanged, except for a `foreign` counter, when the stamp differs from `model.sessionId`.
- The `$.state` value is a `Book`: one `Model` per chat id (at most 12). It is written only through `changeModel()` and read only through `modelOf()`, so one chat never reads or writes another's entry. A new id (after `/clear` or a resume) starts a fresh model.
- Module-level caches (office movement, SVG cache, status line, request learning, refresh timer, flood window) live in `chats: Map<id, Chat>` (at most 24).
- Shared on purpose: `hist` (anonymous learned durations per agent type, used for ETAs) and the settings.

## Parallel agents

`tool.call` carries the id of the calling agent, from the same id space as the classic `agent_id`. A tool start is credited to that agent; a call from an unknown agent id is ignored. Only when there is no agent id and the main chat is waiting on a single running agent is the call credited to that agent, and then it is labelled inferred.

## Views

- **Pipeline (`flow.ts`):** three independent SVG parts (`header`, `lanes`, `comms`), one lane per agent, at most eight lanes with a count of the rest. Default.
- **Office (`office.ts`):** the animated scene as parts (`header`, `floor`, `activity`, `comms`, `timeline`).
- Each part is its own SVG. A part is swapped only when its structure changed (animation elements and walk countdowns do not count), at most once every 2 s, so frames do not restart or flicker. The terminal has no `Svg` element and gets text only.
- The only timer is a 3 s local redraw while something is live.

## Persistence

- Session state: the `Book`, with a `shape` tag (`SHAPE`, currently `acc-3`). A stored value with another tag is read as empty and rebuilt.
- Plugin store: `history` only (learned durations per agent type: 30 samples, up to 50 types).

## Palette

Agent identity colours are a validated categorical set (checked for colour-blind separation and contrast on the dark surface). Status colours are reserved and always paired with a glyph and a label.
