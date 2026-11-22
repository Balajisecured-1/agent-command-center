// Agent Command Center: observer-only mod. Every hook records an event and passes through;
// nothing here blocks, rewrites or denies, and nothing calls a model.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Book, History, Model } from '../types'
import { emptyHistory, isLive, learn, requestEta, summary } from '../lib/derive'
import { DEFAULT_CFG, MAIN, SHAPE, clipText, ident, newModel, reduce, unhide } from '../lib/model'
import type { Cfg, Ev } from '../lib/model'
import * as S from '../lib/sections'
import { agentRow, bar, frameOf, headline, officeInput } from '../lib/compact'
import { flowParts } from '../lib/flow'
import { routeParts } from '../lib/route'
import { advance, officeParts, place, sceneKey } from '../lib/office'
import type { MoveState } from '../lib/office'

// Clocks in the text part refresh this often. The office animates by itself and is never redrawn on this tick.
const TICK_MS = 3000
const PANE = 'agent-command-center'
const TITLE = 'Agent Command Center'

const uiAtom = atom({ plugin: 'agent-command-center', key: 'ui' } as const, [] as string[], { shape: 'ui-1' })
// One model per chat, keyed by the chat's session id. The host already holds this state per session; keying it by chat as
// well means that even if two chats ever shared one state, each would read and write only its own entry.
const modelAtom = atom({ plugin: 'agent-command-center', key: 'model' } as const, {} as Book, { shape: SHAPE })

// Module variables reset on a hot reload; session.start restores them from $.store.
// Shared by every chat on purpose: the learned per-agent-type durations (anonymous numbers, no agent or chat is named in
// them, and no screen lists them) and the settings.
let hist: History = emptyHistory()
let histLoaded = false
let cfg: Cfg = { ...DEFAULT_CFG, strict: true }
let animDefault = true
let officeWidth = 900

