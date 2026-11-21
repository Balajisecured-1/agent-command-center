import { expect, test } from 'claude-code/testing'

import { agentEta, emptyHistory, learn, progress, requestEta, requestRuntime, subtasks, sum, summary } from '../lib/derive'
import { MAIN, newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'
import * as S from '../lib/sections'

const T0 = 1_000_000
const run = (evs: Ev[], m = newModel('s1', T0)) => evs.reduce((a, e) => reduce(a, e), m)
const usage = (i: number, o: number, cr: number, cc: number, model = 'claude-sonnet-5-5') => ({ i, o, cr, cc, model })

const spawn = (t: number, id: string, type: string, desc = `${type} task`): Ev => ({ k: 'spawn', t, agentId: id, parentId: undefined, type, desc, prompt: `do ${desc}` })

test('1 main session: request, turn, tokens, runtime', () => {
  const m = run([
    { k: 'request.start', t: T0 + 1000, text: 'build the thing' },
    { k: 'turn.start', t: T0 + 1000 },
    { k: 'turn.end', t: T0 + 9000, turnId: 'a', durationMs: 8000, reason: 'answer', usage: usage(100, 50, 400, 20) },
  ])
  expect(m.request?.n).toBe(1)
  expect(requestRuntime(m, T0 + 20000)).toBe(8000)
  expect(sum(m.tokens.total)).toBe(570)
  expect(m.agents[MAIN]?.activeMs).toBe(8000)
  expect(m.agents[MAIN]?.status).toBe('idle')
})

test('2 five parallel agents are tracked together', () => {
  const evs: Ev[] = [{ k: 'request.start', t: T0, text: 'five-way job' }, { k: 'turn.start', t: T0 }]
  for (let i = 1; i <= 5; i++) evs.push(spawn(T0 + i, `ag${i}`, `worker${i}`))
  for (let i = 1; i <= 5; i++) evs.push({ k: 'agent.start', t: T0 + 100 + i, agentId: `ag${i}`, type: `worker${i}` })
  const m = run(evs)
  const s = summary(m, T0 + 5000, emptyHistory())
  expect(s.total).toBe(5)
  expect(s.active).toBe(5)
  expect(m.handoffs.length).toBe(5)
  expect(m.agents[MAIN]?.status).toBe('waiting')
})

test('3 agent completion + 4 handoff only "returned" when the report arrives', () => {
  let m = run([{ k: 'request.start', t: T0, text: 'x' }, { k: 'turn.start', t: T0 }, spawn(T0 + 10, 'a1', 'Explore')])
  expect(m.handoffs[0]?.status).toBe('dispatched')
  m = reduce(m, { k: 'agent.start', t: T0 + 50, agentId: 'a1', type: 'Explore' })
  expect(m.handoffs[0]?.status).toBe('acknowledged')
  m = reduce(m, { k: 'report', t: T0 + 4050, agentId: 'a1', type: 'Explore', status: 'completed', text: 'found 3 files' })
  expect(m.handoffs[0]?.status).toBe('returned')
  expect(m.handoffs[0]?.output).toBe('found 3 files')
  expect(m.agents['a1']?.status).toBe('completed')
  expect(progress(m, m.agents['a1']!, T0 + 5000, emptyHistory()).pct).toBe(100)
  expect(S.handoffs(m, T0 + 5000).lines.some(l => /CONFIRMED returned/.test(l.text))).toBe(true)
})

test('4 a dispatched handoff is never reported as successful', () => {
  const m = run([spawn(T0, 'a1', 'Plan')])
  const txt = S.handoffs(m, T0 + 10).lines.map(l => l.text).join('\n')
  expect(/NOT yet acknowledged/.test(txt)).toBe(true)
  expect(/CONFIRMED/.test(txt)).toBe(false)
})

test('5 a waiting agent is shown as waiting (permission prompt)', () => {
  let m = run([{ k: 'turn.start', t: T0 }, spawn(T0 + 1, 'a1', 'general-purpose'), { k: 'agent.start', t: T0 + 2, agentId: 'a1', type: 'general-purpose' }, { k: 'turn.start', t: T0 + 3, agentId: 'a1' }])
  m = reduce(m, { k: 'notify', t: T0 + 10, text: 'needs permission', type: 'permission_prompt', agentId: 'a1' })
  expect(m.agents['a1']?.status).toBe('waiting')
  expect(m.agents['a1']?.blocked).toBe('waiting for permission')
  expect(summary(m, T0 + 20, emptyHistory()).blocked).toBe(1)
})

test('6 failed tool + retry: failure recorded, retry inferred and timed', () => {
  let m = run([
    { k: 'tool.start', t: T0, id: 't1', tool: 'Bash', key: 'Bash|npm test', summary: 'npm test' },
    { k: 'tool.end', t: T0 + 2000, id: 't1', tool: 'Bash', ok: false, error: 'exit 1', key: 'Bash|npm test', summary: 'npm test' },
  ])
  expect(m.agents[MAIN]?.toolFails).toBe(1)
  m = reduce(m, { k: 'tool.start', t: T0 + 5000, id: 't2', tool: 'Bash', key: 'Bash|npm test', summary: 'npm test' })
  expect(m.retries.count).toBe(1)
  expect(m.retries.ms).toBe(5000)
  m = reduce(m, { k: 'tool.end', t: T0 + 7000, id: 't2', tool: 'Bash', ok: true, key: 'Bash|npm test', summary: 'npm test' })
  expect(m.agents[MAIN]?.blocked).toBeUndefined()
  expect(m.events.some(e => e.k === 'retry' && e.src === 'inferred')).toBe(true)
})

test('7 token accounting: per agent/model, no double count on repeated turn ids', () => {
  const end = (id: string, ag: string | undefined, u: ReturnType<typeof usage>): Ev => ({ k: 'turn.end', t: T0, agentId: ag, turnId: id, durationMs: 1, reason: 'answer', usage: u })
  const m = run([end('t1', undefined, usage(10, 5, 100, 1)), end('t1', undefined, usage(10, 5, 100, 1)), end('t2', 'a1', usage(20, 10, 0, 0, 'claude-haiku-5-5'))])
  expect(sum(m.tokens.total)).toBe(116 + 30)
  expect(sum(m.tokens.byAgent[MAIN]!)).toBe(116)
  expect(sum(m.tokens.byAgent['a1']!)).toBe(30)
  expect(Object.keys(m.tokens.byModel).length).toBe(2)
  expect(m.tokens.total.cr).toBe(100)
  expect(m.tokens.total.cc).toBe(1)
})

test('8 runtime calculation uses event timestamps', () => {
  const m = run([
    { k: 'request.start', t: T0, text: 'r' },
    { k: 'turn.start', t: T0 },
    spawn(T0 + 1000, 'a1', 'Explore'),
    { k: 'agent.start', t: T0 + 1500, agentId: 'a1', type: 'Explore' },
    { k: 'report', t: T0 + 31500, agentId: 'a1', type: 'Explore', status: 'completed', text: 'ok' },
    { k: 'turn.end', t: T0 + 40000, turnId: 'm1', durationMs: 40000, reason: 'answer' },
  ])
  const a = m.agents['a1']!
  expect(a.endedAt! - a.startedAt).toBe(30500)
  expect(requestRuntime(m, T0 + 999999)).toBe(40000)
  expect(S.dur(30500)).toBe('31s')
  expect(S.dur(83000)).toBe('1m23s')
})

test('9 ETA recalculates as events arrive and widens when uncertain', () => {
  let hist = emptyHistory()
  for (const ms of [40000, 50000, 60000]) hist = learn(hist, { agentType: 'Explore', agentMs: ms })
  hist = learn(hist, { finalizeMs: 8000 })
  let m = run([{ k: 'request.start', t: T0, text: 'r' }, { k: 'turn.start', t: T0 }, spawn(T0, 'a1', 'Explore'), { k: 'agent.start', t: T0, agentId: 'a1', type: 'Explore' }])
  const e1 = requestEta(m, T0 + 10000, hist)!
  expect(e1.exp).toBe(50000 - 10000 + 8000)
  expect(e1.opt < e1.exp && e1.exp < e1.cons).toBe(true)
  expect(e1.confidence).toBe('low')
  const e2 = requestEta(m, T0 + 30000, hist)!
  expect(e2.exp).toBe(20000 + 8000)
  m = reduce(m, { k: 'tool.end', t: T0 + 30000, id: 'x', tool: 'TodoWrite', agentId: 'a1', ok: true, key: 'k', summary: '', todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'pending' }] })
  expect(subtasks(m, m.agents['a1']!).done).toBe(2)
  const ag = agentEta(m, m.agents['a1']!, T0 + 30000, hist)!
  expect(ag.exp).toBe(15000)
  expect(progress(m, m.agents['a1']!, T0 + 30000, hist).pct).toBe(67)
  expect(agentEta(m, { ...m.agents['a1']!, type: 'Unseen', todos: undefined }, T0 + 30000, hist)).toBe(null)
})

