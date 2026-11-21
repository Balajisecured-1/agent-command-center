// Deterministic derivations: progress, runtimes, ETA, token totals. Pure functions.
import type { Agent, History, Model, Tokens } from '../types'
import { MAIN, ag } from './model'

/** Past runs of one agent type: only an own, array-valued, numeric entry counts (a type named `constructor` finds none). */
export const past = (hist: History, type: string): number[] | undefined => {
  if (!hist || !hist.agentMs || !Object.prototype.hasOwnProperty.call(hist.agentMs, type)) return undefined
  const v = hist.agentMs[type]
  return Array.isArray(v) ? v.filter(x => typeof x === 'number' && isFinite(x)).slice(-30) : undefined
}

export const emptyHistory = (): History => ({ agentMs: {}, finalizeMs: [], requestMs: [] })

const LIVE = ['starting', 'running', 'waiting']
export const isLive = (a: Agent) => LIVE.includes(a.status)
export const isDone = (a: Agent) => ['completed', 'failed', 'stopped'].includes(a.status)

export const sum = (t: Tokens) => t.i + t.o + t.cr + t.cc

export function elapsed(a: Agent, now: number) {
  return Math.max(0, (a.endedAt ?? now) - a.startedAt)
}

export function subtasks(m: Model, a: Agent): { done: number; pending: number; src: 'task list' | 'tasks' | 'none' } {
  if (a.todos && a.todos.length) {
    const done = a.todos.filter(t => t.status === 'completed').length
    return { done, pending: a.todos.length - done, src: 'task list' }
  }
  if (a.id === MAIN) {
    const ts = Object.values(m.tasks)
    if (ts.length) {
      const done = ts.filter(t => t.doneAt !== undefined).length
      return { done, pending: ts.length - done, src: 'tasks' }
    }
  }
  const named = Object.values(m.tasks).filter(t => t.who && (t.who === a.id || t.who === a.type))
  if (named.length) {
    const done = named.filter(t => t.doneAt !== undefined).length
    return { done, pending: named.length - done, src: 'tasks' }
  }
  return { done: 0, pending: 0, src: 'none' }
}

export type Progress = { pct?: number; basis: string; src: 'actual' | 'inferred' | 'none' }

export function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return 0
  const k = Math.floor(s.length / 2)
  return s.length % 2 ? (s[k] ?? 0) : ((s[k - 1] ?? 0) + (s[k] ?? 0)) / 2
}
const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
}

export function progress(m: Model, a: Agent, now: number, hist: History): Progress {
  if (a.status === 'completed') return { pct: 100, basis: 'completed', src: 'actual' }
  if (a.status === 'failed' || a.status === 'stopped') return { pct: undefined, basis: a.status, src: 'none' }
  const s = subtasks(m, a)
  if (s.done + s.pending > 0) return { pct: Math.round((100 * s.done) / (s.done + s.pending)), basis: `${s.done}/${s.done + s.pending} subtasks (${s.src})`, src: 'actual' }
  const h = past(hist, a.type)
  if (h && h.length && a.id !== MAIN) {
    const med = median(h)
    return { pct: Math.min(95, Math.round((100 * elapsed(a, now)) / Math.max(1, med))), basis: `elapsed vs median of ${h.length} past run(s)`, src: 'inferred' }
  }
  return { pct: undefined, basis: 'no task list or history', src: 'none' }
}

export type Eta = { opt: number; exp: number; cons: number; confidence: 'high' | 'medium' | 'low'; basis: string }

const ORDER = ['low', 'medium', 'high'] as const
const confOf = (n: number): Eta['confidence'] => (n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low')
const lowest = (a: Eta['confidence'], b: Eta['confidence']): Eta['confidence'] => ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))] ?? 'low'

export function agentEta(m: Model, a: Agent, now: number, hist: History): Eta | null {
  if (isDone(a)) return { opt: 0, exp: 0, cons: 0, confidence: 'high', basis: 'finished' }
  const el = elapsed(a, now)
  const s = subtasks(m, a)
  if (s.done >= 1 && s.done + s.pending > 0) {
    const rate = el / s.done
    return {
      opt: s.pending * rate * 0.7,
      exp: s.pending * rate,
      cons: s.pending * rate * 1.5,
      confidence: s.done >= 3 ? 'high' : s.done === 2 ? 'medium' : 'low',
      basis: `${s.pending} open subtask(s) × ${Math.round(rate / 1000)}s observed each`,
    }
  }
  const h = past(hist, a.type)
  if (h && h.length && a.id !== MAIN) {
    const med = median(h)
    if (el <= Math.max(...h)) {
      return {
        opt: Math.max(0, Math.min(...h) - el),
        exp: Math.max(0, med - el),
        cons: Math.max(0, pctl(h, 0.9) - el),
        confidence: confOf(h.length),
        basis: `${h.length} past ${a.type} run(s), median ${Math.round(med / 1000)}s`,
      }
    }
    return { opt: el * 0.1, exp: el * 0.25, cons: el * 0.6, confidence: 'low', basis: `running longer than all ${h.length} past run(s)` }
  }
  return null
}

