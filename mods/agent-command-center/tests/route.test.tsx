// The route map view: stations, couriers, themes, bounds, and the pane's view and look switches.
import { expect, test } from 'claude-code/testing'
import { officeInput } from '../lib/compact'
import { emptyHistory } from '../lib/derive'
import { newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'
import { mix, phaseOf, routeParts, stationPos } from '../lib/route'

const T0 = 1_700_000_000_000
const H = emptyHistory()
const CFG = { alerts: true, quotaWarn: 80, ctxWarn: 85, strict: false }

/** n agents launched in order; the first `done` have reported, the next `started` are working, the rest are only handed off. */
function scenario(n: number, done: number, started: number, type = (i: number) => `agent${i}`) {
  const evs: Ev[] = [{ k: 'request.start', t: T0, text: 'task' }, { k: 'turn.start', t: T0 + 1 }]
  for (let i = 0; i < n; i++) {
    const id = `a${i}`
    evs.push({ k: 'spawn', t: T0 + 100 + i * 1000, agentId: id, type: type(i), desc: 'd', prompt: 'p' })
    if (i < done + started) evs.push({ k: 'agent.start', t: T0 + 200 + i * 1000, agentId: id, type: type(i) })
    if (i < done) evs.push({ k: 'report', t: T0 + 900 + i * 1000, agentId: id, type: type(i), status: 'completed', text: 'ok' })
  }
  return evs.reduce((a, e) => reduce(a, e, CFG), newModel('s', T0))
}
const parts = (m: ReturnType<typeof scenario>, theme: 'light' | 'dark' = 'light', animate = true) => routeParts(officeInput(m, T0 + 30_000, H), T0 + 30_000, animate, theme)

test('four independent, well-formed SVG parts, in both looks, with no stray values', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const m of [scenario(0, 0, 0), scenario(1, 0, 1), scenario(6, 2, 2), scenario(12, 4, 3)]) {
      const ps = parts(m, theme)
      expect(ps.map(p => p.id)).toEqual(['rhead', 'rmap', 'rcards', 'rfeed'])
      for (const p of ps) {
        expect((p.svg.match(/<svg\b/g) ?? []).length).toBe(1)
        expect((p.svg.match(/<\/svg>/g) ?? []).length).toBe(1)
        expect(/NaN|undefined|\[object|Infinity/.test(p.svg)).toBe(false)
        expect(p.h).toBeGreaterThan(20)
        expect(p.h).toBeLessThan(600)
        expect(p.svg.length).toBeLessThan(120_000)
      }
    }
  }
})

test('the two looks differ, and the dark one keeps the dark surface', () => {
  const m = scenario(3, 1, 1)
  const light = parts(m, 'light')[1]?.svg ?? ''
  const dark = parts(m, 'dark')[1]?.svg ?? ''
  expect(light).not.toBe(dark)
  expect(parts(m, 'light')[0]?.svg.includes('#f6f0df')).toBe(true)
  expect(parts(m, 'dark')[0]?.svg.includes('#0b0d14')).toBe(true)
})

test('one station per agent in launch order, numbered, and a turn after five stations', () => {
  const few = parts(scenario(3, 0, 3))[1]?.svg ?? ''
  for (const n of ['agent0', 'agent1', 'agent2']) expect(few.includes(n)).toBe(true)
  // up to five stops on one row, then the route turns back along a second row, right to left
  expect(stationPos(1, 5).y).toBe(stationPos(4, 5).y)
  expect(stationPos(5, 9).y).toBeGreaterThan(stationPos(4, 9).y)
  expect(stationPos(5, 9).x).toBe(stationPos(4, 9).x)
  expect(stationPos(6, 9).x).toBeLessThan(stationPos(5, 9).x)
  const many = parts(scenario(8, 3, 3))[1]
  expect(many?.h).toBeGreaterThan(300)
})

