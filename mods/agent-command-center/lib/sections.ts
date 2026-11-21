// Text sections shared by the pane and the slash commands. Pure, deterministic.
import type { Agent, History, Model, Tokens } from '../types'
import { agentEta, cacheHit, diagnostics, elapsed, isDone, isLive, progress, projectQuota, requestEta, requestRuntime, stalled, subtasks, sum, summary, totals } from './derive'
import { MAIN, ag } from './model'

export type Tone = 'ok' | 'warn' | 'bad' | 'dim' | 'head' | 'plain'
export type Line = { text: string; tone?: Tone; bar?: { label: string; pct: number } }
export type Section = { id: string; title: string; lines: Line[] }

export const dur = (ms?: number) => {
  if (ms === undefined || !isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
export const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)))
export const clock = (t?: number) => (t ? new Date(t).toTimeString().slice(0, 8) : '—')
export const short = (id: string) => (id.length > 10 ? id.slice(0, 8) : id)
export const tag = (src: 'actual' | 'inferred' | 'none') => (src === 'actual' ? '[actual]' : src === 'inferred' ? '[inferred]' : '[n/a]')
const rng = (opt: number, cons: number) => `${dur(opt)}–${dur(cons)}`
const age = (a: number | undefined, now: number) => (a === undefined ? '—' : dur(now - a) + ' ago')

const tone = (s: string): Tone => (s === 'completed' ? 'ok' : s === 'failed' || s === 'stopped' ? 'bad' : s === 'waiting' || s === 'idle' ? 'warn' : 'plain')

export function executive(m: Model, now: number, h: History): Section {
  const s = summary(m, now, h)
  const lines: Line[] = []
  lines.push({ text: m.request ? `Request #${m.request.n}: ${m.request.text}` : 'No request yet this session', tone: 'dim' })
  lines.push({ text: 'Overall', bar: { label: 'Overall', pct: s.pct ?? 0 } })
  if (s.pct === undefined) lines.push({ text: 'Overall progress unavailable: no task list or history yet', tone: 'dim' })
  lines.push({
    text: `Agents ${s.total} · active ${s.active} · done ${s.completed} · waiting ${s.waiting} · blocked ${s.blocked}${s.failed ? ` · failed ${s.failed}` : ''}${s.stalled ? ` · stalled? ${s.stalled}` : ''}`,
    tone: s.blocked || s.failed || s.stalled ? 'warn' : 'plain',
  })
  for (const a of stalled(m, now)) lines.push({ text: `⏸ ${a.type} #${short(a.id)} silent for ${dur(now - a.lastActivityAt)} — may be stalled or waiting on a long tool [inferred]`, tone: 'warn' })
  return { id: 'summary', title: 'A · EXECUTIVE SUMMARY', lines }
}

export function agentLines(m: Model, a: Agent, now: number, h: History): Line[] {
  const lines: Line[] = []
  const p = progress(m, a, now, h)
  const s = subtasks(m, a)
  const eta = agentEta(m, a, now, h)
  lines.push({ text: `${a.status === 'completed' ? '✓' : isLive(a) ? '●' : '○'} ${a.type} #${short(a.id)} — ${a.status}${a.blocked ? ` ⚠ ${a.blocked}` : ''}`, tone: a.blocked ? 'bad' : tone(a.status) })
  lines.push({ text: `   task: ${a.task}`, tone: 'dim' })
  lines.push({ text: `   now: ${a.activity} ${tag(a.activitySrc)} · last ${age(a.lastActivityAt, now)}`, tone: 'plain' })
  lines.push({ text: `   run ${dur(elapsed(a, now))} (active ${dur(a.activeMs + (a.turnOpenAt !== undefined ? now - a.turnOpenAt : 0))}) · started ${clock(a.startedAt)} · tools ${a.tools}${a.toolFails ? ` (${a.toolFails} failed)` : ''}`, tone: 'dim' })
  lines.push({ text: `   subtasks ${s.src === 'none' ? 'unavailable' : `${s.done} done / ${s.pending} pending`} · progress ${p.pct === undefined ? 'unavailable' : p.pct + '%'} ${tag(p.src)} ${p.basis}`, tone: 'dim' })
  lines.push({ text: `   tokens ${tok(sum(a.tokens))} · ETA ${eta ? `${dur(eta.exp)} (${rng(eta.opt, eta.cons)}, ${eta.confidence})` : 'unavailable'}${a.nextHandoff ? ` · next → ${a.nextHandoff}` : ''}`, tone: 'dim' })
  return lines
}