export type RequestEta = Eta & { current: Eta | null; next: Eta | null; verify: number | null }

export function requestEta(m: Model, now: number, hist: History): RequestEta | null {
  if (!m.request || m.request.endAt) return null
  const live = m.order.map(i => ag(m, i)).filter(a => a.id !== MAIN && isLive(a))
  const parts: Eta[] = []
  let unknown = 0
  for (const a of live) {
    const e = agentEta(m, a, now, hist)
    if (e) parts.push(e)
    else unknown += 1
  }
  let next: Eta | null = null
  for (const h of m.handoffs.filter(x => x.status === 'dispatched')) {
    const hh = past(hist, h.toType)
    if (hh?.length) {
      const e: Eta = { opt: Math.min(...hh), exp: median(hh), cons: pctl(hh, 0.9), confidence: confOf(hh.length), basis: `queued ${h.toType} handoff` }
      next = next && next.exp > e.exp ? next : e
    }
  }
  const fin = hist.finalizeMs
  const verifyMs = fin.length ? median(fin) : null
  const mainEta = parts.length === 0 ? agentEta(m, ag(m, MAIN), now, hist) : null
  const longest = parts.reduce<Eta | null>((acc, p) => (!acc || p.exp > acc.exp ? p : acc), null)
  const base = longest ?? mainEta
  if (!base && verifyMs === null && !next) return null
  const e: Eta = {
    opt: (base?.opt ?? 0) + (next?.opt ?? 0) + (fin.length ? Math.min(...fin) : 0),
    exp: (base?.exp ?? 0) + (next?.exp ?? 0) + (verifyMs ?? 0),
    cons: (base?.cons ?? 0) + (next?.cons ?? 0) + (fin.length ? pctl(fin, 0.9) : 0),
    confidence: unknown ? 'low' : lowest(base?.confidence ?? 'low', fin.length ? confOf(fin.length) : 'low'),
    basis: `${parts.length} parallel agent(s), longest wins${next ? ' + queued handoff' : ''}${verifyMs !== null ? ' + final verify (history)' : ''}${unknown ? `; ${unknown} agent(s) without a basis` : ''}`,
  }
  return { ...e, current: base, next, verify: verifyMs }
}

export type Summary = { total: number; active: number; completed: number; waiting: number; blocked: number; failed: number; stalled: number; pct?: number }

export function summary(m: Model, now: number, hist: History): Summary {
  const agents = m.order.map(i => ag(m, i)).filter(a => a.id !== MAIN)
  const s: Summary = {
    total: agents.length,
    active: agents.filter(a => a.status === 'running' || a.status === 'starting').length,
    completed: agents.filter(a => a.status === 'completed').length,
    waiting: agents.filter(a => a.status === 'waiting' || a.status === 'idle').length,
    blocked: agents.filter(a => a.blocked && isLive(a)).length,
    failed: agents.filter(a => a.status === 'failed').length,
    stalled: stalled(m, now).length,
  }
  // Overall progress is steps finished out of steps launched. A finished agent is one whole step, a live agent counts
  // for what it can show (its own percentage, never a full step), and one that shows nothing counts as zero. So ten
  // finished agents and one still working read 90%, not 100%; 100% only once the request has ended and nothing is live.
  const mp = progress(m, ag(m, MAIN), now, hist).pct
  const finished = agents.filter(a => isDone(a)).length
  const liveShare = agents.filter(a => !isDone(a)).reduce((n, a) => n + Math.min(0.95, (progress(m, a, now, hist).pct ?? 0) / 100), 0)
  const requestOver = !!m.request?.endAt && !agents.some(isLive)
  if (agents.length) s.pct = requestOver ? 100 : Math.min(99, Math.floor((100 * (finished + liveShare)) / agents.length))
  else if (requestOver) s.pct = 100
  else if (mp !== undefined) s.pct = Math.min(99, mp)
  return s
}

export function requestRuntime(m: Model, now: number) {
  if (!m.request) return undefined
  return Math.max(0, (m.request.endAt ?? now) - m.request.startAt)
}

export function totals(m: Model, now: number) {
  const ags = m.order.map(i => ag(m, i))
  const active = ags.reduce((n, a) => n + a.activeMs + (a.turnOpenAt !== undefined ? now - a.turnOpenAt : 0), 0)
  const wall = Math.max(0, (m.endedAt ?? now) - m.sessionStart)
  const handoffMs = m.handoffs.filter(h => h.reportAt).map(h => h.reportAt! - h.spawnedAt)
  const ackMs = m.handoffs.filter(h => h.ackAt).map(h => h.ackAt! - h.spawnedAt)
  return { active, wall, handoffMs, ackMs }
}

