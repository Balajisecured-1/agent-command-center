import { expect, test } from 'claude-code/testing'
import { COMMANDS, report } from '../lib/sections'
import { officeSvg } from '../lib/office'
import { officeInput } from '../lib/compact'
import { HIDDEN, MAIN, newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'
import type { Model } from '../types'

const T0 = 1_700_000_000_000
// Things no pattern can recognise as secret: a passphrase in plain words, a short PIN, a private file path.
const PLANTED = ['correct horse battery staple', 'pin 4711', 'C:/Users/alice/payroll-2026.xlsx', 'hunter2']
const leaks = (s: string) => PLANTED.filter(p => s.toLowerCase().includes(p.toLowerCase()))

const EVENTS: Ev[] = [
  { k: 'request.start', t: T0, text: 'my passphrase is correct horse battery staple, pin 4711' },
  { k: 'title', t: T0 + 1, title: 'payroll for hunter2' },
  { k: 'turn.start', t: T0 + 2 },
  { k: 'spawn', t: T0 + 3, agentId: 'a1', type: 'Explore', name: 'scout', desc: 'open C:/Users/alice/payroll-2026.xlsx', prompt: 'password hunter2' },
  { k: 'agent.start', t: T0 + 4, agentId: 'a1', type: 'Explore' },
  { k: 'tool.start', t: T0 + 5, id: 't1', tool: 'Bash', key: 'Bash|echo correct horse battery staple', summary: 'echo correct horse battery staple' },
  { k: 'tool.end', t: T0 + 6, id: 't1', tool: 'Bash', agentId: 'a1', ok: false, key: 'Bash|echo correct horse battery staple', summary: 'echo correct horse battery staple', error: 'denied: hunter2' },
  { k: 'tool.start', t: T0 + 7, id: 't2', tool: 'Bash', key: 'Bash|echo correct horse battery staple', summary: 'echo correct horse battery staple' },
  { k: 'tool.end', t: T0 + 8, id: 't3', tool: 'TodoWrite', agentId: 'a1', ok: true, key: 'TodoWrite|x', summary: 'x', todos: [{ content: 'email pin 4711', status: 'in_progress' }] },
  { k: 'tool.end', t: T0 + 9, id: 't4', tool: 'Skill', ok: true, key: 'Skill|dataviz', summary: 'dataviz' },
  { k: 'task.created', t: T0 + 10, id: 'k1', subject: 'send C:/Users/alice/payroll-2026.xlsx' },
  { k: 'notify', t: T0 + 11, text: 'pin 4711 needed' },
  { k: 'report', t: T0 + 12, agentId: 'a1', type: 'Explore', status: 'completed', text: 'found correct horse battery staple' },
  { k: 'stopfail', t: T0 + 13, error: 'hunter2 rejected' },
  { k: 'turn.end', t: T0 + 14, turnId: 'm1', durationMs: 14, reason: 'answer', usage: { i: 10, o: 5, cr: 0, cc: 0, model: 'opus' } },
]
const STRICT = { alerts: true, quotaWarn: 80, ctxWarn: 85, strict: true }

test('strict privacy: nothing typed, run or returned is recorded, in the model, any report or the office', async () => {
  const m = EVENTS.reduce((a, e) => reduce(a, e, STRICT), newModel('s', T0))
  expect(leaks(JSON.stringify(m))).toEqual([])
  for (const c of COMMANDS) expect(leaks(report(c.name, m, T0 + 20, { agentMs: {}, finalizeMs: [], requestMs: [] }))).toEqual([])
  expect(leaks(officeSvg(officeInput(m, T0 + 20, { agentMs: {}, finalizeMs: [], requestMs: [] }), {}, T0 + 20))).toEqual([])
  // still useful: counts, names, the retry (matched by fingerprint, not by the command) and the skill name
  expect(m.requests).toBe(1)
  expect(m.agents.a1?.type).toBe('Explore')
  expect(m.retries.count).toBe(1)
  expect(m.agents[MAIN]?.skill).toBe('dataviz')
  expect(m.request?.text).toBe(HIDDEN)
  expect(m.tokens.total.i).toBe(10)
})

test('standard privacy still records text (opt-in), but tool inputs are only kept as a fingerprint', () => {
  const m = EVENTS.reduce((a, e) => reduce(a, e), newModel('s', T0))
  expect(m.request?.text).toContain('battery staple')
  expect(JSON.stringify(m.failedTools)).not.toContain('echo')
})

test('the hooks run private by default when no option is set', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-p' }) as never)
  let clock = T0
  on('clock.now', () => ({ value: (clock += 1000) }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('classic.PostToolUse', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'my passphrase is correct horse battery staple' } as never)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'echo pin 4711' }, tool_response: {}, tool_use_id: 'u1', duration_ms: 3, session_id: 'sess-p' })
  let all = ''
  for (const c of COMMANDS) {
    const r = (await $.command.run({ command: c.name, args: '' } as never)) as { text?: string }
    all += r?.text ?? ''
  }
  expect(all.length > 0).toBe(true)
  expect(leaks(all)).toEqual([])
})

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as object)) deepFreeze(v)
  }
  return o
}

