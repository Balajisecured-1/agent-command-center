// The pipeline view and the progress rules, from the first live screenshot (ten agents, five with the same name).
import { expect, test } from 'claude-code/testing'
import { officeInput } from '../lib/compact'
import { emptyHistory, summary } from '../lib/derive'
import { flowParts, laneNames, stagesOf, visibleLanes } from '../lib/flow'
import { newModel, reduce, unhide } from '../lib/model'
import type { Ev } from '../lib/model'
import { place } from '../lib/office'
import { COMMANDS, report } from '../lib/sections'

const T0 = 1_700_000_000_000
const H = emptyHistory()
const CFG = { alerts: true, quotaWarn: 80, ctxWarn: 85, strict: true }

/** n agents launched one after another; the last `live` of them are still working. */
function scenario(n: number, live: number, type = (i: number) => (i === 1 ? 'mp-prev-reviewer' : 'mp-ref-lens')) {
  const evs: Ev[] = [{ k: 'request.start', t: T0, text: 'plan the panel' }, { k: 'turn.start', t: T0 + 1 }]
  for (let i = 0; i < n; i++) {
    const id = `a${i}`
    evs.push({ k: 'spawn', t: T0 + 100 + i * 3000, agentId: id, type: type(i), desc: 'd', prompt: 'p' })
    evs.push({ k: 'agent.start', t: T0 + 200 + i * 3000, agentId: id, type: type(i) })
    evs.push({ k: 'tool.start', t: T0 + 300 + i * 3000, id: `t${i}`, tool: 'Read', key: `k${i}`, summary: 'file' })
    if (i < n - live) evs.push({ k: 'report', t: T0 + 2500 + i * 3000, agentId: id, type: type(i), status: 'completed', text: 'ok' })
  }
  return evs.reduce((a, e) => reduce(a, e, CFG), newModel('s', T0))
}

test('progress is steps finished out of steps launched: never 100% while an agent is still working', () => {
  const now = T0 + 60_000
  const s = summary(scenario(10, 1), now, H)
  expect(s.pct).toBeLessThan(100)
  expect(s.pct).toBeGreaterThanOrEqual(85)
  // one finished and one working reads about half, not "100%"
  expect(summary(scenario(2, 1), now, H).pct).toBeLessThanOrEqual(60)
  // it grows as agents finish
  const a = summary(scenario(6, 5), now, H).pct ?? 0
  const b = summary(scenario(6, 2), now, H).pct ?? 0
  expect(b).toBeGreaterThan(a)
})

test('progress reaches 100% only when the request has ended and nothing is live', () => {
  const evs: Ev[] = [
    { k: 'request.start', t: T0, text: 'x' },
    { k: 'spawn', t: T0 + 1, agentId: 'a', type: 'Explore', desc: 'd', prompt: 'p' },
    { k: 'report', t: T0 + 2, agentId: 'a', type: 'Explore', status: 'completed', text: 'ok' },
  ]
  let m = evs.reduce((a, e) => reduce(a, e, CFG), newModel('s', T0))
  expect(summary(m, T0 + 10, H).pct).toBeLessThan(100)
  m = reduce(m, { k: 'turn.end', t: T0 + 5, turnId: 'm1', durationMs: 5, reason: 'answer' }, CFG)
  expect(summary(m, T0 + 10, H).pct).toBe(100)
})

