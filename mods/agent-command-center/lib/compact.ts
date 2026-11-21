// Compact, animated "always visible" view. Pure: the same model + now + frame gives the same text.
import type { History, Model } from '../types'
import { agentEta, elapsed, isLive, progress, requestEta, requestRuntime, sum, summary } from './derive'
import { MAIN, unhide } from './model'
import type { OfficeInput, Person } from './office'
import { clock, dur, short, tok } from './sections'
import type { Tone } from './sections'

export const FRAME_MS = 500
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const frameOf = (now: number) => Math.floor(now / FRAME_MS)
export const spin = (frame: number) => SPIN[frame % SPIN.length] ?? '•'

/** A bar whose leading edge shimmers while the work is live. */
export function bar(pct: number | undefined, width: number, frame: number, live: boolean): string {
  if (pct === undefined) {
    // unknown progress: an indeterminate sweep when live, empty when not
    if (!live) return '░'.repeat(width)
    const pos = frame % width
    return Array.from({ length: width }, (_, i) => (i === pos ? '▓' : i === (pos + width - 1) % width ? '▒' : '░')).join('')
  }
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? '█' : '░'))
  if (live && filled > 0 && filled < width) cells[filled - 1] = frame % 2 ? '▓' : '█'
  return cells.join('')
}

export type Row = { key: string; text: string; tone: Tone }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function headline(m: Model, now: number, h: History, frame: number): { title: string; tone: Tone; lines: { text: string; tone: Tone }[]; pct?: number; live: boolean } {
  const s = summary(m, now, h)
  const anyLive = Object.values(m.agents).some(a => a.id !== MAIN && isLive(a))
  const running = !!(m.request && !m.request.endAt) || anyLive
  const eta = requestEta(m, now, h)
  const t = m.tokens.total
  const q = m.quota
  const five = q?.rateLimits.find(r => r.kind === 'five_hour')
  const week = q?.rateLimits.find(r => r.kind === 'seven_day')
  const title = `${running ? spin(frame) : m.request ? '✓' : '○'} AGENT COMMAND CENTER ${running ? 'LIVE' : m.request ? 'idle' : 'waiting for a task'}`
  const lines: { text: string; tone: Tone }[] = []
  lines.push({
    text: `Request ${m.request ? dur(requestRuntime(m, now)) : '—'} · ETA ${eta ? `${dur(eta.exp)} (${dur(eta.opt)}–${dur(eta.cons)}, ${eta.confidence})` : running ? 'unavailable (no history yet)' : '—'}${eta ? ` · done ≈ ${clock(now + eta.exp)}` : ''}`,
    tone: 'plain',
  })
  lines.push({
    text: `Agents ${s.total} · ● active ${s.active} · ✓ done ${s.completed} · ◌ waiting ${s.waiting} · ⚠ blocked ${s.blocked}${s.failed ? ` · ✗ failed ${s.failed}` : ''}`,
    tone: s.blocked || s.failed ? 'warn' : 'plain',
  })
  lines.push({
    text: `Tokens ${t.n ? tok(sum(t)) : q?.ctxTokens !== undefined ? `none counted yet · context ${tok(q.ctxTokens)}` : '—'}${t.n ? ` (in ${tok(t.i)} · out ${tok(t.o)} · cache ${tok(t.cr + t.cc)})` : ''}${q?.costUsd !== undefined ? ` · $${q.costUsd.toFixed(2)}` : ''} · 5h ${five ? five.percentUsed + '%' : 'n/a'} · week ${week ? week.percentUsed + '%' : 'n/a'} · ctx ${q?.ctxPercent !== undefined ? q.ctxPercent + '%' : 'n/a'}`,
    tone: (week?.percentUsed ?? 0) >= 90 || (five?.percentUsed ?? 0) >= 90 ? 'bad' : 'dim',
  })
  return { title, tone: running ? 'head' : 'dim', lines, pct: s.pct, live: running }
}