// Everything else belongs to ONE chat (one session id) and is looked up by that id, so a second chat open in the same
// process can never see, move or redraw the first chat's agents.
type Chat = {
  moves: MoveState
  officeCache: Record<string, { sig: string; source: string; at: number }>
  recent: number[]
  lastStatus: string | undefined
  lastLearnedReq: number
  ticking: boolean
}
const chats = new Map<string, Chat>()
const MAX_CHATS = 24
function chatOf(id: string): Chat {
  let c = chats.get(id)
  if (!c) {
    c = { moves: {}, officeCache: {}, recent: [], lastStatus: undefined, lastLearnedReq: 0, ticking: false }
    chats.set(id, c)
    // bounded: the oldest chat's caches are dropped (they are rebuilt on demand)
    while (chats.size > MAX_CHATS) {
      const first = chats.keys().next().value
      if (first === undefined) break
      chats.delete(first)
    }
  }
  return c
}
/** The id of the chat this hook runs in ('' if the host cannot say, which only switches the extra check off). */
async function chatId($: Dollar): Promise<string> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' && id ? ident(id) : ''
  } catch {
    return ''
  }
}
const MAX_BOOK = 12
const slot = (id: string) => id || '_'
/** This chat's model and nothing else: another chat's entry (or one left from before a /clear) is never read. */
async function modelOf($: Dollar, id: string): Promise<Model> {
  const book = await read($, modelAtom)
  return book[slot(id)] ?? newModel(id, 0)
}
/** Replace only this chat's entry; the other chats' entries are carried over untouched. */
async function changeModel($: Dollar, id: string, t: number, f: (m: Model) => Model) {
  await update($, modelAtom, (book: Book) => {
    const k = slot(id)
    const cur = book[k]
    const out: Book = { ...book, [k]: f(cur && cur.sessionStart !== 0 ? cur : newModel(id, t)) }
    const keys = Object.keys(out)
    if (keys.length > MAX_BOOK) {
      // bounded: the chats that started longest ago go first, never the current one
      keys.sort((a, b) => (out[a]?.sessionStart ?? 0) - (out[b]?.sessionStart ?? 0))
      for (const x of keys) {
        if (Object.keys(out).length <= MAX_BOOK) break
        if (x !== k) delete out[x]
      }
    }
    return out
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dollar = any

const num = (x: unknown) => (typeof x === 'number' && isFinite(x) && x > 0 ? x : 0)
const pct = (x: unknown, d: number) => (typeof x === 'number' && isFinite(x) ? Math.min(100, Math.max(1, x)) : d)
const asRec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})

function summarize(input: unknown): string {
  const r = asRec(input)
  for (const k of ['skill', 'description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'subject', 'name']) {
    const v = r[k]
    if (typeof v === 'string' && v) return clipText(v, 90)
  }
  return ''
}

// Flood guard: more than 150 events inside one second is not a real session (a runaway or hostile stream), so the extra
// events are skipped instead of burning CPU. Events that end something (a turn with its tokens, an agent, a tool call,
// the session) are always kept, so nothing is left looking busy and no tokens are lost. The observer only watches.
const RATE = 150
const KEEP = new Set(['turn.end', 'report', 'agent.stop', 'tool.end', 'session.end', 'request.start', 'spawn', 'measure'])

// `claim` is the chat id an event says it belongs to (classic hooks carry `session_id`); without one the event is the
// current chat's. A claim that differs from the chat this hook runs in is dropped by the reducer.
async function emit($: Dollar, make: (t: number) => Ev, claim?: unknown) {
  try {
    const id = await chatId($)
    const t: number = await $.clock.now()
    const ch = chatOf(id)
    const ev = make(t)
    const rec = ch.recent
    rec.push(t)
    while (rec.length && t - (rec[0] ?? t) > 1000) rec.shift()
    if (rec.length > RATE && !KEEP.has(ev.k)) return
    const tag = typeof claim === 'string' && claim ? ident(claim) : id || undefined
    const tagged: Ev = tag ? { ...ev, chat: tag } : ev
    await changeModel($, id, t, m => reduce(m, tagged, cfg))
    await flush($, t, id)
  } catch {
    // Monitoring must never disturb the session.
  }
}

// Run the chain and record the event at the same time: the observer never puts its own wait in front of the user's work.
async function observe($: Dollar, e: unknown, next: (e: never) => unknown, make: (t: number) => Ev): Promise<Dollar> {
  // classic hooks name their own session; the others have none, so they are taken as this chat's
  const claim = (e as { session_id?: unknown } | null)?.session_id
  const [r] = await Promise.all([next(e as never), emit($, make, claim)])
  return r
}

// Show queued alerts as toasts, refresh the always-on status line, then clear the queue.
async function flush($: Dollar, t: number, id: string) {
  try {
    const ch = chatOf(id)
    const m = await modelOf($, id)
    if (m.toasts.length) {
      for (const text of m.toasts) void Promise.resolve($.ui.toast(text)).catch(() => {})
      await changeModel($, id, t, x => reduce(x, { k: 'drain', t }, cfg))
    }
    const live = Object.values(m.agents).filter(a => a.id !== MAIN && isLive(a)).length
    let line: string | undefined
    if (live > 0 || (m.request && !m.request.endAt)) {
      const s = summary(m, t, hist)
      const eta = requestEta(m, t, hist)
      const five = m.quota?.rateLimits.find(r => r.kind === 'five_hour')
      line = `◆ ${live} agent${live === 1 ? '' : 's'}${s.pct !== undefined ? ` · ${s.pct}%` : ''}${eta ? ` · ETA ${S.dur(eta.exp)}` : ''}${five ? ` · 5h ${Math.round(five.percentUsed)}%` : ''}`
    }
    if (line !== ch.lastStatus) {
      ch.lastStatus = line
      await $.ui.status(line)
    }
  } catch {
    // ignore
  }
}

async function loadHist($: Dollar) {
  try {
    const h = (await $.store.get('history')) as History | undefined
    if (h && h.agentMs && Array.isArray(h.finalizeMs)) hist = h
    histLoaded = true
  } catch {
    histLoaded = true
  }
}
async function saveHist($: Dollar, patch: Parameters<typeof learn>[1]) {
  hist = learn(hist, patch)
  try {
    await $.store.set('history', hist)
  } catch {
    // ignore
  }
}


async function toggle($: Dollar, key: string) {
  await update($, uiAtom, (l: string[]) => (l.includes(key) ? l.filter(x => x !== key) : [...l, key]))
}
/** One of the three views: the other two view keys are cleared, everything else (open sections, theme) stays. */
async function setView($: Dollar, v: 'pipeline' | 'route' | 'office') {
  await update($, uiAtom, (l: string[]) => {
    const rest = l.filter(x => x !== 'view:office' && x !== 'view:route')
    return v === 'pipeline' ? rest : [...rest, 'view:' + v]
  })
}
async function setOpen($: Dollar, keys: string[]) {
  await update($, uiAtom, () => keys)
}

async function startup($: Dollar) {
  try {
    const id = await chatId($)
    const t: number = await $.clock.now()
    await loadHist($)
    const ch = chatOf(id)
    const cur = await modelOf($, id)
    if (cur.sessionStart === 0) {
      await changeModel($, id, t, m => reduce(m, { k: 'session.start', t, sessionId: id }))
      ch.lastLearnedReq = 0
    } else {
      await changeModel($, id, t, m => reduce(m, { k: 'session.start', t, sessionId: id }))
      // a request this chat already finished and learned from is not learned twice after a reload
      ch.lastLearnedReq = cur.request?.endAt ? cur.request.n : 0
    }
    try {
      const u = await $.session.usage()
      if (u && (u.rateLimits.length || u.context)) {
        await emit($, tt => ({ k: 'measure', t: tt, rateLimits: u.rateLimits.map((r: Dollar) => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })), ctxTokens: u.context?.tokens, ctxWindow: u.context?.window, ctxPercent: u.context?.percent, costUsd: u.cost?.usd }))
      }
    } catch {
      // usage not available on this host: the quota section says so
    }
    for (const c of S.COMMANDS) await $.command.register({ name: c.name, description: c.description })
    void Promise.resolve($.ui.open({ id: PANE, title: TITLE })).catch(() => {})
    // Local refresh only: re-draw the clocks while something is live. No model calls.
    if (!ch.ticking) {
      ch.ticking = true
      $.clock.every(TICK_MS, async () => {
      try {
        const m = await modelOf($, id)
        const recent = m.events.length > 0 && (await $.clock.now()) - (m.events[m.events.length - 1]?.t ?? 0) < 7000
        if (Object.values(m.agents).some(a => isLive(a)) || (m.request && !m.request.endAt) || recent) await $.ui.invalidate('ui.render')
      } catch {
        // ignore
      }
      })
    }
  } catch {
    // never block session start
  }
}