test('each agent is its own lane, repeated names are numbered, and the stages follow the agent', () => {
  const m = scenario(10, 1)
  const input = officeInput(m, T0 + 60_000, H)
  const placed = place(input.people, T0 + 60_000)
  const names = laneNames(placed)
  const lens = placed.filter(p => p.name === 'Mp ref lens' || p.name.toLowerCase() === 'mp ref lens')
  expect(lens.length).toBe(9)
  expect(new Set(lens.map(p => names[p.id])).size).toBe(9)
  expect(names[lens[0]!.id]).toMatch(/#1$/)
  expect(names[lens[8]!.id]).toMatch(/#9$/)
  // the one reviewer has a plain name
  expect(Object.values(names).some(n => /reviewer$/i.test(n))).toBe(true)

  const working = placed.find(p => p.status === 'running')!
  expect(stagesOf(working)).toEqual(['done', 'done', 'now', 'todo'])
  const done = placed.find(p => p.status === 'completed')!
  expect(stagesOf(done)).toEqual(['done', 'done', 'done', 'done'])
  expect(stagesOf({ isMain: false, status: 'starting', handoff: 'dispatched' })).toEqual(['done', 'now', 'todo', 'todo'])
  expect(stagesOf({ isMain: false, status: 'failed', handoff: 'acknowledged' })).toEqual(['done', 'done', 'bad', 'todo'])
  expect(stagesOf({ isMain: false, status: 'running', blocked: 'waiting for permission', handoff: 'acknowledged' })[2]).toBe('warn')
  expect(stagesOf({ isMain: false, status: 'failed', handoff: 'refused' })[0]).toBe('bad')
})

test('old finished lanes fold into one row; every live agent stays visible, in launch order', () => {
  const m = scenario(30, 2)
  const placed = place(officeInput(m, T0 + 200_000, H).people, T0 + 200_000)
  const { shown, hidden } = visibleLanes(placed, 8)
  expect(shown.length).toBe(8)
  expect(hidden).toBe(22)
  expect(shown.filter(p => p.status === 'running').length).toBe(2)
  const order = shown.map(p => Number(p.id.slice(1)))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  // never more than the limit even when many are live
  expect(visibleLanes(place(officeInput(scenario(20, 20), T0 + 90_000, H).people, T0 + 90_000), 8).shown.length).toBe(8)
})

test('the pipeline parts are three independent SVGs that stay well-formed and bounded', () => {
  const now = T0 + 60_000
  const parts = flowParts(officeInput(scenario(60, 3), now, H), now)
  expect(parts.map(p => p.id)).toEqual(['header', 'lanes', 'comms'])
  for (const p of parts) {
    expect((p.svg.match(/<svg/g) ?? []).length).toBe(1)
    expect((p.svg.match(/<\/svg>/g) ?? []).length).toBe(1)
    expect(p.svg.length).toBeLessThan(80_000)
    expect(p.svg.includes('<script')).toBe(false)
    expect(/ on[a-z]+=/.test(p.svg)).toBe(false)
  }
  // animations can be switched off, and the view still draws
  expect(flowParts(officeInput(scenario(5, 2), now, H), now, false).every(p => !/<animate/.test(p.svg))).toBe(true)
  // an empty session explains itself
  expect(flowParts(officeInput(newModel('s', T0), now, H), now)[1]!.svg).toContain('No agents launched yet')
})

test('strict mode shows clean labels, never "(private)"', () => {
  const m = scenario(4, 1)
  const now = T0 + 30_000
  const input = officeInput(m, now, H)
  const svg = flowParts(input, now).map(p => p.svg).join('')
  expect(svg.includes('(private)')).toBe(false)
  expect(input.stats.request).toBe('Request #1')
  for (const c of COMMANDS) {
    const text = unhide(report(c.name, m, now, H))
    expect(text.includes('(private)')).toBe(false)
  }
  expect(unhide('finished Read: (private)')).toBe('finished Read')
  expect(unhide('main → mp-planner: (private)')).toBe('main → mp-planner')
  expect(unhide('(private)')).toBe('')
  expect(unhide('nothing hidden here')).toBe('nothing hidden here')
})

// ---------------------------------------------------------------- parallel agents

/** Five agents launched in the same instant, three of the same type, then interleaved tool calls and finishes in any order. */
function parallel() {
  const types = ['Explore', 'Explore', 'Explore', 'Plan', 'general-purpose']
  const evs: Ev[] = [{ k: 'request.start', t: T0, text: 'do five things' }, { k: 'turn.start', t: T0 + 1 }]
  types.forEach((ty, i) => evs.push({ k: 'spawn', t: T0 + 10 + i, agentId: `p${i}`, type: ty, desc: 'd', prompt: 'p' }))
  types.forEach((ty, i) => evs.push({ k: 'agent.start', t: T0 + 100 + i, agentId: `p${i}`, type: ty }))
  // every agent runs its own tool at the same time
  const tools = ['Read', 'Grep', 'Glob', 'WebFetch', 'Bash']
  types.forEach((_, i) => evs.push({ k: 'tool.start', t: T0 + 200 + i, id: `u${i}`, tool: tools[i]!, key: `k${i}`, summary: `target-${i}`, agentId: `p${i}` }))
  return { evs, types, tools }
}

test('parallel agents: every tool call is credited to the agent that made it, not to the main chat', () => {
  const { evs, tools } = parallel()
  const m = evs.reduce((a, e) => reduce(a, e, { ...CFG, strict: false }), newModel('s', T0))
  expect(m.order.length).toBe(6)
  tools.forEach((tool, i) => {
    const a = m.agents[`p${i}`]!
    expect(a.activity).toContain(tool)
    expect(a.activity).toContain(`target-${i}`)
    expect(a.activitySrc).toBe('actual')
  })
  expect(Object.keys(m.running).length).toBe(5)
  // the manager is waiting on all five and its own line says so, untouched by the agents' tools
  expect(m.agents.main?.activity).toContain('waiting on 5')
  expect(m.agents.main?.activity).not.toContain('target-')
})

test('parallel agents finish in any order: each lane keeps its own state, tokens and stage', () => {
  const { evs, types } = parallel()
  const finish = [3, 0, 4] // out of launch order
  finish.forEach((i, k) => {
    evs.push({ k: 'tool.end', t: T0 + 300 + k, id: `u${i}`, tool: 'Read', agentId: `p${i}`, ok: true, key: 'k', summary: 's' })
    evs.push({ k: 'turn.end', t: T0 + 310 + k, agentId: `p${i}`, turnId: `turn-${i}`, durationMs: 1, reason: 'answer', usage: { i: 100 * (i + 1), o: 0, cr: 0, cc: 0, model: 'sonnet' } })
    evs.push({ k: 'report', t: T0 + 320 + k, agentId: `p${i}`, type: types[i]!, status: 'completed', text: 'ok' })
  })
  const m = evs.reduce((a, e) => reduce(a, e, CFG), newModel('s', T0))
  const now = T0 + 5000
  expect(['p0', 'p3', 'p4'].every(id => m.agents[id]?.status === 'completed')).toBe(true)
  expect(['p1', 'p2'].every(id => m.agents[id]?.status === 'running')).toBe(true)
  expect(m.agents.p3?.tokens.i).toBe(400)
  expect(m.agents.p0?.tokens.i).toBe(100)
  expect(m.agents.p1?.tokens.i).toBe(0)
  expect(m.tokens.total.i).toBe(100 + 400 + 500)
  // the manager is still waiting on the two that are running
  expect(m.agents.main?.activity).toContain('waiting on 2')
  const s = summary(m, now, H)
  expect(s.active).toBe(2)
  expect(s.completed).toBe(3)
  expect(s.pct).toBeLessThan(100)
  // each handoff was matched to its own agent
  for (const id of ['p0', 'p3', 'p4']) expect(m.handoffs.find(h => h.to === id)?.status).toBe('returned')
  for (const id of ['p1', 'p2']) expect(m.handoffs.find(h => h.to === id)?.status).not.toBe('returned')
})

test('parallel agents: the pipeline shows each one in its own lane, marks the run as parallel and stays bounded', () => {
  const { evs } = parallel()
  const m = evs.reduce((a, e) => reduce(a, e, CFG), newModel('s', T0))
  const now = T0 + 5000
  const parts = flowParts(officeInput(m, now, H), now)
  const lanes = parts.find(p => p.id === 'lanes')!.svg
  expect(lanes).toContain('5 agents running in parallel')
  expect(parts.find(p => p.id === 'header')!.svg).toContain('5 agents working in parallel')
  const placed = place(officeInput(m, now, H).people, now)
  const names = laneNames(placed)
  const explorers = placed.filter(p => p.type === 'Explore')
  expect(new Set(explorers.map(p => names[p.id])).size).toBe(3)
  // twelve at once: eight lanes, and the row above them says four are still running and not shown
  const many = Array.from({ length: 12 }, (_, i): Ev[] => [
    { k: 'spawn', t: T0 + 10 + i, agentId: `q${i}`, type: 'Explore', desc: 'd', prompt: 'p' },
    { k: 'agent.start', t: T0 + 100 + i, agentId: `q${i}`, type: 'Explore' },
  ]).flat()
  const big = many.reduce((a, e) => reduce(a, e, CFG), newModel('s', T0))
  const bigParts = flowParts(officeInput(big, now, H), now)
  expect(bigParts.find(p => p.id === 'lanes')!.svg).toContain('4 of them still running')
  expect(visibleLanes(place(officeInput(big, now, H).people, now)).shown.length).toBe(8)
})

test('a tool call from an agent that has not started yet creates nothing, and a host without agent ids still works', () => {
  let m = newModel('s', T0)
  m = reduce(m, { k: 'tool.start', t: T0 + 1, id: 'x', tool: 'Read', key: 'k', summary: 's', agentId: 'ghost' }, CFG)
  expect(m.order).toEqual(['main'])
  // no agent id and exactly one live agent while the manager waits: attributed to it, and labelled as inferred
  m = reduce(m, { k: 'spawn', t: T0 + 2, agentId: 'solo', type: 'Explore', desc: 'd', prompt: 'p' }, CFG)
  m = reduce(m, { k: 'agent.start', t: T0 + 3, agentId: 'solo', type: 'Explore' }, CFG)
  m = reduce(m, { k: 'turn.start', t: T0 + 4 }, CFG)
  m = reduce(m, { k: 'tool.start', t: T0 + 5, id: 'y', tool: 'Grep', key: 'k2', summary: 'thing' }, { ...CFG, strict: false })
  expect(m.agents.solo?.activity).toContain('Grep')
  expect(m.agents.solo?.activitySrc).toBe('inferred')
})
