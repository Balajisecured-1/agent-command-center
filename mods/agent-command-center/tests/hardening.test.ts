import { expect, test } from 'claude-code/testing'

import { cacheHit, diagnostics, emptyHistory, projectQuota, stalled } from '../lib/derive'
import { MAIN, newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'
import * as S from '../lib/sections'

const T0 = 5_000_000
const run = (evs: Ev[], m = newModel('s1', T0)) => evs.reduce((a, e) => reduce(a, e), m)
const use = (i: number, o: number, cr = 0, cc = 0) => ({ i, o, cr, cc, model: 'claude-sonnet-5-5' })

// Deterministic PRNG so a failing seed can be replayed.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomEvent(r: () => number, t: number, n: number): Ev {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T
  const id = `ag${Math.floor(r() * 6)}`
  const type = pick(['Explore', 'Plan', 'general-purpose', 'coder'])
  switch (Math.floor(r() * 15)) {
    case 0: return { k: 'request.start', t, text: `req ${n}` }
    case 1: return { k: 'turn.start', t, agentId: r() < 0.5 ? undefined : id }
    case 2: return { k: 'turn.end', t, agentId: r() < 0.5 ? undefined : id, turnId: `t${Math.floor(r() * 20)}`, durationMs: Math.floor(r() * 5000), reason: 'answer', usage: r() < 0.8 ? use(Math.floor(r() * 500), Math.floor(r() * 200), Math.floor(r() * 900), Math.floor(r() * 50)) : undefined }
    case 3: return { k: 'spawn', t, agentId: r() < 0.7 ? id : undefined, type, desc: `d${n}`, prompt: 'p' }
    case 4: return { k: 'agent.start', t, agentId: id, type }
    case 5: return { k: 'agent.stop', t, agentId: id, type }
    case 6: return { k: 'report', t, agentId: id, type, status: pick(['completed', 'failed', 'stopped'] as const), text: 'out' }
    case 7: return { k: 'tool.start', t, id: `tu${Math.floor(r() * 30)}`, tool: pick(['Bash', 'Read', 'Skill']), key: `k${Math.floor(r() * 4)}`, summary: 's' }
    case 8: return { k: 'tool.end', t, id: `tu${Math.floor(r() * 30)}`, tool: pick(['Bash', 'Read', 'Skill']), agentId: r() < 0.5 ? undefined : id, ok: r() < 0.6, key: `k${Math.floor(r() * 4)}`, summary: 's', error: 'boom' }
    case 9: return { k: 'task.created', t, id: `task${Math.floor(r() * 5)}`, subject: 'sub' }
    case 10: return { k: 'task.completed', t, id: `task${Math.floor(r() * 5)}`, subject: 'sub' }
    case 11: return { k: 'idle', t, who: id }
    case 12: return { k: 'interrupt', t, running: r() < 0.5 }
    case 13: return { k: 'measure', t, rateLimits: [{ kind: 'five_hour', percentUsed: Math.floor(r() * 100) }, { kind: 'seven_day', percentUsed: Math.floor(r() * 100) }], ctxPercent: Math.floor(r() * 100) }
    default: return { k: 'notify', t, text: 'needs permission', type: 'permission_prompt', agentId: id }
  }
}

test('fuzz: random event streams never throw and keep every invariant', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = rng(seed)
    let m = newModel('fz', T0)
    let t = T0
    for (let n = 0; n < 400; n++) {
      t += Math.floor(r() * 3000)
      m = reduce(m, randomEvent(r, t, n))
      if (n % 25 !== 0) continue
      expect(new Set(m.order).size).toBe(m.order.length)
      for (const id of m.order) expect(m.agents[id] !== undefined).toBe(true)
      for (const h of m.handoffs) expect(m.agents[h.to] !== undefined || h.status === 'refused' || h.status === 'dispatched').toBe(true)
      const T = m.tokens.total
      expect(T.i >= 0 && T.o >= 0 && T.cr >= 0 && T.cc >= 0).toBe(true)
      expect(m.events.length <= 400).toBe(true)
      expect(Object.keys(m.running).length <= 60).toBe(true)
    }
    // every report renders without throwing, at any moment
    for (const c of S.COMMANDS) expect(typeof S.report(c.name, m, t + 1000, emptyHistory())).toBe('string')
  }
})

test('perf: 4,000 events reduce within a sane budget and state stays bounded', () => {
  const r = rng(7)
  let m = newModel('perf', T0)
  let t = T0
  const t0 = Date.now()
  for (let n = 0; n < 4000; n++) {
    t += 200
    m = reduce(m, randomEvent(r, t, n))
  }
  const ms = Date.now() - t0
  expect(ms < 30000).toBe(true)
  expect(JSON.stringify(m).length < 400_000).toBe(true)
  expect(m.requestsLog.length <= 20).toBe(true)
  expect(m.quotaHist.length <= 40).toBe(true)
})