test('every handoff still on its way gets its own courier; parked couriers do not move', () => {
  // two agents handed a task and not started yet: two animated couriers
  const pending = parts(scenario(4, 1, 1))[1]?.svg ?? ''
  expect((pending.match(/<animateMotion\b/g) ?? []).length).toBe(2)
  expect(pending.includes('handed off')).toBe(true)
  // nothing on its way: one parked courier, saying what it waits for
  const busy = parts(scenario(3, 1, 2))[1]?.svg ?? ''
  expect(busy.includes('<animateMotion')).toBe(false)
  expect(/Waiting on 2 agents/.test(busy)).toBe(true)
  const finished = parts(scenario(3, 3, 0))[1]?.svg ?? ''
  expect(/All reports delivered/.test(finished)).toBe(true)
  expect(/No agents yet/.test(parts(scenario(0, 0, 0))[1]?.svg ?? '')).toBe(true)
  // at most three couriers however many handoffs are pending
  const flood = parts(scenario(8, 0, 0))[1]?.svg ?? ''
  expect((flood.match(/<animateMotion\b/g) ?? []).length).toBeLessThanOrEqual(3)
})

test('animation off removes every animation element, including the couriers', () => {
  const still = parts(scenario(5, 1, 1), 'light', false)
  for (const p of still) expect(/<animate/.test(p.svg)).toBe(false)
})

test('agents working in parallel are counted, each with its own card, and the state badges are right', () => {
  const m = scenario(4, 1, 3)
  const ps = parts(m)
  expect(ps[0]?.svg.includes('3 agents in parallel')).toBe(true)
  expect((ps[2]?.svg.match(/WORKING/g) ?? []).length).toBe(3)
  expect(phaseOf({ status: 'completed', handoff: 'returned' })).toBe('done')
  expect(phaseOf({ status: 'running', handoff: 'acknowledged' })).toBe('work')
  expect(phaseOf({ status: 'starting', handoff: 'dispatched' })).toBe('sent')
  expect(phaseOf({ status: 'failed', handoff: 'acknowledged' })).toBe('bad')
  expect(phaseOf({ status: 'running', handoff: 'acknowledged', blocked: 'permission' })).toBe('warn')
})

test('hostile names and 200 agents stay escaped and bounded', () => {
  const m = scenario(200, 150, 30, i => (i === 0 ? '<script>alert(1)</script>"&' : `a${i}`))
  for (const p of parts(m)) {
    expect(p.svg.includes('<script')).toBe(false)
    expect(p.svg.length).toBeLessThan(120_000)
  }
  const map = parts(m)[1]
  expect(map?.h).toBeLessThan(400)
})

test('mix blends two colours', () => {
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(mix('#ff0000', '#ff0000', 0.7)).toBe('#ff0000')
})

const PANE = {
  plugin: 'agent-command-center',
  component: 'Pane',
  requestId: 'agent-command-center',
  props: { title: 'Agent Command Center', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane switches between pipeline, route map and office, and between the two looks', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-r' }) as never)
  let clock = T0
  on('clock.now', () => ({ value: (clock += 500) }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('classic.SubagentStart', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.SubagentStart({ agent_id: 'r1', agent_type: 'Explore', session_id: 'sess-r' })

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /Pipeline/ })).toBeTruthy()
  expect(await desktop.find({ type: 'Text', text: /Route map/ })).toBeTruthy()
  // no look switch outside the route map
  expect(await desktop.find({ type: 'Text', text: /look/ })).toBeUndefined()
  await desktop.press({ key: 'v-route' })
  expect(await desktop.find({ type: 'Text', text: /Each station is one real agent/ })).toBeTruthy()
  expect(await desktop.find({ type: 'Text', text: /Switch to dark look/ })).toBeTruthy()
  await desktop.press({ key: 'b-theme' })
  expect(await desktop.find({ type: 'Text', text: /Switch to light look/ })).toBeTruthy()
  await desktop.press({ key: 'v-office' })
  expect(await desktop.find({ type: 'Text', text: /Scene = visual metaphor/ })).toBeTruthy()
  expect(await desktop.find({ type: 'Text', text: /look/ })).toBeUndefined()
  await desktop.press({ key: 'v-pipeline' })
  expect(await desktop.find({ type: 'Text', text: /Each lane is one real agent/ })).toBeTruthy()
  await desktop.unmount()

  // the terminal has no graphics: no view buttons, text only
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /Route map/ })).toBeUndefined()
  await term.unmount()
})
