# Contributing

## Layout

```
.claude-plugin/marketplace.json     marketplace entry for the repo
mods/agent-command-center/
  .claude-plugin/plugin.json        manifest, settings (userConfig), version
  hooks/register.tsx                hooks -> events, pane, commands (the only stateful file)
  lib/model.ts                      the pure reducer and privacy cleaning
  lib/derive.ts                     progress, ETA, stalled, quota projection, diagnostics
  lib/sections.ts                   text reports and the 14 commands
  lib/compact.ts                    headline, rows, input for the views
  lib/flow.ts                       pipeline view (SVG parts)
  lib/route.ts                      route map view (SVG parts, light and dark looks)
  lib/office.ts                     office view (SVG parts, choreography)
  types/index.d.ts                  model types and the stored-state contract
  tests/                            claude plugin test suites
  docs/                             documentation
```

## Run the checks

You need Claude Code with plugin support. From `mods/agent-command-center`:

```
claude plugin validate .
claude plugin test .
```

Try it in a real session without installing:

```
claude -p "Launch 2 general-purpose agents in parallel, each reading a file, then summarise." --model haiku --plugin-dir . --debug-file debug.txt
```

The debug file shows each `$.ui.status` and `$.ui.toast` the mod emitted and any hook error.

## Rules the code keeps

1. **Observer only.** A hook awaits `next(e)` and returns its result. Nothing is denied, rewritten or blocked, and nothing calls a model.
2. **One reducer.** All state changes go through `reduce(model, event, cfg)`, which must not write to the previous model (a test freezes it). Add copy-on-write helpers (`wa`, `wh`, `own`, `bump`) when you touch a new part of the model.
3. **Privacy first.** Any new text field must go through the cleaners and be listed in `HIDE_KEYS` if it is free text, so `strict` mode never records it. Add a leak test in `tests/privacy.test.tsx`.
4. **One chat, one flow.** New state is per chat: read through `modelOf()`, write through `changeModel()`, and key any module-level cache by chat id. Add a case to `tests/chats.test.tsx`.
5. **Bounded.** Every list that grows needs a cap.
6. **Honest.** Mark inferred values as inferred and show unavailable data as unavailable.
7. **Hooks are top-level.** The validator only lets `$` be passed to top-level declared functions.

## Changing stored state

The model atom has a shape tag (`SHAPE` in `lib/model.ts`). Change it whenever the stored model or `Book` shape changes, so old stored values are read as empty instead of breaking the new code.

## Pull requests

Keep changes small, add or update a test, update `CHANGELOG.md` and the relevant page in `docs/`.