export function activity(m: Model, now: number, h: History): Section {
  const lines: Line[] = []
  lines.push({ text: `Current task: ${m.curTask ? `${m.curTask.label} (${dur(now - m.curTask.since)}) ${tag(m.curTask.src)}` : '—'}`, tone: 'head' })
  for (const id of m.order) lines.push(...agentLines(m, ag(m, id), now, h))
  return { id: 'activity', title: 'B · AGENT ACTIVITY', lines }
}

export function handoffs(m: Model, now: number, limit = 12): Section {
  const lines: Line[] = []
  if (!m.handoffs.length) lines.push({ text: 'No handoffs observed (no subagent has been dispatched)', tone: 'dim' })
  for (const hf of [...m.handoffs].reverse().slice(0, limit)) {
    const confirm = hf.status === 'returned' ? 'CONFIRMED returned' : hf.status === 'acknowledged' ? 'acknowledged (destination started)' : hf.status === 'dispatched' ? 'dispatched, NOT yet acknowledged' : hf.status
    lines.push({ text: `${short(hf.from)} → ${hf.toType} #${short(hf.to)} — ${confirm}`, tone: hf.status === 'returned' ? 'ok' : hf.status === 'failed' || hf.status === 'refused' || hf.status === 'stopped' ? 'bad' : 'warn' })
    lines.push({ text: `   task: ${hf.task}`, tone: 'dim' })
    lines.push({ text: `   source done: ${hf.sourceDone} · remaining: ${hf.remaining}`, tone: 'dim' })
    lines.push({ text: `   sent ${clock(hf.spawnedAt)} · ack ${hf.ackAt ? `${clock(hf.ackAt)} (+${dur(hf.ackAt - hf.spawnedAt)})` : 'none yet'} · returned ${hf.reportAt ? `${clock(hf.reportAt)} (took ${dur(hf.reportAt - hf.spawnedAt)})` : 'not yet'}`, tone: 'dim' })
    if (hf.output) lines.push({ text: `   output transferred: ${hf.output}`, tone: 'dim' })
  }
  lines.push({ text: 'Note: "returned" = the destination\'s report reached the parent. Parent acknowledgement is not exposed.', tone: 'dim' })
  return { id: 'handoffs', title: 'C · HANDOFF TRACKER', lines }
}

const tokLine = (label: string, t: Tokens) => `${label}: ${tok(sum(t))} (in ${tok(t.i)} · out ${tok(t.o)} · cache-read ${tok(t.cr)} · cache-write ${tok(t.cc)}) ×${t.n}`