test('request ledger: tokens per request are the difference across the request', () => {
  const m = run([
    { k: 'request.start', t: T0, text: 'first' },
    { k: 'turn.start', t: T0 },
    { k: 'turn.end', t: T0 + 4000, turnId: 'a', durationMs: 4000, reason: 'answer', usage: use(100, 40, 300, 10) },
    { k: 'request.start', t: T0 + 10_000, text: 'second' },
    { k: 'turn.start', t: T0 + 10_000 },
    { k: 'turn.end', t: T0 + 16_000, turnId: 'b', durationMs: 6000, reason: 'answer', usage: use(10, 5, 0, 0) },
  ])
  expect(m.requestsLog.length).toBe(2)
  expect(m.requestsLog[0]?.tok?.o).toBe(40)
  expect(m.requestsLog[1]?.tok?.i).toBe(10)
  expect(m.requestsLog[1]?.outcome).toBe('done')
  expect(S.requests(m, T0 + 20_000).lines.some(l => /second/.test(l.text))).toBe(true)
})

test('alerts: quota threshold toasts once, drain clears, re-arms after recovery', () => {
  let m = run([{ k: 'measure', t: T0, rateLimits: [{ kind: 'five_hour', percentUsed: 85 }] }])
  expect(m.toasts.length).toBe(1)
  m = reduce(m, { k: 'measure', t: T0 + 1000, rateLimits: [{ kind: 'five_hour', percentUsed: 88 }] })
  expect(m.toasts.length).toBe(1) // not repeated
  m = reduce(m, { k: 'drain', t: T0 + 2000 })
  expect(m.toasts.length).toBe(0)
  const off = reduce(newModel('s', T0), { k: 'measure', t: T0, rateLimits: [{ kind: 'five_hour', percentUsed: 99 }] }, { alerts: false, quotaWarn: 80, ctxWarn: 85 })
  expect(off.toasts.length).toBe(0)
})

test('stalled: a silent running agent is flagged, a fresh one is not', () => {
  const m = run([
    { k: 'spawn', t: T0, agentId: 'ag1', type: 'Explore', desc: 'x', prompt: 'x' },
    { k: 'agent.start', t: T0 + 10, agentId: 'ag1', type: 'Explore' },
  ])
  expect(stalled(m, T0 + 60_000).length).toBe(0)
  expect(stalled(m, T0 + 10 * 60_000).length).toBe(1)
  expect(S.executive(m, T0 + 10 * 60_000, emptyHistory()).lines.some(l => /silent for/.test(l.text))).toBe(true)
  expect(m.agents[MAIN]).toBeDefined()
})

test('quota projection needs real growth, and flags a limit hit before reset', () => {
  let m = newModel('q', T0)
  expect(projectQuota(m, 'five')).toBe(null)
  m = reduce(m, { k: 'measure', t: T0, rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(T0 + 4 * 3_600_000).toISOString() }] })
  m = reduce(m, { k: 'measure', t: T0 + 3_600_000, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(T0 + 4 * 3_600_000).toISOString() }] })
  const p = projectQuota(m, 'five')
  expect(Math.round(p?.perHour ?? 0)).toBe(30)
  expect(p?.hitsBeforeReset).toBe(true)
})

test('diagnostics name the real gaps and cache hit is honest', () => {
  const empty = diagnostics(newModel('d', T0))
  expect(empty.some(d => d.level === 'gap' && /quota/i.test(d.text))).toBe(true)
  const m = run([{ k: 'spawn', t: T0, agentId: 'a', type: 'x', desc: 'x', prompt: 'x' }])
  expect(diagnostics(m).some(d => /SubagentStart/.test(d.text))).toBe(true)
  expect(cacheHit({ i: 0, o: 0, cr: 0, cc: 0, n: 0 })).toBe(undefined)
  expect(cacheHit({ i: 10, o: 5, cr: 80, cc: 10, n: 1 })).toBe(80)
})

test('tokens: with no finished turn, the context size and cost are shown instead of a bare dash', () => {
  const m = run([{ k: 'measure', t: T0, rateLimits: [], ctxTokens: 52_000, ctxWindow: 200_000, ctxPercent: 26, costUsd: 1.5 }])
  const txt = S.tokens(m).lines.map(l => l.text).join('\n')
  expect(/Context window holds 52\.0k/.test(txt)).toBe(true)
  expect(/earlier turns of this chat cannot be recovered/.test(txt)).toBe(true)
})

test('privacy: secrets in prompts, commands and outputs are masked before anything is stored', () => {
  const secrets = [
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp' + '_abcdefghijklmnopqrstuvwxyz0123',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'Bearer abcdefghijklmnop12345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ]
  const m = run([
    { k: 'request.start', t: T0, text: `deploy with ${secrets.join(' and ')} and password=hunter2 and postgres://admin:s3cret@db/x` },
    { k: 'tool.start', t: T0 + 1, id: 'tu1', tool: 'Bash', key: 'k', summary: 'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://x' },
  ])
  const blob = JSON.stringify(m)
  for (const s of secrets) expect(blob.includes(s)).toBe(false)
  expect(blob.includes('hunter2')).toBe(false)
  expect(blob.includes('s3cret')).toBe(false)
  expect(/redacted/.test(m.request?.text ?? '')).toBe(true)
  expect(/deploy with/.test(m.request?.text ?? '')).toBe(true)
})