/** Fold a finished agent / request into the history. Returns a new History. */
export function learn(hist: History, patch: { agentType?: string; agentMs?: number; finalizeMs?: number; requestMs?: number }): History {
  const h: History = JSON.parse(JSON.stringify(hist))
  const push = (xs: number[], v: number) => {
    xs.push(Math.round(v))
    if (xs.length > 30) xs.shift()
  }
  if (patch.agentType && patch.agentMs !== undefined && patch.agentMs > 0) {
    if (!Object.prototype.hasOwnProperty.call(h.agentMs, patch.agentType) || !Array.isArray(h.agentMs[patch.agentType])) h.agentMs[patch.agentType] = []
    push(h.agentMs[patch.agentType] as number[], patch.agentMs)
    // bounded across sessions: at most 50 agent types are remembered, the oldest are forgotten
    const types = Object.keys(h.agentMs)
    if (types.length > 50) for (const k of types.slice(0, types.length - 50)) delete h.agentMs[k]
  }
  if (patch.finalizeMs !== undefined && patch.finalizeMs >= 0) push(h.finalizeMs, patch.finalizeMs)
  if (patch.requestMs !== undefined && patch.requestMs > 0) push(h.requestMs, patch.requestMs)
  return h
}

/** An agent that is live but silent for this long is flagged as possibly stalled. */
export const STALE_MS = 5 * 60_000

export function stalled(m: Model, now: number, staleMs = STALE_MS): Agent[] {
  return m.order
    .map(i => ag(m, i))
    .filter(a => a.id !== MAIN && (a.status === 'running' || a.status === 'starting') && now - a.lastActivityAt > staleMs)
}

/** Share of input-side tokens served from the prompt cache (0–100), or undefined with no data. */
export function cacheHit(t: Tokens): number | undefined {
  const denom = t.i + t.cr + t.cc
  const v = denom > 0 ? Math.round((100 * t.cr) / denom) : undefined
  return v !== undefined && isFinite(v) ? Math.min(100, v) : undefined
}

export type Projection = { kind: 'five' | 'week'; perHour: number; hoursLeft?: number; hitsBeforeReset: boolean } | null

/** Linear burn-rate projection from the sampled quota history. Never invents data: needs ≥2 samples and growth. */
export function projectQuota(m: Model, kind: 'five' | 'week'): Projection {
  const pts = m.quotaHist.filter(s => s[kind] !== undefined)
  if (pts.length < 2) return null
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const dt = (b.t - a.t) / 3_600_000
  const dp = (b[kind] ?? 0) - (a[kind] ?? 0)
  if (dt <= 0 || dp <= 0) return null
  const perHour = dp / dt
  const left = Math.max(0, 100 - (b[kind] ?? 0))
  const hoursLeft = left / perHour
  const key = kind === 'five' ? 'five_hour' : 'seven_day'
  const reset = m.quota?.rateLimits.find(r => r.kind === key)?.resetsAt
  const resetH = reset ? (Date.parse(reset) - b.t) / 3_600_000 : undefined
  return { kind, perHour, hoursLeft, hitsBeforeReset: resetH === undefined ? false : hoursLeft < resetH }
}

export type Diag = { level: 'ok' | 'gap'; text: string }

/** Honest coverage report: which telemetry the host actually delivered, and which gaps remain. */
export function diagnostics(m: Model): Diag[] {
  const c = (k: string) => m.cov[k] ?? 0
  const out: Diag[] = []
  const gap = (text: string) => out.push({ level: 'gap', text })
  const ok = (text: string) => out.push({ level: 'ok', text })
  if (c('turn.end') && !m.tokens.total.n) gap('Turns finished but no token usage arrived: totals stay at zero')
  else if (m.tokens.total.n) ok(`Token usage received for ${m.tokens.total.n} turn(s)`)
  else gap('No finished turn yet: token usage unavailable')
  if (!c('measure')) gap('No usage measurement events: weekly/session quota and context are unavailable')
  else ok(`${c('measure')} usage measurement(s) received`)
  if (c('spawn') && !c('agent.start')) gap('Subagents were dispatched but no SubagentStart arrived: acknowledgement times are unavailable')
  if (c('agent.start') && !c('agent.stop') && !c('report')) gap('Subagents started but none reported back yet')
  if (c('tool.start') && !c('tool.end')) gap('Tools started but no PostToolUse arrived: tool results and retries are unreliable')
  if (c('request.start') && !c('turn.start')) gap('Requests seen without turn events: per-turn attribution is unavailable')
  if (c('foreign')) ok(`${c('foreign')} event(s) that belong to another chat were ignored (this flow shows this chat only)`)
  if (c('spawn')) ok(`${c('spawn')} handoff(s) observed, ${c('report')} return(s) confirmed`)
  if (!m.quotaHist.length) gap('Quota history empty: burn-rate projection unavailable')
  else if (m.quotaHist.length < 2) gap('Only one quota sample: burn-rate projection needs more history')
  return out
}