export function tokens(m: Model): Section {
  const T = m.tokens
  const lines: Line[] = []
  lines.push({ text: tokLine('Session total', T.total), tone: 'head' })
  const hit = cacheHit(T.total)
  lines.push({ text: `Cache hit rate: ${hit === undefined ? 'unavailable' : hit + '% of input tokens read from cache'}`, tone: hit !== undefined && hit < 30 && T.total.n > 3 ? 'warn' : 'dim' })
  if (T.total.n === 0) {
    lines.push({ text: `No finished turn has reported usage since the mod loaded${m.sessionStart ? ' (' + clock(m.sessionStart) + ')' : ''}. Usage arrives when a turn ends; earlier turns of this chat cannot be recovered.`, tone: 'dim' })
    if (m.quota?.ctxTokens !== undefined) lines.push({ text: `Context window holds ${tok(m.quota.ctxTokens)} tokens now (reported by the host)${m.quota.costUsd !== undefined ? ` · session cost so far $${m.quota.costUsd.toFixed(2)} (estimate)` : ''}`, tone: 'plain' })
  }
  lines.push({ text: 'By agent', tone: 'dim' })
  for (const [id, t] of Object.entries(T.byAgent)) lines.push({ text: `   ${ag(m, id)?.type ?? id} #${short(id)}: ${tokLine('', t).slice(2)}`, tone: 'plain' })
  lines.push({ text: 'By model', tone: 'dim' })
  for (const [id, t] of Object.entries(T.byModel)) lines.push({ text: `   ${id}: ${tokLine('', t).slice(2)}`, tone: 'plain' })
  const last = T.recent.slice(-3).reverse()
  if (last.length) {
    lines.push({ text: 'Recent turns (a turn = all requests of one model loop run)', tone: 'dim' })
    for (const r of last) lines.push({ text: `   ${clock(r.t)} ${ag(m, r.agent)?.type ?? r.agent}: ${tok(r.i + r.o + r.cr + r.cc)}`, tone: 'dim' })
  }
  lines.push({ text: `Retries: ${m.retries.count} tool retry(ies) [inferred], ${dur(m.retries.ms)} · API-error turns ${m.turnErrors} · retry token overhead: unavailable`, tone: m.retries.count ? 'warn' : 'dim' })
  lines.push({ text: 'Unavailable: per-request tokens (hooks give per-turn), subagent turns spawned by workflows that skip turn hooks', tone: 'dim' })
  return { id: 'tokens', title: 'D · TOKEN INTELLIGENCE', lines }
}

export function quota(m: Model, now: number): Section {
  const q = m.quota
  const lines: Line[] = []
  const fmt = (kind: string, label: string) => {
    const r = q?.rateLimits.find(x => x.kind === kind)
    if (!r) return { text: `${label}: unavailable (not reported by this account/session yet)`, tone: 'dim' as Tone }
    const left = Math.max(0, 100 - r.percentUsed)
    return {
      text: `${label}: ${r.percentUsed}% used · ${Math.round(left * 10) / 10}% left${r.resetsAt ? ` · resets ${new Date(r.resetsAt).toLocaleString()}` : ''}`,
      tone: (r.percentUsed >= 90 ? 'bad' : r.percentUsed >= 70 ? 'warn' : 'plain') as Tone,
    }
  }
  lines.push(fmt('five_hour', 'Session (5-hour) quota'))
  lines.push(fmt('seven_day', 'Weekly (7-day) quota'))
  for (const r of q?.rateLimits ?? []) if (r.kind !== 'five_hour' && r.kind !== 'seven_day') lines.push({ text: `${r.kind}: ${r.percentUsed}% used${r.resetsAt ? ` · resets ${new Date(r.resetsAt).toLocaleString()}` : ''}`, tone: 'plain' })
  lines.push({
    text: q?.ctxPercent !== undefined ? `Context window: ${q.ctxPercent}% (${tok(q.ctxTokens ?? 0)} / ${tok(q.ctxWindow ?? 0)})` : 'Context window: unavailable until the first response',
    tone: (q?.ctxPercent ?? 0) >= 85 ? 'warn' : 'plain',
  })
  if (q?.costUsd !== undefined) lines.push({ text: `Session cost (client-side estimate, not a bill): $${q.costUsd.toFixed(2)}`, tone: 'dim' })
  for (const [k, label] of [['five', 'Session'], ['week', 'Weekly']] as const) {
    const pr = projectQuota(m, k)
    if (pr) lines.push({ text: `${label} burn rate ≈ ${pr.perHour.toFixed(1)}%/h → ~${dur((pr.hoursLeft ?? 0) * 3_600_000)} to the limit${pr.hitsBeforeReset ? ' — BEFORE it resets' : ''} [inferred]`, tone: pr.hitsBeforeReset ? 'bad' : 'dim' })
  }
  lines.push({ text: q ? `Quota snapshot ${age(q.at, now)}` : 'No usage measurement received yet', tone: 'dim' })
  return { id: 'quota', title: 'D2 · QUOTA & CONTEXT', lines }
}

