import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-command-center',
  component: 'Pane',
  requestId: 'agent-command-center',
  props: { title: 'Agent Command Center', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('hooks feed the pane and the /agent-status command, with no model call', async ($, on) => {
  let modelCalls = 0
  on('model.complete', () => (modelCalls++, { value: { isAnswered: false, reason: 'aborted', usage: {} } }) as never)
  on('model.fork', () => (modelCalls++, { value: { isAnswered: false, reason: 'aborted', usage: {} } }) as never)
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }) as never)
  let clock = 1_700_000_000_000
  on('clock.now', () => ({ value: (clock += 1000) }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('classic.SubagentStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.SubagentStart({ agent_id: 'ag1', agent_type: 'Explore', session_id: 'sess-1' })
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: { file_path: '/a.ts' }, tool_response: {}, tool_use_id: 'tu1', agent_id: 'ag1', duration_ms: 12, session_id: 'sess-1' })
  await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 'tu2', error: 'exit 1', agent_id: 'ag1', session_id: 'sess-1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // the animated office is drawn where SVG exists (desktop), and the text view stands alone on the terminal
    const svg = await ui.find({ type: 'Svg' })
    expect(svg !== undefined).toBe(surface === 'desktop')
    // compact view: basic details are always visible, details are collapsed
    expect(await ui.find({ type: 'Text', text: /AGENT COMMAND CENTER/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /tool failed: Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /EXECUTION HISTORY/ })).toBeUndefined()
    // click the History button -> the section opens
    await ui.press({ key: 'b-sec:history' })
    expect(await ui.find({ type: 'Text', text: /EXECUTION HISTORY/ })).toBeTruthy()
    await ui.press({ key: 'b-sec:history' })
    expect(await ui.find({ type: 'Text', text: /EXECUTION HISTORY/ })).toBeUndefined()
    // click an agent row -> its details open
    // state is shared by both surfaces, so the agent may already be open: a press must flip it
    const wasOpen = (await ui.find({ type: 'Text', text: /subtasks/ })) !== undefined
    await ui.press({ key: 'a-ag1' })
    expect((await ui.find({ type: 'Text', text: /subtasks/ })) !== undefined).toBe(!wasOpen)
    await ui.unmount()
  }
  const status = await $.command.run({ command: 'agent-activity', args: '' } as never)
  expect(/Explore/.test(String(status.text))).toBe(true)
  expect(/FAILED Bash/.test(String(status.text))).toBe(true)
  const weekly = await $.command.run({ command: 'weekly-usage', args: '' } as never)
  expect(/unavailable/.test(String(weekly.text))).toBe(true)
  expect(modelCalls).toBe(0)
})