/** One basic-details row per agent: who, status, progress, runtime, tokens, doing what, next handoff. */
export function agentRow(m: Model, id: string, now: number, h: History, frame: number): Row {
  const a = m.agents[id]
  if (!a) return { key: id, text: id, tone: 'dim' }
  const live = isLive(a) && a.status !== 'waiting'
  const icon = a.status === 'completed' ? '✓' : a.status === 'failed' || a.status === 'stopped' ? '✗' : a.status === 'waiting' || a.status === 'idle' ? '◌' : spin(frame + (id.charCodeAt(id.length - 1) || 0))
  const p = progress(m, a, now, h)
  const eta = agentEta(m, a, now, h)
  const name = id === MAIN ? 'main' : `${a.type}#${short(id).slice(0, 4)}`
  const pctTxt = p.pct === undefined ? ' n/a' : `${String(p.pct).padStart(3)}%`
  const next = a.nextHandoff ? ` →${a.nextHandoff}` : ''
  const text = unhide(`${icon} ${clip(name, 22).padEnd(14)} ${bar(p.pct, 8, frame, live)} ${pctTxt} ${dur(elapsed(a, now)).padStart(6)} ${tok(sum(a.tokens)).padStart(6)}tok ${eta && !['completed'].includes(a.status) ? 'ETA ' + dur(eta.exp) : ''} ${clip(a.blocked ? '⚠ ' + a.blocked : a.activity, 44)}${next}`)
  return { key: id, text, tone: a.blocked ? 'bad' : a.status === 'completed' ? 'ok' : a.status === 'failed' || a.status === 'stopped' ? 'bad' : a.status === 'waiting' || a.status === 'idle' ? 'warn' : 'plain' }
}

const FEED_KINDS = ['handoff.dispatch', 'agent.start', 'agent.report', 'tool.fail', 'retry', 'task.created', 'task.completed', 'request.start', 'interrupt', 'compact', 'model', 'turn.error']

const humanize = (t: string) => t.replace(/[-_:]+/g, ' ').replace(/\s+/g, ' ').trim()

/** The scene's data: real model state only (agent names/types, skills, chat title). */
export function officeInput(m: Model, now: number, h: History): OfficeInput {
  const s = summary(m, now, h)
  const handoffOf = (id: string) => [...m.handoffs].reverse().find(x => x.to === id)
  const nameOf = (id: string) => {
    const a = m.agents[id]
    if (!a) return id
    return id === MAIN ? m.title || 'Main chat' : a.name || humanize(a.type)
  }
  const people: Person[] = m.order.map(id => {
    const a = m.agents[id]!
    const hf = handoffOf(id)
    return {
      id,
      name: unhide(nameOf(id)),
      type: a.type,
      isMain: id === MAIN,
      parentId: a.parentId,
      status: a.status,
      blocked: a.blocked,
      activity: unhide(a.activity),
      skill: a.skill,
      handoff: hf?.status,
      spawnedAt: a.spawnedAt ?? hf?.spawnedAt,
      reportAt: hf?.reportAt ?? (a.status === 'completed' ? a.endedAt : undefined),
      ageMs: now - a.startedAt,
      runMs: elapsed(a, now),
      pct: progress(m, a, now, h).pct,
      tokens: sum(a.tokens),
      liveChildren: id === MAIN ? m.order.filter(x => x !== MAIN && m.agents[x] && isLive(m.agents[x]!) && (m.agents[x]!.parentId || MAIN) === MAIN).length : 0,
    }
  })
  const feed = m.events
    .filter(e => FEED_KINDS.includes(e.k) || e.k === 'skill')
    .slice(-6)
    .map(e => ({ who: e.who ? unhide(nameOf(e.who)) : 'System', text: unhide(e.text), time: clock(e.t), tone: /FAIL|error|interrupt/i.test(e.text) ? ('bad' as const) : undefined }))
  const running = Object.keys(m.running).length
  const t = m.tokens.total
  return {
    title: unhide(m.title || ''),
    people,
    stats: {
      active: s.active,
      total: s.total,
      running: running || s.active,
      completed: s.completed,
      pct: s.pct,
      tokens: t.n ? tok(sum(t)) : m.quota?.ctxTokens !== undefined ? `ctx ${tok(m.quota.ctxTokens)}` : '—',
      request: m.request ? unhide(`Request #${m.request.n}: ${m.request.text}`) : 'No request yet',
      live: !!(m.request && !m.request.endAt) || s.active > 0,
    },
    feed,
  }
}