test('10 persisted state survives a JSON round trip (reload); a new session id starts fresh', () => {
  const m = run([{ k: 'request.start', t: T0, text: 'r' }, spawn(T0, 'a1', 'Explore'), { k: 'turn.end', t: T0, turnId: 'z', durationMs: 1, reason: 'answer', usage: usage(1, 2, 3, 4) }])
  const back = JSON.parse(JSON.stringify(m))
  const m2 = reduce(back, { k: 'tool.start', t: T0 + 5, id: 'q', tool: 'Read', key: 'Read|f', summary: 'f' })
  expect(sum(m2.tokens.total)).toBe(10)
  expect(m2.handoffs.length).toBe(1)
  expect(newModel('s2', T0 + 99).sessionStart).toBe(T0 + 99)
  expect(Object.keys(newModel('s2', 1).agents)).toEqual([MAIN])
})

test('quota: unavailable honestly, real windows when given', () => {
  let m = newModel('s', T0)
  expect(S.quota(m, T0).lines.some(l => /Weekly.*unavailable/.test(l.text))).toBe(true)
  m = reduce(m, { k: 'measure', t: T0, rateLimits: [{ kind: 'seven_day', percentUsed: 42.5, resetsAt: '2026-11-25T00:00:00Z' }, { kind: 'five_hour', percentUsed: 12 }], ctxPercent: 31, ctxTokens: 62000, ctxWindow: 200000 })
  const txt = S.quota(m, T0 + 1).lines.map(l => l.text).join('\n')
  expect(/Weekly \(7-day\) quota: 42.5% used · 57.5% left/.test(txt)).toBe(true)
  expect(/Session \(5-hour\) quota: 12% used/.test(txt)).toBe(true)
  expect(/Context window: 31%/.test(txt)).toBe(true)
})

test('all 14 commands render for an empty and a busy model', () => {
  const busy = run([{ k: 'request.start', t: T0, text: 'job' }, { k: 'turn.start', t: T0 }, spawn(T0, 'a1', 'Explore'), { k: 'compact', t: T0 + 1, phase: 'pre', trigger: 'auto' }, { k: 'model', t: T0 + 2, from: 'a', to: 'b' }, { k: 'interrupt', t: T0 + 3, running: true }])
  expect(S.COMMANDS.length).toBe(14)
  for (const m of [newModel('s', T0), busy]) {
    for (const c of S.COMMANDS) {
      const out = S.report(c.name, m, T0 + 60000, emptyHistory())
      expect(typeof out).toBe('string')
      expect(out.length > 0).toBe(true)
    }
  }
  expect(busy.compactions.count).toBe(1)
  expect(busy.models.changes.length).toBe(1)
  expect(busy.interruptions).toBe(1)
})
