// Regression tests for the independent review of 0.4.0 (one test per finding).
import { expect, test } from 'claude-code/testing'
import { emptyHistory, learn } from '../lib/derive'
import { newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'
import { COMMANDS, report } from '../lib/sections'

const T0 = 1_700_000_000_000
const run = (evs: Ev[], strict = false) => evs.reduce((a, e) => reduce(a, e, { alerts: true, quotaWarn: 80, ctxWarn: 85, strict }), newModel('s', T0))

test('real ids that look random are kept apart: every turn is counted, tools and models stay distinct', () => {
  for (const strict of [false, true]) {
    const m = run([
      { k: 'turn.end', t: T0 + 1, turnId: '3f2b9c1e-8d4a-4f7b-9e2c-1a5d6b7c8e9f', durationMs: 1, reason: 'answer', usage: { i: 100, o: 0, cr: 0, cc: 0, model: 'claude-sonnet-4-5-20250929' } },
      { k: 'turn.end', t: T0 + 2, turnId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', durationMs: 1, reason: 'answer', usage: { i: 100, o: 0, cr: 0, cc: 0, model: 'claude-opus-4-1-20250805' } },
      { k: 'tool.start', t: T0 + 3, id: 'toolu_01A09q90qw90lq917835lq9X', tool: 'Read', key: 'Read|a', summary: 'a' },
      { k: 'tool.start', t: T0 + 4, id: 'toolu_01B77zz88yy99xx00ww11vv2Y', tool: 'Read', key: 'Read|b', summary: 'b' },
    ], strict)
    expect(m.tokens.total.i).toBe(200)
    expect(Object.keys(m.tokens.byModel).sort()).toEqual(['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929'])
    expect(Object.keys(m.running).length).toBe(2)
  }
})

test('an id that carries a real key shape is never stored, but stays distinct', () => {
  const k1 = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123'
  const k2 = 'sk-ant-' + 'api03-zyxwvutsrqponmlkjihgfedcba9876'
  const m = run([
    { k: 'agent.start', t: T0 + 1, agentId: k1, type: 'Explore' },
    { k: 'agent.start', t: T0 + 2, agentId: k2, type: 'Explore' },
  ])
  const j = JSON.stringify(m)
  expect(j.includes('abcdefghijklmnop')).toBe(false)
  expect(j.includes('zyxwvutsrqponml')).toBe(false)
  expect(m.order.length).toBe(3)
})

test('tool inputs are kept only as a keyed fingerprint without their length; retries still match', () => {
  const ev = (t: number, ok: boolean): Ev => ({ k: 'tool.end', t, id: `u${t}`, tool: 'Bash', ok, key: 'Bash|unzip -P 4711 backup.zip', summary: 'x' })
  const m = run([ev(T0 + 1, false), { k: 'tool.start', t: T0 + 2, id: 'u9', tool: 'Bash', key: 'Bash|unzip -P 4711 backup.zip', summary: 'x' }])
  expect(m.retries.count).toBe(1)
  const keys = JSON.stringify([m.failedTools, m.running])
  expect(keys.includes('4711')).toBe(false)
  expect(/:\d+"/.test(keys)).toBe(false)
  // the unkeyed FNV-1a of the input (what an attacker could compute) is not what is stored
  let h = 0x811c9dc5
  for (const c of 'Bash|unzip -P 4711 backup.zip') h = Math.imul(h ^ c.charCodeAt(0), 0x01000193)
  expect(keys.includes((h >>> 0).toString(36))).toBe(false)
})

test('a refused spawn is never taken over by a later agent, and a spawn recorded after its start is acknowledged', () => {
  const m = run([
    { k: 'spawn', t: T0 + 1, type: 'Explore', desc: 'd', prompt: 'p', denied: 'not allowed' },
    { k: 'agent.start', t: T0 + 2, agentId: 'a77', type: 'Explore' },
    { k: 'spawn', t: T0 + 3, agentId: 'a77', type: 'Explore', desc: 'd', prompt: 'p' },
  ])
  const refused = m.handoffs.find(h => h.status === 'refused')
  expect(refused?.to.startsWith('pending-')).toBe(true)
  const real = m.handoffs.find(h => h.to === 'a77')
  expect(real?.status).toBe('acknowledged')
  expect(m.agents.a77?.status).toBe('running')
  expect(m.agents.a77?.endedAt).toBe(undefined)
})

test('handoff ids stay unique past the 80-handoff cap', () => {
  let m = newModel('s', T0)
  for (let i = 0; i < 200; i++) m = reduce(m, { k: 'spawn', t: T0 + i, agentId: `a${i}`, type: 'Explore', desc: 'd', prompt: 'p' })
  expect(new Set(m.handoffs.map(h => h.id)).size).toBe(m.handoffs.length)
})

test('a skill name is only kept in strict mode when the summary is a bare name', () => {
  const m = run([{ k: 'tool.end', t: T0 + 1, id: 'u1', tool: 'Skill', ok: true, key: 'k', summary: 'hunter2 is my bank pin' }], true)
  expect(JSON.stringify(m).includes('hunter2')).toBe(false)
})

test('a cost or context value of the wrong type is dropped, and every report still builds', () => {
  const bad = { k: 'measure', t: T0 + 1, rateLimits: [], costUsd: 'free' as unknown as number, ctxTokens: null as unknown as number, ctxPercent: '90' as unknown as number } as Ev
  const m = run([{ k: 'request.start', t: T0, text: 'x' }, bad])
  expect(m.quota?.costUsd).toBe(undefined)
  expect(m.quota?.ctxPercent).toBe(undefined)
  for (const c of COMMANDS) expect(typeof report(c.name, m, T0 + 5, emptyHistory())).toBe('string')
})

test('history remembers at most 50 agent types', () => {
  let h = emptyHistory()
  for (let i = 0; i < 80; i++) h = learn(h, { agentType: `type${i}`, agentMs: 1000 })
  expect(Object.keys(h.agentMs).length).toBe(50)
  expect(h.agentMs.type79?.length).toBe(1)
})
