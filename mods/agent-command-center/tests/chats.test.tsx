// One chat, one flow: agents and events of one chat never show up in another chat's flow.
import { expect, test } from 'claude-code/testing'
import { diagnostics } from '../lib/derive'
import { newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'

const T0 = 1_700_000_000_000
const CFG = { alerts: true, quotaWarn: 80, ctxWarn: 85, strict: false }
const feed = (m: ReturnType<typeof newModel>, evs: Ev[]) => evs.reduce((a, e) => reduce(a, e, CFG), m)
const names = (m: ReturnType<typeof newModel>) => Object.values(m.agents).map(a => a.type)

test('reducer: an event stamped with another chat is counted, never recorded', () => {
  let a = newModel('chat-A', T0)
  a = feed(a, [
    { k: 'agent.start', t: T0 + 1, agentId: 'a1', type: 'AlphaOne', chat: 'chat-A' },
    { k: 'agent.start', t: T0 + 2, agentId: 'b1', type: 'BetaOne', chat: 'chat-B' },
    { k: 'tool.start', t: T0 + 3, id: 'u1', tool: 'Read', key: 'Read|x', summary: 'x', agentId: 'b1', chat: 'chat-B' },
    { k: 'turn.end', t: T0 + 4, turnId: 't1', durationMs: 1, reason: 'answer', usage: { i: 999, o: 1, cr: 0, cc: 0, model: 'm' }, chat: 'chat-B' },
    { k: 'request.start', t: T0 + 5, text: 'from B', chat: 'chat-B' },
  ])
  expect(names(a)).toContain('AlphaOne')
  expect(names(a)).not.toContain('BetaOne')
  expect(a.tokens.total.i).toBe(0)
  expect(a.requests).toBe(0)
  expect(Object.keys(a.running).length).toBe(0)
  expect(a.cov.foreign).toBe(4)
  expect(diagnostics(a).some(d => /another chat/.test(d.text))).toBe(true)
})

test('reducer: two chats with parallel agents each, events interleaved, stay apart', () => {
  let a = newModel('chat-A', T0)
  let b = newModel('chat-B', T0)
  const stream = (chat: string, p: string): Ev[] => [
    { k: 'request.start', t: T0 + 1, text: `${p} task`, chat },
    { k: 'spawn', t: T0 + 2, agentId: `${p}1`, type: `${p}One`, desc: 'd', prompt: 'p', chat },
    { k: 'spawn', t: T0 + 3, agentId: `${p}2`, type: `${p}Two`, desc: 'd', prompt: 'p', chat },
    { k: 'spawn', t: T0 + 4, agentId: `${p}3`, type: `${p}Three`, desc: 'd', prompt: 'p', chat },
    { k: 'agent.start', t: T0 + 5, agentId: `${p}1`, type: `${p}One`, chat },
    { k: 'agent.start', t: T0 + 6, agentId: `${p}2`, type: `${p}Two`, chat },
    { k: 'agent.start', t: T0 + 7, agentId: `${p}3`, type: `${p}Three`, chat },
    { k: 'tool.start', t: T0 + 8, id: `${p}-u1`, tool: 'Read', key: 'Read|f', summary: 'f', agentId: `${p}2`, chat },
    { k: 'report', t: T0 + 9, agentId: `${p}1`, type: `${p}One`, status: 'completed', text: 'done', chat },
  ]
  const sa = stream('chat-A', 'Alpha')
  const sb = stream('chat-B', 'Beta')
  // every event is delivered to BOTH chats' reducers, as a shared bus would: each keeps only its own
  for (let i = 0; i < sa.length; i++) {
    for (const e of [sa[i] as Ev, sb[i] as Ev]) {
      a = reduce(a, e, CFG)
      b = reduce(b, e, CFG)
    }
  }
  const nA = names(a)
  const nB = names(b)
  expect(nA.filter(x => x.startsWith('Alpha')).length).toBe(3)
  expect(nA.some(x => x.startsWith('Beta'))).toBe(false)
  expect(nB.filter(x => x.startsWith('Beta')).length).toBe(3)
  expect(nB.some(x => x.startsWith('Alpha'))).toBe(false)
  expect(a.requests).toBe(1)
  expect(b.requests).toBe(1)
  expect(a.handoffs.length).toBe(3)
  expect(b.handoffs.length).toBe(3)
  expect(JSON.stringify(a).includes('Beta')).toBe(false)
  expect(JSON.stringify(b).includes('Alpha')).toBe(false)
})

test('reducer: an event with no chat stamp still belongs to the model it is given', () => {
  const m = feed(newModel('chat-A', T0), [{ k: 'agent.start', t: T0 + 1, agentId: 'x', type: 'Plain' }])
  expect(names(m)).toContain('Plain')
  expect(m.cov.foreign).toBe(undefined)
})

const PANE = {
  plugin: 'agent-command-center',
  component: 'Pane',
  requestId: 'agent-command-center',
  props: { title: 'Agent Command Center', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('engine: chat A shows only its agents while chat B runs at the same time, and switching never mixes them', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let chat = 'chat-A'
  on('session.id', () => ({ value: chat }) as never)
  let clock = 1_700_000_000_000
  on('clock.now', () => ({ value: (clock += 500) }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('classic.SubagentStart', () => ({}))
  on('classic.PostToolUse', () => ({}))

  const report = async (c: string) => {
    chat = c
    return String((await $.command.run({ command: 'agent-activity', args: '' } as never)).text)
  }

  chat = 'chat-A'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  chat = 'chat-B'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // both chats run agents, interleaved
  chat = 'chat-A'
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'AlphaScout', session_id: 'chat-A' })
  chat = 'chat-B'
  await $.classic.SubagentStart({ agent_id: 'b1', agent_type: 'BetaWriter', session_id: 'chat-B' })
  chat = 'chat-A'
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'AlphaCoder', session_id: 'chat-A' })
  chat = 'chat-B'
  await $.classic.SubagentStart({ agent_id: 'b2', agent_type: 'BetaTester', session_id: 'chat-B' })
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: { file_path: '/b.ts' }, tool_response: {}, tool_use_id: 'tb', agent_id: 'b1', duration_ms: 5, session_id: 'chat-B' })
  // an event that says it belongs to chat B, delivered while this is chat A, is ignored
  chat = 'chat-A'
  await $.classic.SubagentStart({ agent_id: 'ghost', agent_type: 'GhostFromB', session_id: 'chat-B' })

  for (let round = 0; round < 2; round++) {
    const ra = await report('chat-A')
    expect(ra).toMatch(/AlphaScout/)
    expect(ra).toMatch(/AlphaCoder/)
    expect(/Beta|Ghost/.test(ra)).toBe(false)
    const rb = await report('chat-B')
    expect(rb).toMatch(/BetaWriter/)
    expect(rb).toMatch(/BetaTester/)
    expect(/Alpha|Ghost/.test(rb)).toBe(false)
  }

  // the pane of each chat draws only its own agents, on both surfaces
  for (const surface of ['terminal', 'desktop'] as const) {
    chat = 'chat-A'
    const ua = await $.ui.mount({ ...PANE, surface })
    expect(await ua.find({ type: 'Text', text: /AlphaScout/ })).toBeTruthy()
    expect(await ua.find({ type: 'Text', text: /Beta/ })).toBeUndefined()
    await ua.unmount()
    chat = 'chat-B'
    const ub = await $.ui.mount({ ...PANE, surface })
    expect(await ub.find({ type: 'Text', text: /BetaWriter/ })).toBeTruthy()
    expect(await ub.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
    await ub.unmount()
  }

  // a chat that never ran anything has an empty flow
  const rc = await report('chat-C')
  expect(/Alpha|Beta|Ghost/.test(rc)).toBe(false)
})