export function timeEta(m: Model, now: number, h: History): Section {
  const lines: Line[] = []
  const t = totals(m, now)
  const rr = requestRuntime(m, now)
  lines.push({ text: `Request runtime: ${dur(rr)}${m.request?.endAt ? ' (finished)' : ''} · session ${dur(t.wall)}`, tone: 'head' })
  lines.push({ text: `Current task: ${m.curTask ? `${dur(now - m.curTask.since)} — ${m.curTask.label}` : '—'}`, tone: 'plain' })
  lines.push({ text: `Active execution (sum of turns) ${dur(t.active)} · handoff ack ${t.ackMs.length ? dur(avg(t.ackMs)) : '—'} avg · handoff round-trip ${t.handoffMs.length ? dur(avg(t.handoffMs)) : '—'} avg · retries ${dur(m.retries.ms)}`, tone: 'dim' })
  for (const id of m.order.filter(i => i !== MAIN)) {
    const a = ag(m, id)
    const e = agentEta(m, a, now, h)
    lines.push({ text: `   ${a.type} #${short(id)}: run ${dur(elapsed(a, now))} · ETA ${e ? `${dur(e.exp)} (${rng(e.opt, e.cons)}) ${e.confidence}` : 'unavailable'}`, tone: 'plain' })
  }
  const re = requestEta(m, now, h)
  if (re) {
    lines.push({ text: `Current task ETA: ${re.current ? `${dur(re.current.exp)} (${rng(re.current.opt, re.current.cons)})` : 'unavailable'}`, tone: 'plain' })
    lines.push({ text: `Next handoff estimate: ${re.next ? `${dur(re.next.exp)} (${re.next.basis})` : 'unavailable'}`, tone: 'plain' })
    lines.push({ text: `Final verification: ${re.verify !== null ? dur(re.verify) + ' (history)' : 'unavailable (no history)'}`, tone: 'plain' })
    lines.push({ text: `Request ETA: ${dur(re.exp)} · optimistic ${dur(re.opt)} · conservative ${dur(re.cons)} · confidence ${re.confidence}`, tone: 'head' })
    lines.push({ text: `   finish ≈ ${clock(now + re.exp)} (${clock(now + re.opt)}–${clock(now + re.cons)}) · ${re.basis}`, tone: 'dim' })
  } else {
    lines.push({ text: m.request?.endAt ? 'Request finished' : 'Request ETA: unavailable (no subtask list and no history for these agents yet)', tone: 'dim' })
  }
  return { id: 'time', title: 'E · TIME & ETA', lines }
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export function history(m: Model, now: number, n = 25): Section {
  const lines: Line[] = []
  if (!m.events.length) lines.push({ text: 'No events yet', tone: 'dim' })
  for (const e of m.events.slice(-n).reverse()) {
    lines.push({ text: `${clock(e.t)} ${e.src === 'inferred' ? '~' : ' '} ${e.who ? '[' + short(e.who) + '] ' : ''}${e.text}`, tone: /FAIL|error|interrupt|Retry/i.test(e.text) ? 'bad' : e.k === 'handoff.dispatch' || e.k === 'agent.report' ? 'warn' : 'dim' })
  }
  lines.push({ text: `Compactions ${m.compactions.count}${m.compactions.open ? ' (running)' : ''} · interruptions ${m.interruptions} · model changes ${m.models.changes.length}${m.models.current ? ` · model ${m.models.current}` : ''}`, tone: 'dim' })
  lines.push({ text: '"~" marks inferred lines; unmarked lines are hook events', tone: 'dim' })
  return { id: 'history', title: 'F · EXECUTION HISTORY', lines }
}

export function completion(m: Model, now: number, h: History): Section {
  const lines: Line[] = []
  const s = summary(m, now, h)
  const main = ag(m, MAIN)
  const sub = subtasks(m, main)
  const done = m.order.map(i => ag(m, i)).filter(a => a.id !== MAIN && a.status === 'completed')
  lines.push({ text: `Deliverables (agent reports): ${done.length ? done.map(a => `${a.type}`).join(', ') : 'none yet'}`, tone: 'plain' })
  for (const a of done.slice(-5)) {
    const hf = [...m.handoffs].reverse().find(x => x.to === a.id)
    if (hf?.output) lines.push({ text: `   ${a.type}: ${hf.output}`, tone: 'dim' })
  }
  const open = Object.values(m.tasks).filter(t => !t.doneAt).map(t => t.subject)
  const todoOpen = (main.todos || []).filter(t => t.status !== 'completed').map(t => t.content)
  const remaining = [...todoOpen, ...open]
  lines.push({ text: `Remaining tasks: ${sub.src === 'none' ? 'unavailable (no task list in use)' : remaining.length ? remaining.slice(0, 6).join(' · ') : 'none'}`, tone: remaining.length ? 'warn' : 'ok' })
  const live = m.order.map(i => ag(m, i)).filter(a => a.id !== MAIN && isLive(a)).length
  lines.push({ text: `Verification: not observable by hooks. Agents still live: ${live}; failed agents: ${s.failed}; tool failures: ${Object.values(m.agents).reduce((n, a) => n + a.toolFails, 0)}`, tone: 'dim' })
  lines.push({ text: `Overall completion: ${s.pct === undefined ? 'unavailable' : s.pct + '%'}${m.request?.endAt ? ' · main turn finished' : ''}`, tone: m.request?.endAt && !live ? 'ok' : 'plain' })
  return { id: 'final', title: 'G · FINAL COMPLETION', lines }
}

export function requests(m: Model, now: number, n = 8): Section {
  const lines: Line[] = []
  if (!m.requestsLog.length) lines.push({ text: 'No requests recorded yet', tone: 'dim' })
  for (const r of [...m.requestsLog].reverse().slice(0, n)) {
    const t = r.tok
    const icon = r.outcome === 'done' ? '✓' : r.outcome === 'running' ? '●' : '✕'
    lines.push({ text: `${icon} #${r.n} ${r.text}`, tone: r.outcome === 'done' ? 'ok' : r.outcome === 'running' ? 'plain' : 'bad' })
    lines.push({ text: `   ${dur((r.endAt ?? now) - r.startAt)} · agents ${r.agents} · tools ${r.tools}${r.toolFails ? ` (${r.toolFails} failed)` : ''}${r.retries ? ` · retries ${r.retries}` : ''} · tokens ${t ? tok(sum(t)) + ` (out ${tok(t.o)})` : r.outcome === 'running' ? 'counted when the turn ends' : 'unavailable'}`, tone: 'dim' })
  }
  lines.push({ text: 'Tokens per request = difference of session totals across the request [actual, per-turn granularity]', tone: 'dim' })
  return { id: 'requests', title: 'H · REQUEST LEDGER', lines }
}

export function diag(m: Model): Section {
  const lines: Line[] = diagnostics(m).map(d => ({ text: `${d.level === 'ok' ? '✓' : '△'} ${d.text}`, tone: d.level === 'ok' ? 'ok' : 'warn' }))
  lines.push({ text: `Events seen: ${Object.entries(m.cov).map(([k, v]) => `${k}×${v}`).join(' · ') || 'none'}`, tone: 'dim' })
  return { id: 'diagnostics', title: 'I · TELEMETRY DIAGNOSTICS', lines }
}

export function all(m: Model, now: number, h: History): Section[] {
  return [executive(m, now, h), activity(m, now, h), handoffs(m, now), tokens(m), quota(m, now), timeEta(m, now, h), history(m, now), completion(m, now, h), requests(m, now), diag(m)]
}

export const render = (ss: Section[]) =>
  ss
    .map(s => `${s.title}\n${s.lines.map(l => (l.bar ? `  [${'█'.repeat(Math.round(l.bar.pct / 10)).padEnd(10, '░')}] ${l.bar.pct}%` : '  ' + l.text)).join('\n')}`)
    .join('\n\n')

/** Slash command name -> report text. No LLM involved. */
export function report(cmd: string, m: Model, now: number, h: History): string {
  const only = (...ss: Section[]) => render(ss)
  switch (cmd) {
    case 'agent-status':
      return only(executive(m, now, h), { id: 'x', title: 'AGENTS', lines: activity(m, now, h).lines.filter(l => /^[✓●○]/.test(l.text)) })
    case 'agent-activity':
      return only(activity(m, now, h))
    case 'agent-handoffs':
      return only(handoffs(m, now))
    case 'agent-progress': {
      const lines: Line[] = m.order.map(i => ag(m, i)).map(a => {
        const p = progress(m, a, now, h)
        return { text: `${a.type} #${short(a.id)}: ${p.pct === undefined ? 'unavailable' : p.pct + '%'} ${tag(p.src)} — ${p.basis}` }
      })
      return only({ id: 'p', title: 'AGENT PROGRESS', lines }, executive(m, now, h))
    }
    case 'token-usage':
      return only(tokens(m))
    case 'session-usage': {
      const q = quota(m, now)
      return only({ ...q, lines: q.lines.filter(l => /Session|Context|cost|snapshot/.test(l.text)) })
    }
    case 'weekly-usage': {
      const q = quota(m, now)
      return only({ ...q, lines: q.lines.filter(l => /Weekly|snapshot|7-day|resets/.test(l.text)) })
    }
    case 'task-runtime': {
      const lines: Line[] = [{ text: `Current task: ${m.curTask ? `${m.curTask.label} — ${dur(now - m.curTask.since)} ${tag(m.curTask.src)}` : '—'}` }]
      for (const id of m.order) lines.push({ text: `${ag(m, id).type} #${short(id)}: ${dur(elapsed(ag(m, id), now))}` })
      return only({ id: 't', title: 'TASK RUNTIME', lines })
    }
    case 'request-runtime': {
      const t = totals(m, now)
      return only({ id: 'r', title: 'REQUEST RUNTIME', lines: [{ text: `Request: ${dur(requestRuntime(m, now))}${m.request?.endAt ? ' (finished)' : ' (running)'}` }, { text: `Session: ${dur(t.wall)} · active ${dur(t.active)} · retries ${dur(m.retries.ms)}` }, { text: `Handoff round-trip avg ${t.handoffMs.length ? dur(avg(t.handoffMs)) : '—'}` }] })
    }
    case 'task-eta':
    case 'request-eta': {
      const s = timeEta(m, now, h)
      return only({ ...s, lines: s.lines.filter(l => (cmd === 'task-eta' ? /Current task ETA|ETA|Next handoff/.test(l.text) : /Request|Final|finish|ETA/.test(l.text))) })
    }
    case 'agent-requests':
      return only(requests(m, now))
    case 'agent-diagnostics':
      return only(diag(m))
    case 'execution-report':
      return render(all(m, now, h))
    default:
      return 'Unknown command'
  }
}

export const COMMANDS: { name: string; description: string }[] = [
  { name: 'agent-status', description: 'Agents at a glance (no LLM call)' },
  { name: 'agent-activity', description: 'What each agent is doing right now' },
  { name: 'agent-handoffs', description: 'Source → destination handoffs and their confirmed status' },
  { name: 'agent-progress', description: 'Per-agent and overall completion' },
  { name: 'token-usage', description: 'Tokens by total, agent, model; cache and retries' },
  { name: 'session-usage', description: 'Session (5h) quota and context window' },
  { name: 'weekly-usage', description: 'Weekly (7-day) quota' },
  { name: 'task-runtime', description: 'Runtime of the current task and each agent' },
  { name: 'request-runtime', description: 'Runtime of the whole user request' },
  { name: 'task-eta', description: 'ETA of the current task' },
  { name: 'request-eta', description: 'ETA of the entire request' },
  { name: 'agent-requests', description: 'Per-request ledger: runtime, tokens, agents, retries' },
  { name: 'agent-diagnostics', description: 'Which telemetry is real, and which is missing' },
  { name: 'execution-report', description: 'Full A–G execution report' },
]