test('the reducer is pure: a frozen previous model is never written to, for every event kind', () => {
  let m: Model = newModel('s', T0)
  const all: Ev[] = [
    ...EVENTS,
    { k: 'session.start', t: T0 + 20, sessionId: 's' },
    { k: 'spawn', t: T0 + 21, type: 'Plan', desc: 'd', prompt: 'p' },
    { k: 'agent.start', t: T0 + 22, agentId: 'a2', type: 'Plan' },
    { k: 'turn.start', t: T0 + 23, agentId: 'a2' },
    { k: 'turn.end', t: T0 + 24, agentId: 'a2', turnId: 'x2', durationMs: 1, reason: 'answer', usage: { i: 1, o: 1, cr: 1, cc: 1, model: 'sonnet' } },
    { k: 'agent.stop', t: T0 + 25, agentId: 'a2', type: 'Plan' },
    { k: 'task.completed', t: T0 + 26, id: 'k1', subject: 's' },
    { k: 'idle', t: T0 + 27, who: 'a1' },
    { k: 'model', t: T0 + 28, from: 'opus', to: 'sonnet' },
    { k: 'compact', t: T0 + 29, phase: 'pre', trigger: 'auto' },
    { k: 'compact', t: T0 + 30, phase: 'post', trigger: 'auto' },
    { k: 'interrupt', t: T0 + 31, running: true },
    { k: 'measure', t: T0 + 32, rateLimits: [{ kind: 'five_hour', percentUsed: 97 }], ctxPercent: 90, ctxTokens: 9, ctxWindow: 10, costUsd: 1 },
    { k: 'notify', t: T0 + 33, text: 'perm', type: 'permission_prompt', agentId: 'a1' },
    { k: 'drain', t: T0 + 34 },
    { k: 'request.start', t: T0 + 35, text: 'again' },
    { k: 'session.end', t: T0 + 36, reason: 'exit' },
  ]
  for (const e of all) {
    const before = JSON.stringify(deepFreeze(m))
    const next = reduce(m, e)
    expect(JSON.stringify(m)).toBe(before)
    m = next
  }
  expect(m.compactions.count).toBe(1)
})

test('speed: 5,000 distinct agents and 25,000 events reduce fast (a deep copy per event took about 8 s)', () => {
  let m: Model = newModel('s', T0)
  const t0 = Date.now()
  for (let i = 0; i < 5_000; i++) m = reduce(m, { k: 'spawn', t: T0 + i, agentId: `a${i}`, type: 'Explore', desc: 'd', prompt: 'p' })
  for (let i = 0; i < 20_000; i++) m = reduce(m, { k: 'tool.start', t: T0 + 10_000 + i, id: `t${i % 500}`, tool: 'Read', key: `Read|${i}`, summary: 's' })
  const ms = Date.now() - t0
  expect(ms).toBeLessThan(6000) // ~2 s alone; test files run in parallel, so a loaded machine needs headroom
  expect(m.order.length).toBeLessThanOrEqual(120)
})

test('prompts the engine injects (isMeta, task notifications) are not counted as requests', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-m' }) as never)
  let clock = T0
  on('clock.now', () => ({ value: (clock += 1000) }) as never)
  on('clock.every', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'a real request' } as never)
  await $.prompt.submit({ text: '<task-notification>agent finished</task-notification>' } as never)
  await $.prompt.submit({ text: 'injected', isMeta: true } as never)
  const r = (await $.command.run({ command: 'agent-requests', args: '' } as never)) as { text?: string }
  expect((r?.text ?? '').includes('#2')).toBe(false)
  expect((r?.text ?? '').includes('#1')).toBe(true)
})