async function afterTurn($: Dollar, e: Dollar) {
  const u = e.usage
  await emit($, t => ({
    k: 'turn.end',
    t,
    agentId: e.agentId,
    turnId: e.turnId,
    durationMs: e.durationMs,
    reason: e.reason,
    usage: u ? { i: num(u.input_tokens), o: num(u.output_tokens), cr: num(u.cache_read_input_tokens), cc: num(u.cache_creation_input_tokens), model: String(u.model ?? 'unknown') } : undefined,
  }))
  if (!e.agentId) {
    try {
      const id = await chatId($)
      const ch = chatOf(id)
      const m = await modelOf($, id)
      const r = m.request
      const anyLive = Object.values(m.agents).some(a => a.id !== MAIN && isLive(a))
      if (r?.endAt && !anyLive && r.n !== ch.lastLearnedReq && e.reason === 'answer') {
        ch.lastLearnedReq = r.n
        await saveHist($, {
          finalizeMs: r.lastAgentReportAt ? r.endAt - r.lastAgentReportAt : undefined,
          requestMs: r.endAt - r.startAt,
        })
      }
    } catch {
      // ignore
    }
  }
}

async function recordReport($: Dollar, e: Dollar) {
  await emit($, t => ({ k: 'report', t, agentId: e.agentId, parentId: e.parentAgentId, type: e.subagentType, status: e.status, text: e.text }))
  try {
    if (e.status === 'completed') {
      const m = await modelOf($, await chatId($))
      const a = m.agents[ident(e.agentId)]
      if (a?.endedAt) await saveHist($, { agentType: a.type, agentMs: a.endedAt - a.startedAt })
    }
  } catch {
    // ignore
  }
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Record<string, unknown>
  animDefault = o.animations !== false
  officeWidth = typeof o.officeWidth === 'number' ? o.officeWidth : 900
  cfg = {
    alerts: o.alerts !== false,
    quotaWarn: pct(o.quotaWarn, DEFAULT_CFG.quotaWarn),
    ctxWarn: pct(o.ctxWarn, DEFAULT_CFG.ctxWarn),
    // private by default: only an explicit "standard" records shortened, masked text
    strict: o.privacy !== 'standard',
  }
  on('session.start', async ($, e, next) => {
    // set-up runs beside the session's own start, never in front of it
    const [r] = await Promise.all([next(e), startup($)])
    return r
  })

  on('session.end', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'session.end', t, reason: String(e.reason) }))
  })

  on('session.stop', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'interrupt', t, running: e.isTurnRunning }))
  })

  on('prompt.submit', async ($, e, next) => {
    const text = typeof e.text === 'string' ? e.text : ''
    // Only what the person typed is a request. The engine marks its own injected prompts (a background agent finished,
    // a peer's message) with isMeta, and those must not inflate the request count.
    if (e.isMeta || !text.trim() || text.startsWith('/') || /^\s*<(?:task-notification|system-reminder|local-command)/.test(text)) return next(e)
    return observe($, e, next, t => ({ k: 'request.start', t, text }))
  })

  on('turn.start', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'turn.start', t, agentId: e.agentId }))
  })

  on('turn.complete', async ($, e, next) => {
    const [r] = await Promise.all([next(e), afterTurn($, e)])
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await emit($, t => ({
      k: 'spawn',
      t,
      agentId: r.agentId ?? r.teammateId,
      parentId: e.parentAgentId,
      type: e.subagentType,
      name: e.name,
      desc: e.description,
      prompt: e.prompt,
      model: r.model,
      denied: r.deny,
    }))
    return r
  })

  on('agent.report', async ($, e, next) => {
    const [r] = await Promise.all([next(e), recordReport($, e)])
    return r
  })

  on('classic.SubagentStart', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'agent.start', t, agentId: e.agent_id, type: e.agent_type }))
  })
  on('classic.SubagentStop', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'agent.stop', t, agentId: e.agent_id, type: e.agent_type, last: e.last_assistant_message }))
  })

  // `tool.call` (not the classic PreToolUse) carries the id of the agent making the call, so parallel agents are told apart
  // from the moment a tool starts. It is observed only: the call always passes on unchanged.
  on('tool.call', async ($, e, next) => {
    const r = asRec(e)
    const { tool, tool_use_id, agentId, requestMeta: _meta, ...rest } = r
    const sum = summarize(rest)
    const who = typeof agentId === 'string' && agentId ? agentId : undefined
    return observe($, e, next, t => ({ k: 'tool.start', t, id: String(tool_use_id), tool: String(tool), key: `${String(tool)}|${sum}`, summary: sum, agentId: who }))
  })
  on('classic.PostToolUse', async ($, e, next) => {
    const sum = summarize(e.tool_input)
    const todos = e.tool_name === 'TodoWrite' ? (asRec(e.tool_input).todos as { content: string; status: string }[] | undefined) : undefined
    return observe($, e, next, t => ({
      k: 'tool.end',
      t,
      id: e.tool_use_id,
      tool: e.tool_name,
      agentId: e.agent_id,
      ok: true,
      durationMs: e.duration_ms,
      key: `${e.tool_name}|${sum}`,
      todos: Array.isArray(todos) ? todos : undefined,
      summary: sum,
    }))
  })
  on('classic.PostToolUseFailure', async ($, e, next) => {
    const sum = summarize(e.tool_input)
    return observe($, e, next, t => ({
      k: 'tool.end',
      t,
      id: e.tool_use_id,
      tool: e.tool_name,
      agentId: e.agent_id,
      ok: false,
      durationMs: e.duration_ms,
      error: String(e.error),
      key: `${e.tool_name}|${sum}`,
      summary: sum,
    }))
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (typeof e.session_title !== 'string' || !e.session_title) return next(e)
    return observe($, e, next, t => ({ k: 'title', t, title: String(e.session_title) }))
  })
  on('classic.TaskCreated', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'task.created', t, id: e.task_id, subject: e.task_subject, who: e.teammate_name }))
  })
  on('classic.TaskCompleted', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'task.completed', t, id: e.task_id, subject: e.task_subject, who: e.teammate_name }))
  })
  on('classic.TeammateIdle', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'idle', t, who: e.teammate_name }))
  })
  on('classic.PostModelSwitch', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'model', t, from: e.from_model, to: e.to_model }))
  })
  on('classic.PreCompact', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'compact', t, phase: 'pre', trigger: e.trigger }))
  })
  on('classic.PostCompact', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'compact', t, phase: 'post', trigger: String(asRec(e).trigger ?? 'auto') }))
  })
  on('classic.Notification', async ($, e, next) => {
    const r = asRec(e)
    return observe($, e, next, t => ({ k: 'notify', t, text: String(r.message ?? 'notification'), type: typeof r.notification_type === 'string' ? r.notification_type : undefined, agentId: e.agent_id }))
  })
  on('classic.StopFailure', async ($, e, next) => {
    return observe($, e, next, t => ({ k: 'stopfail', t, error: String(asRec(e).error ?? 'error') }))
  })

  on('session.measure', async ($, e, next) => {
    return observe($, e, next, t => ({
      k: 'measure',
      t,
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
      ctxTokens: e.context.tokens,
      ctxWindow: e.context.window,
      ctxPercent: e.context.percent,
      costUsd: e.cost?.usd,
    }))
  })

  for (const c of S.COMMANDS) {
    on('command.run', { command: c.name }, async $ => {
      try {
        const now: number = await $.clock.now()
        if (!histLoaded) await loadHist($)
        const m = await modelOf($, await chatId($))
        return { text: unhide(S.report(c.name, m, now, hist)), isTextDisplayOnly: true }
      } catch {
        return { text: 'Agent Command Center could not build this report. Run /agent-diagnostics.', isTextDisplayOnly: true }
      }
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
    const { Box, Text, Button } = $.ui.resolve(e)
    const canSvg = e.surface !== 'terminal'
    const id = await chatId($)
    const ch = chatOf(id)
    const m = await modelOf($, id)
    const open = await read($, uiAtom)
    const now: number = await $.clock.now()
    const frame = frameOf(now)
    const head = headline(m, now, hist, frame)
    const color = (t?: S.Tone) => (t === 'ok' ? 'green' : t === 'bad' ? 'red' : t === 'warn' ? 'yellow' : t === 'head' ? 'cyan' : undefined)
    const width = Math.max(10, Math.min(30, Math.floor((e.props.bodyColumns ?? 60) / 4)))
    const SECTIONS: { key: string; label: string; make: () => S.Section }[] = [
      { key: 'sec:summary', label: 'Summary', make: () => S.executive(m, now, hist) },
      { key: 'sec:handoffs', label: 'Handoffs', make: () => S.handoffs(m, now, 6) },
      { key: 'sec:tokens', label: 'Tokens', make: () => S.tokens(m) },
      { key: 'sec:quota', label: 'Quota', make: () => S.quota(m, now) },
      { key: 'sec:time', label: 'Time & ETA', make: () => S.timeEta(m, now, hist) },
      { key: 'sec:history', label: 'History', make: () => S.history(m, now, 15) },
      { key: 'sec:final', label: 'Completion', make: () => S.completion(m, now, hist) },
      { key: 'sec:requests', label: 'Requests', make: () => S.requests(m, now, 6) },
      { key: 'sec:diag', label: 'Diagnostics', make: () => S.diag(m) },
    ]
    const showOffice = canSvg && !open.includes('hide:office')
    let officeNode = null
    if (showOffice) {
      const input = officeInput(m, now, hist)
      ch.moves = advance(ch.moves, place(input.people, now), now)
      const { Svg } = $.ui.resolve(e) as unknown as { Svg: (p: { source: string; alt: string; isInteractive?: boolean; width?: number; height?: number }) => never }
      const animOn = animDefault ? !open.includes('anim:off') : open.includes('anim:on')
      const scale = Math.max(0.5, Math.min(2, officeWidth / 760))
      // Three views of the same facts: the pipeline (one lane per agent, the default), the route map (work travels along a
      // rail to one station per agent) and the animated office. The route map has a light and a dark look.
      const view: 'pipeline' | 'route' | 'office' = open.includes('view:office') ? 'office' : open.includes('view:route') ? 'route' : 'pipeline'
      const asOffice = view === 'office'
      const theme = open.includes('theme:dark') ? 'dark' : 'light'
      const parts = view === 'office' ? officeParts(input, ch.moves, now, animOn) : view === 'route' ? routeParts(input, now, animOn, theme) : flowParts(input, now, animOn)
      const alts: Record<string, string> = {
        header: `Agent summary: ${input.stats.active} of ${input.stats.total} agents active, ${input.stats.completed} completed`,
        lanes: 'Pipeline: one lane per agent with its stages and progress',
        rhead: 'Route map summary: agents active, running in parallel, reports in, tokens and progress',
        rmap: 'Route map: a rail from the main chat to one station per agent, with a courier carrying each handoff',
        rcards: 'Step details of the agents working now, and how the request went step by step',
        rfeed: 'Handoffs and messages',
        floor: 'Office floor: where each agent is and what it is doing',
        activity: 'Agent activity list',
        comms: 'Agent communication feed',
        timeline: 'Task timeline',
      }
      // Every part is its own SVG. A new source reloads that frame and restarts its animations, so a part is only
      // swapped when its structure really changed (animation elements and walk countdowns do not count), at most
      // once per 2 s. Parts that did not change are never touched.
      const nodes = parts.map(part => {
        const sig = `${animOn}|${view}|${theme}|${sceneKey(part.svg)}`
        const c = ch.officeCache[part.id]
        if (!c || (sig !== c.sig && now - c.at >= 2000)) ch.officeCache[part.id] = { sig, source: part.svg, at: now }
        const src = (ch.officeCache[part.id] as { source: string }).source
        return { part, node: <Svg key={'svg-' + part.id} source={src} alt={alts[part.id] ?? part.id} isInteractive={true} width={Math.round(part.w * scale)} height={Math.round(part.h * scale)} /> }
      })
      const byId = (id: string) => nodes.find(n => n.part.id === id)?.node
      officeNode = view === 'route' ? (
        <Box flexDirection="column">
          {byId('rhead')}
          {byId('rmap')}
          {byId('rcards')}
          {byId('rfeed')}
          <Text dimColor>Each station is one real agent; the courier carries each handoff. Names, statuses and numbers come from real hook events.</Text>
        </Box>
      ) : asOffice ? (
        <Box flexDirection="column">
          {byId('header')}
          {byId('floor')}
          <Box flexDirection="row">
            {byId('activity')}
            {byId('comms')}
            {byId('timeline')}
          </Box>
          <Text dimColor>Scene = visual metaphor of real hook events; names, statuses and numbers are real.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {byId('header')}
          {byId('lanes')}
          {byId('comms')}
          <Text dimColor>Each lane is one real agent; its stages, status and numbers come from real hook events.</Text>
        </Box>
      )
    }
    const allKeys = [...SECTIONS.map(s => s.key), ...m.order.map(id => 'agent:' + id)]
    const isAll = allKeys.every(k => open.includes(k))
    const renderLine = (l: S.Line) => (
      <Text color={color(l.tone)} dimColor={l.tone === 'dim'}>
        {unhide(l.text)}
      </Text>
    )

    return (
      <Box flexDirection="column">
        {officeNode}
        {canSvg && (
          <Button key="b-office" onPress={() => toggle($, 'hide:office')}>
            <Text dimColor>{showOffice ? '▾ Office view (click to hide)' : '▸ Show office view'}</Text>
          </Button>
        )}
        {showOffice && (
          <Box>
            {(['pipeline', 'route', 'office'] as const).map(v => {
              const isCurrent = (open.includes('view:office') ? 'office' : open.includes('view:route') ? 'route' : 'pipeline') === v
              return (
                <Button key={'v-' + v} onPress={() => setView($, v)}>
                  <Text color={isCurrent ? 'cyan' : undefined} dimColor={!isCurrent}>{isCurrent ? '● ' : '○ '}{v === 'pipeline' ? 'Pipeline' : v === 'route' ? 'Route map' : 'Office'}  </Text>
                </Button>
              )
            })}
          </Box>
        )}
        {showOffice && open.includes('view:route') && (
          <Button key="b-theme" onPress={() => toggle($, 'theme:dark')}>
            <Text dimColor>{open.includes('theme:dark') ? '◐ Switch to light look' : '◐ Switch to dark look'}</Text>
          </Button>
        )}
        {showOffice && (
          <Button key="b-anim" onPress={() => toggle($, animDefault ? 'anim:off' : 'anim:on')}>
            <Text dimColor>{(animDefault ? !open.includes('anim:off') : open.includes('anim:on')) ? '◼ Pause animation' : '▶ Play animation'}</Text>
          </Button>
        )}
        <Text weight="bold" color={color(head.tone)}>
          {head.title}
        </Text>
        <Text color={head.live ? 'cyan' : undefined}>
          {bar(head.pct, width, frame, head.live)} {head.pct === undefined ? 'progress n/a' : head.pct + '%'}
        </Text>
        {head.lines.map(l => (
          <Text color={color(l.tone)} dimColor={l.tone === 'dim'}>
            {unhide(l.text)}
          </Text>
        ))}
        <Text dimColor>{m.curTask ? `Now: ${m.curTask.label}` : 'Start a task to see live activity'}</Text>
        <Text dimColor>— agents (click one for details) —</Text>
        {m.order.map(id => {
          const row = agentRow(m, id, now, hist, frame)
          const isOpen = open.includes('agent:' + id)
          return (
            <Box flexDirection="column">
              <Button key={'a-' + id} onPress={() => toggle($, 'agent:' + id)}>
                <Text color={color(row.tone)}>
                  {isOpen ? '▾ ' : '▸ '}
                  {row.text}
                </Text>
              </Button>
              {isOpen && S.agentLines(m, m.agents[id] as never, now, hist).map(renderLine)}
            </Box>
          )
        })}
        <Text dimColor>— more detail (click to open / close) —</Text>
        <Box>
          {SECTIONS.map(s => (
            <Button key={'b-' + s.key} onPress={() => toggle($, s.key)}>
              <Text color={open.includes(s.key) ? 'cyan' : undefined}>{open.includes(s.key) ? '▾' : '▸'} {s.label}  </Text>
            </Button>
          ))}
          <Button key="b-all" onPress={() => setOpen($, isAll ? [] : allKeys)}>
            <Text>{isAll ? '[collapse all]' : '[expand all]'}</Text>
          </Button>
        </Box>
        {SECTIONS.filter(s => open.includes(s.key)).map(s => {
          const sec = s.make()
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text weight="bold" color="cyan">
                {sec.title}
              </Text>
              {sec.lines.map(l => (l.bar ? <Text>{bar(l.bar.pct, 20, frame, false)} {l.bar.pct}%</Text> : renderLine(l)))}
            </Box>
          )
        })}
      </Box>
    )
    } catch {
      // A bad value must blank this view at most, never the session.
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Agent Command Center could not draw this view. Run /agent-diagnostics.</Text>
    }
  })
}
