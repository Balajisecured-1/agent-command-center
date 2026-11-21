// Pure reducer: engine events -> monitor model. No engine calls, no LLM calls.
import type { Agent, Evt, Handoff, Model, RateLimit, Src, Tokens, Todo } from '../types'

export const SHAPE = 'acc-3'
export const MAIN = 'main'
/** Agent lookup for ids the reducer has already ensured exist. */
export const ag = (m: Model, id: string): Agent => m.agents[id] as Agent
const EVENT_CAP = 300
const SEEN_CAP = 400
const RECENT_CAP = 60

// Plain comparisons: these run for every agent on hot paths.
const liveStatus = (s: string) => s === 'starting' || s === 'running' || s === 'waiting'
const busyStatus = (s: string) => s === 'starting' || s === 'running'
const zero = (): Tokens => ({ i: 0, o: 0, cr: 0, cc: 0, n: 0 })

export function newModel(sessionId: string, now: number): Model {
  const m: Model = {
    sessionId,
    sessionStart: now,
    requests: 0,
    agents: {},
    order: [],
    handoffs: [],
    tasks: {},
    running: {},
    failedTools: [],
    tokens: { total: zero(), byModel: {}, byAgent: {}, seen: [], recent: [] },
    retries: { count: 0, ms: 0 },
    turnErrors: 0,
    interruptions: 0,
    compactions: { count: 0 },
    models: { changes: [] },
    events: [],
    requestsLog: [],
    cov: {},
    quotaHist: [],
    toasts: [],
    alerted: [],
  }
  m.agents[MAIN] = mkAgent(MAIN, 'main session', 'Main conversation', now)
  ag(m, MAIN).status = 'idle'
  ag(m, MAIN).activity = 'waiting for a task'
  m.order.push(MAIN)
  return m
}

function mkAgent(id: string, type: string, task: string, t: number): Agent {
  return {
    id,
    type,
    task,
    status: 'starting',
    startedAt: t,
    lastActivityAt: t,
    activity: 'starting',
    activitySrc: 'actual',
    activeMs: 0,
    tools: 0,
    toolFails: 0,
    tokens: zero(),
  }
}

export type EvBody =
  | { k: 'session.start'; t: number; sessionId: string }
  | { k: 'session.end'; t: number; reason: string }
  | { k: 'request.start'; t: number; text: string }
  | { k: 'turn.start'; t: number; agentId?: string }
  | {
      k: 'turn.end'
      t: number
      agentId?: string
      turnId: string
      durationMs: number
      reason: string
      usage?: { i: number; o: number; cr: number; cc: number; model: string }
    }
  | {
      k: 'spawn'
      t: number
      agentId?: string
      parentId?: string
      type: string
      name?: string
      desc: string
      prompt: string
      model?: string
      denied?: string
    }
  | { k: 'agent.start'; t: number; agentId: string; type: string }
  | { k: 'agent.stop'; t: number; agentId: string; type: string; last?: string }
  | {
      k: 'report'
      t: number
      agentId: string
      parentId?: string
      type: string
      status: 'completed' | 'failed' | 'stopped'
      text: string
    }
  | { k: 'tool.start'; t: number; id: string; tool: string; key: string; summary: string; agentId?: string }
  | {
      k: 'tool.end'
      t: number
      id: string
      tool: string
      agentId?: string
      ok: boolean
      durationMs?: number
      error?: string
      key: string
      todos?: Todo[]
      summary: string
    }
  | { k: 'task.created' | 'task.completed'; t: number; id: string; subject: string; who?: string }
  | { k: 'idle'; t: number; who: string }
  | { k: 'model'; t: number; from: string; to: string }
  | { k: 'compact'; t: number; phase: 'pre' | 'post'; trigger: string }
  | { k: 'interrupt'; t: number; running: boolean }
  | {
      k: 'measure'
      t: number
      rateLimits: RateLimit[]
      ctxTokens?: number
      ctxWindow?: number
      ctxPercent?: number
      costUsd?: number
    }
  | { k: 'notify'; t: number; text: string; type?: string; agentId?: string }
  | { k: 'stopfail'; t: number; error: string }
  | { k: 'title'; t: number; title: string }
  | { k: 'drain'; t: number }

/** Every event is stamped with the id of the chat it came from; a model only accepts events of its own chat. */
export type Ev = EvBody & { chat?: string }

// Everything the mod records (prompts, commands, paths, agent outputs) passes through clip(), and the model is
// persisted. Credentials must never be kept, so well-known secret shapes are masked before anything is stored.
const TOKEN_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,300}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,200}/g,
  /\bwhsec_[A-Za-z0-9]{10,200}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,300}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,300}/g,
  /\bglpat-[A-Za-z0-9_-]{16,100}/g,
  /\bhf_[A-Za-z0-9]{20,100}/g,
  /\bSG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}/g,
  /\bnpm_[A-Za-z0-9]{30,200}/g,
  /\bya29\.[A-Za-z0-9_-]{20,500}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:AC|SK)[0-9a-f]{32}\b/g,
  /\b[0-9a-f]{32,64}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,300}/g,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]{10,200}/g,
  /\bAIza[0-9A-Za-z_-]{30,100}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,512}=*/gi,
  /\bAuthorization:\s*(?:Token|Digest|ApiKey)\s+\S{8,512}/gi,
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,6000}?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
  /\bAccountKey=[A-Za-z0-9+/=]{20,200}/g,
  /\bSharedAccessSignature=\S{10,500}/g,
]
const SECRET_NAMES = 'password|passwd|pwd|passphrase|secret|secret[_-]?key|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key'
// `DB_PASSWORD=x`, `"client_secret": "x y"`, `accessToken: x`: the name may follow `_` or `-`, so no word boundary is used.
const NAMED_SECRET = new RegExp(`(?<![A-Za-z0-9])(${SECRET_NAMES})(["']?\\s*[=:]\\s*)(?:"[^"]{1,300}"|'[^']{1,300}'|[^\\s,;]{1,300})`, 'gi')
// `the password is hunter2`
const SPOKEN_SECRET = /\b(password|passwd|passphrase|pin|api key|secret)\s+(?:is|was|=)\s+\S{1,200}/gi
// `--password hunter2`, `--token=abc`, `curl -u user:pass`
const FLAG_SECRET = new RegExp(`(--(?:${SECRET_NAMES})(?:=|\\s+))[^\\s"']{1,300}`, 'gi')
const CURL_USER = /(\s-u\s+)[^\s:]{1,100}:\S{1,200}/g
// `?token=abc&sig=...`, `password%3Dhunter2`
const QUERY_SECRET = /([?&](?:token|key|sig|signature|auth|apikey|api_key|access_token|secret|password|code)=)[^&\s]{1,300}/gi
const ENCODED_SECRET = new RegExp(`(${SECRET_NAMES})(%3[Dd])\\S{1,200}`, 'gi')
// `scheme://user:pass@host`, also when the password contains an `@`
const URL_CREDENTIALS = /(:\/\/[^\s:/@]{1,100}:)[^\s/]{1,200}@(?=[^@\s/]+(?:[/?\s]|$))/g
// Control characters (terminal escapes, bidi overrides, zero-width, NUL) are never kept: they spoof terminals,
// break XML and are used to split a secret so a pattern cannot see it.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
// One case-insensitive pass over all key shapes first: the 22 precise passes only run when something may match.
const ANY_TOKEN = new RegExp(TOKEN_SHAPES.map(r => `(?:${r.source})`).join('|'), 'i')
// The name-based patterns all need one of these characters or words.
const MAYBE_NAMED = /[=:%?]|--|\s-u\s|\s(?:is|was)\s/i
export const redact = (s: string) => {
  let out = s.length > 6000 ? s.slice(0, 6000) : s
  if (ANY_TOKEN.test(out)) for (const re of TOKEN_SHAPES) out = out.replace(re, '[redacted]')
  if (!MAYBE_NAMED.test(out)) return out
  return out
    .replace(NAMED_SECRET, '$1$2[redacted]')
    .replace(SPOKEN_SECRET, '$1 [redacted]')
    .replace(FLAG_SECRET, '$1[redacted]')
    .replace(CURL_USER, '$1[redacted]')
    .replace(QUERY_SECRET, '$1[redacted]')
    .replace(ENCODED_SECRET, '$1$2[redacted]')
    .replace(URL_CREDENTIALS, '$1[redacted]@')
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Small base64 decoder (the module has no Node or DOM); returns '' when the text is not base64. */
const unb64 = (t: string): string => {
  const c = t.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  let bits = 0, acc = 0, out = ''
  for (const ch of c) {
    const v = B64.indexOf(ch)
    if (v < 0) return ''
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 255)
    }
  }
  return out
}
const hidden = (base: string): string => {
  // A secret split by whitespace or newlines, or spaced out letter by letter, only shows once the gaps are removed.
  if (/\s/.test(base)) {
    const squeezed = base.replace(/\s+/g, '')
    if (ANY_TOKEN.test(squeezed)) for (const re of TOKEN_SHAPES) {
      re.lastIndex = 0
      if (re.test(squeezed)) return '[redacted: obfuscated secret]'
    }
    // a key prefix that only appears once the gaps are closed, even if the rest is short
    const pre = /(?:sk-ant|sk-proj|sk_live|sk_test|github_pat|ghp_|gho_|xox[baprs]-|AKIA|AIza|eyJ)/i
    if (pre.test(squeezed) && !pre.test(base)) return '[redacted: obfuscated secret]'
  }
  // base64 that decodes to something secret-shaped (`password=...`, `sk-...`)
  let out = base
  let n = 0
  for (const tok of base.match(/[A-Za-z0-9+/_-]{16,400}={0,2}/g) ?? []) {
    if (++n > 40) break
    const d = unb64(tok)
    if (d.length >= 8 && /^[ -~\s]+$/.test(d) && redact(d) !== d) out = out.split(tok).join('[redacted]')
  }
  // Catch-all for shapes nobody listed: a long token that mixes letters and digits and looks random is masked.
  let k = 0
  out = out.replace(/[A-Za-z0-9+/_=-]{20,200}/g, tok => {
    if (++k > 60 || !/[A-Za-z]/.test(tok) || !/[0-9]/.test(tok)) return tok
    const freq: Record<string, number> = Object.create(null)
    for (const c of tok) freq[c] = (freq[c] ?? 0) + 1
    let h = 0
    for (const c in freq) { const p = (freq[c] as number) / tok.length; h -= p * Math.log2(p) }
    return h >= 3.3 ? '[redacted]' : tok
  })
  return out
}
const MAX_SCAN = 6000 // input is cut before any regex runs, so hostile megabyte strings cost nothing
// Ids, types and model names repeat on every event, so the cleaned form of a string is remembered.
const memo = new Map<string, string>()
// Under 20 characters, letters, digits, `-`, `_` and `.` only, and no known key prefix: no secret pattern
// (all need `=`, `:`, a space, a known prefix, or 20+ characters) can match, so the full scan is skipped.
const KEY_PREFIX = /(?:sk|pk|rk)[-_]|whsec_|xox[baprs]-|AKIA|gh[pousr]_|github_|glpat-|hf_|npm_|SG\.|ya29|AIza|eyJ|AC[0-9a-f]|SK[0-9a-f]/
const plainId = (s: string) => s.length < 20 && /^[A-Za-z0-9_.-]+$/.test(s) && !KEY_PREFIX.test(s)
const scrub = (raw: string) => {
  const hit = memo.get(raw)
  if (hit !== undefined) return hit
  // Normalise first (fullwidth letters, zero-width splits), then look for secrets. Under 8 characters nothing can match.
  const base = raw.slice(0, MAX_SCAN).normalize('NFKC').replace(CONTROL, '')
  const out = base.length < 8 || plainId(base) ? base : hidden(redact(base))
  if (raw.length <= 200) {
    if (memo.size > 800) memo.clear()
    memo.set(raw, out)
  }
  return out
}
const clip = (s: string, n = 140) => {
  const one = scrub(String(s ?? '')).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const fnv = (s: string, seed = 0x811c9dc5): number => {
  let h = seed >>> 0
  const n = Math.min(s.length, 20000)
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
const idMemo = new Map<string, string>()
/**
 * Ids and names (tool and turn ids, agent types, model and tool names): normalised, bounded and safe as an object key.
 * The looks-random check is NOT applied here, because tool ids, turn ids and model names are meant to look random;
 * masking them would merge different turns into one. An id that carries a real key shape is replaced by a
 * fingerprint instead, so the key is never stored and different ids stay different.
 */
export const ident = (x: unknown): string => {
  const raw = typeof x === 'string' ? x : String(x ?? '')
  const hit = idMemo.get(raw)
  if (hit !== undefined) return hit
  const base = raw.slice(0, 400).normalize('NFKC').replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  let s = base.length < 8 || plainId(base) || redact(base) === base ? base : `id-${fnv(base).toString(36)}`
  if (s.length > 64) s = `${s.slice(0, 48)}~${fnv(s).toString(36)}`
  if (s in {}) s = `k_${s}`
  if (raw.length <= 400) {
    if (idMemo.size > 2000) idMemo.clear()
    idMemo.set(raw, s)
  }
  return s
}
export const clipText = clip

function log(m: Model, t: number, k: string, src: Src, text: string, who?: string) {
  m.events.push({ t, k, src, who, text: clip(text, 200) } as Evt)
  if (m.events.length > EVENT_CAP) m.events.splice(0, m.events.length - EVENT_CAP)
}

function ensure(m: Model, id: string, type: string, t: number, task = ''): Agent {
  let a = wa(m, id)
  if (!a) {
    a = mkAgent(id, type, task || type, t)
    copied.add(a)
    own(m, 'agents')[id] = a
    m.order.push(id)
  }
  return a
}

const aid = (id?: string) => id || MAIN

function openTurn(a: Agent, t: number) {
  if (a.turnOpenAt === undefined) a.turnOpenAt = t
  a.lastActivityAt = t
}
function closeTurn(a: Agent, t: number) {
  if (a.turnOpenAt !== undefined) {
    a.activeMs += Math.max(0, t - a.turnOpenAt)
    a.turnOpenAt = undefined
  }
  a.lastActivityAt = t
}

function addTokens(into: Tokens, u: { i: number; o: number; cr: number; cc: number }) {
  into.i += u.i
  into.o += u.o
  into.cr += u.cr
  into.cc += u.cc
  into.n += 1
}

function liveChildren(m: Model, parent: string) {
  return Object.values(m.agents)
    .filter(a => a.id !== MAIN && (a.parentId || MAIN) === parent && liveStatus(a.status))
}

function refreshMain(m: Model) {
  const a = wa(m, MAIN)
  if (a.status === 'completed' || a.status === 'failed') return
  const kids = liveChildren(m, MAIN)
  if (a.turnOpenAt !== undefined) {
    if (kids.length) {
      a.status = 'waiting'
      a.activity = `waiting on ${kids.length} agent(s): ${kids.map(k => k.type).join(', ')}`
      a.activitySrc = 'inferred'
    } else if (a.status === 'waiting') {
      a.status = 'running'
    }
  }
}

function setTodos(a: Agent, todos: Todo[]) {
  a.todos = todos.map(t => ({ content: clip(String(t.content ?? ''), 90), status: String(t.status ?? 'pending') }))
}

/** `strict`: record no free text at all (prompts, commands, outputs, errors); only names, counts and times. */
export type Cfg = { alerts: boolean; quotaWarn: number; ctxWarn: number; strict?: boolean }
export const DEFAULT_CFG: Cfg = { alerts: true, quotaWarn: 80, ctxWarn: 85 }
const TOOL_STALE_MS = 30 * 60 * 1000
const RUNNING_CAP = 60

function toast(m: Model, cfg: Cfg, text: string, key?: string) {
  if (!cfg.alerts) return
  if (key) {
    if (m.alerted.includes(key)) return
    m.alerted.push(key)
    if (m.alerted.length > 80) m.alerted.shift()
  }
  m.toasts.push(`Agent Command Center: ${text}`)
  if (m.toasts.length > 5) m.toasts.shift()
}
const clearAlert = (m: Model, prefix: string) => {
  m.alerted = m.alerted.filter(k => !k.startsWith(prefix))
}
const diff = (a: Tokens, b: Tokens): Tokens => ({ i: Math.max(0, a.i - b.i), o: Math.max(0, a.o - b.o), cr: Math.max(0, a.cr - b.cr), cc: Math.max(0, a.cc - b.cc), n: Math.max(0, a.n - b.n) })
const curReq = (m: Model) => m.requestsLog[m.requestsLog.length - 1]


const ID_KEYS = ['agentId', 'parentId', 'id', 'who', 'type', 'name', 'from', 'to', 'tool', 'model', 'skill', 'turnId', 'sessionId'] as const
const TEXT_KEYS = ['denied', 'error', 'reason', 'trigger', 'title', 'text', 'desc', 'prompt', 'last', 'summary', 'subject'] as const

/** Free text that `strict` privacy never records: prompts, commands, file paths, outputs, errors, titles, task names. */
const HIDE_KEYS = ['text', 'prompt', 'summary', 'last', 'error', 'desc', 'subject', 'denied', 'title'] as const
export const HIDDEN = '(private)'
/** Strict mode stores `(private)` instead of text. Screens show a clean label instead: `Request #1`, not `Request #1: (private)`. */
export const unhide = (s: string): string =>
  s.includes(HIDDEN) ? s.replace(/(?:\s*[:—–-]\s*)?\(private\)/g, '').replace(/\s{2,}/g, ' ').trim() : s

// Tool inputs are compared for retry detection by a keyed fingerprint, so the input itself is never kept. The two
// 32-bit keys are random per process and live only in memory: the stored fingerprint cannot be checked against
// guesses (`unzip -P 1234 ...`) without them, and it does not record the input's length.
const rnd = () => (Math.random() * 0x100000000) >>> 0
const SALT = [rnd(), rnd()] as const
const fingerprint = (s: string): string => `#${fnv(s, SALT[0]).toString(36)}${fnv(s, SALT[1]).toString(36)}`

/** Everything that enters the reducer is bounded, stripped of control characters and made safe to use as a key. */
function cleanEv(ev: Ev, strict = false): Ev {
  const e = { ...ev } as Record<string, unknown>
  if (typeof e.key === 'string') e.key = fingerprint(e.key)
  else if (e.key !== undefined) e.key = fingerprint(String(e.key))
  // a skill's name is a label, not content: keep it in strict mode, drop any arguments after it
  const skill = strict && e.tool === 'Skill' && typeof e.summary === 'string' ? (/^[A-Za-z0-9:._-]{1,60}$/.exec(e.summary.trim())?.[0] ?? '') : ''
  for (const k of ID_KEYS) if (typeof e[k] === 'string') e[k] = ident(e[k])
  for (const k of TEXT_KEYS) if (typeof e[k] === 'string') e[k] = clip(e[k] as string, k === 'text' || k === 'prompt' ? 2000 : 300)
  const u = e.usage as Record<string, unknown> | undefined
  if (u && typeof u === 'object') {
    const n = (x: unknown) => (typeof x === 'number' && isFinite(x) && x > 0 ? Math.min(MAX_TOKENS, x) : 0)
    e.usage = { i: n(u.i), o: n(u.o), cr: n(u.cr), cc: n(u.cc), model: ident(u.model) }
  }
  if (Array.isArray(e.todos)) e.todos = (e.todos as { content?: unknown; status?: unknown }[]).slice(0, 50).map(t => ({ content: clip(String(t?.content ?? ''), 90), status: ident(t?.status) }))
  if (Array.isArray(e.rateLimits)) {
    e.rateLimits = (e.rateLimits as { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }[]).slice(0, 8).map(r => ({
      kind: ident(r?.kind),
      percentUsed: typeof r?.percentUsed === 'number' && isFinite(r.percentUsed) ? Math.min(1000, Math.max(0, r.percentUsed)) : 0,
      resetsAt: typeof r?.resetsAt === 'string' ? clip(r.resetsAt, 40) : undefined,
    }))
  }
  for (const k of ['ctxTokens', 'ctxWindow', 'ctxPercent', 'costUsd'] as const) {
    if (e[k] === undefined) continue
    if (typeof e[k] !== 'number' || !isFinite(e[k] as number)) delete e[k]
    else e[k] = Math.min(MAX_TOKENS, Math.max(0, e[k] as number))
  }
  if (strict) {
    for (const k of HIDE_KEYS) if (typeof e[k] === 'string' && e[k] !== '') e[k] = HIDDEN
    if (skill) e.summary = skill
    if (Array.isArray(e.todos)) e.todos = (e.todos as Todo[]).map((t, i) => ({ content: `task ${i + 1}`, status: t.status }))
  }
  if (e.durationMs !== undefined) e.durationMs = typeof e.durationMs === 'number' && isFinite(e.durationMs) ? Math.min(MAX_MS, Math.max(0, e.durationMs)) : 0
  return e as Ev
}

const MAX_TOKENS = 1e12
const MAX_MS = 1e10 // about 115 days
const MAX_TIME = 8.64e15 // the largest value a Date can hold
const CAP_AGENTS = 120
const CAP_TASKS = 200

/** Hard bounds, so hostile or runaway input cannot grow the model (and every clone of it) without limit. */
function prune(m: Model) {
  // Only agents can overflow here: tasks, token maps and todo lists are capped where they grow.
  if (m.order.length <= CAP_AGENTS) {
    if (m.models.changes.length > 30) m.models.changes.splice(0, m.models.changes.length - 30)
    return
  }
  const agents = own(m, 'agents')
  const byAgent = own(m.tokens, 'byAgent')
  const drop = new Set<string>()
  let over = m.order.length - CAP_AGENTS
  // the oldest finished agents go first; never the main agent, and a live one only if nothing else is left
  for (const id of m.order) {
    if (over <= 0) break
    const a = agents[id]
    if (id === MAIN || (a && liveStatus(a.status))) continue
    drop.add(id)
    over--
  }
  for (const id of m.order) {
    if (over <= 0) break
    if (id === MAIN || drop.has(id)) continue
    drop.add(id)
    over--
  }
  for (const id of drop) {
    delete agents[id]
    delete byAgent[id]
  }
  m.order = m.order.filter(x => !drop.has(x))
  if (m.models.changes.length > 30) m.models.changes.splice(0, m.models.changes.length - 30)
}

export function reduce(prev: Model, ev: Ev, cfg: Cfg = DEFAULT_CFG): Model {
  // One model is one chat. An event stamped with another chat's id is not recorded or reacted to: it is only counted.
  if (typeof ev.chat === 'string' && prev.sessionId !== '' && ev.k !== 'session.start' && ident(ev.chat) !== prev.sessionId) {
    return { ...prev, cov: { ...(prev.cov ?? {}), foreign: ((prev.cov ?? {}).foreign ?? 0) + 1 } }
  }
  const clean = cleanEv(ev, cfg.strict === true)
  if (!(typeof clean.t === 'number' && isFinite(clean.t) && clean.t >= 0 && clean.t <= MAX_TIME)) {
    clean.t = prev.events[prev.events.length - 1]?.t ?? prev.sessionStart ?? 0
  }
  const m = reduceInner(prev, clean, cfg)
  prune(m)
  return m
}

// Copy-on-write bookkeeping for the one reduce() call in progress (the reducer is synchronous).
let copied = new Set<object>()
/** The map `o[k]`, copied the first time this event writes to it (maps are shared with the previous model). */
function own<O extends object, K extends keyof O>(o: O, k: K): O[K] {
  const v = o[k] as unknown as object
  if (copied.has(v)) return o[k]
  const c = { ...v }
  copied.add(c)
  o[k] = c as O[K]
  return o[k]
}
/** The agent `id`, copied the first time this event writes to it. */
function wa(m: Model, id: string): Agent {
  const a = m.agents[id] as Agent
  if (!a || copied.has(a)) return a
  const c = { ...a, tokens: tok(a.tokens) }
  copied.add(c)
  own(m, 'agents')[id] = c
  return c
}
/** The handoff `h`, copied the first time this event writes to it. */
function wh(m: Model, h: Handoff): Handoff {
  if (copied.has(h)) return h
  const c = { ...h }
  copied.add(c)
  const i = m.handoffs.indexOf(h)
  if (i >= 0) m.handoffs[i] = c
  return c
}
/** Add usage to a shared token counter without touching the previous model's object. */
function bump(map: Record<string, Tokens>, key: string, u: { i: number; o: number; cr: number; cc: number }) {
  const c = tok(map[key])
  addTokens(c, u)
  map[key] = c
}
const tok =(x: Tokens | undefined): Tokens => (x ? { i: x.i, o: x.o, cr: x.cr, cc: x.cc, n: x.n } : zero())

/**
 * Copy exactly what the reducer may change, and share what it never changes (log entries, samples, todo lists,
 * which are only ever replaced). Same result as a deep clone at a fraction of the cost; the purity test freezes
 * the previous model, so any write to a shared object fails that test.
 */
function cloneModel(p: Model): Model {
  copied = new Set()
  return {
    ...p,
    request: p.request ? { ...p.request } : undefined,
    // agents, handoffs, tasks and token counters are shared and copied on first write (wa, wh, wt, bump)
    agents: p.agents,
    order: p.order.slice(),
    handoffs: p.handoffs.slice(),
    tasks: p.tasks,
    running: p.running,
    failedTools: p.failedTools.slice(),
    curTask: p.curTask ? { ...p.curTask } : undefined,
    tokens: {
      total: tok(p.tokens.total),
      byModel: p.tokens.byModel,
      byAgent: p.tokens.byAgent,
      seen: p.tokens.seen.slice(),
      recent: p.tokens.recent.slice(),
    },
    retries: { ...p.retries },
    compactions: { ...p.compactions },
    models: { ...p.models, changes: p.models.changes.slice() },
    events: p.events.slice(),
    requestsLog: p.requestsLog.map(r => ({ ...r })),
    cov: { ...(p.cov ?? {}) },
    quotaHist: p.quotaHist.slice(),
    toasts: p.toasts.slice(),
    alerted: p.alerted.slice(),
  }
}

function reduceInner(prev: Model, ev: Ev, cfg: Cfg): Model {
  const m: Model = cloneModel(prev)
  m.cov ??= {}
  m.cov[ev.k] = (m.cov[ev.k] ?? 0) + 1
  const t = ev.t
  const main = wa(m, MAIN)

  switch (ev.k) {
    case 'session.start': {
      m.endedAt = undefined
      log(m, t, 'session.start', 'actual', 'Session started')
      break
    }
    case 'session.end': {
      m.endedAt = t
      for (const id of Object.keys(m.agents)) closeTurn(wa(m, id), t)
      log(m, t, 'session.end', 'actual', `Session ended (${ev.reason})`)
      break
    }
    case 'request.start': {
      m.requests += 1
      m.request = { n: m.requests, text: clip(ev.text, 160), startAt: t }
      m.running = {}
      m.failedTools = []
      m.requestsLog.push({ n: m.requests, text: clip(ev.text, 100), startAt: t, base: tok(m.tokens.total), agents: 0, tools: 0, toolFails: 0, retries: 0, outcome: 'running' })
      if (m.requestsLog.length > 20) m.requestsLog.shift()
      m.curTask = { label: clip(ev.text, 90), since: t, src: 'actual' }
      main.status = 'running'
      main.activity = 'processing request'
      main.activitySrc = 'actual'
      main.endedAt = undefined
      log(m, t, 'request.start', 'actual', `Request #${m.requests}: ${clip(ev.text, 120)}`, MAIN)
      break
    }
    case 'turn.start': {
      const id = aid(ev.agentId)
      const a = ensure(m, id, id === MAIN ? 'main session' : 'agent', t)
      openTurn(a, t)
      if (id === MAIN) {
        if (m.request?.endAt) {
          // A continuation turn with no new prompt: the request is still going.
          m.request.endAt = undefined
        }
        if (!m.request) m.request = { n: ++m.requests, text: '(continued work)', startAt: t }
        a.status = 'running'
        a.activity = 'thinking'
        a.activitySrc = 'actual'
        refreshMain(m)
      } else {
        if (a.ackAt === undefined) {
          a.ackAt = t
          ackHandoff(m, id, t)
        }
        a.status = 'running'
        a.activity = 'thinking'
        a.activitySrc = 'actual'
        refreshMain(m)
      }
      break
    }
    case 'turn.end': {
      const id = aid(ev.agentId)
      const a = ensure(m, id, id === MAIN ? 'main session' : 'agent', t)
      closeTurn(a, t)
      if (ev.usage && !m.tokens.seen.includes(ev.turnId)) {
        m.tokens.seen.push(ev.turnId)
        if (m.tokens.seen.length > SEEN_CAP) m.tokens.seen.splice(0, m.tokens.seen.length - SEEN_CAP)
        addTokens(m.tokens.total, ev.usage)
        const byModel = own(m.tokens, 'byModel')
        bump(byModel, ev.usage.model, ev.usage)
        const bm = Object.keys(byModel)
        if (bm.length > 30) for (const k of bm.slice(0, bm.length - 30)) delete byModel[k]
        const byAgent = own(m.tokens, 'byAgent')
        bump(byAgent, id, ev.usage)
        const ba = Object.keys(byAgent)
        if (ba.length > CAP_AGENTS + 20) for (const k of ba.slice(0, ba.length - CAP_AGENTS)) delete byAgent[k]
        addTokens(a.tokens, ev.usage)
        m.tokens.recent.push({ turnId: ev.turnId, agent: id, t, ...ev.usage })
        if (m.tokens.recent.length > RECENT_CAP) m.tokens.recent.splice(0, m.tokens.recent.length - RECENT_CAP)
        m.models.current = ev.usage.model
        a.model = ev.usage.model
      }
      if (ev.reason === 'error') {
        m.turnErrors += 1
        log(m, t, 'turn.error', 'actual', `Turn ended with an API error`, id)
      }
      if (ev.reason === 'aborted') {
        log(m, t, 'turn.aborted', 'actual', `Turn interrupted`, id)
      }
      if (id === MAIN) {
        if (m.request) m.request.endAt = t
        const rq = curReq(m)
        if (rq && rq.outcome === 'running') {
          rq.endAt = t
          rq.tok = diff(m.tokens.total, rq.base)
          rq.outcome = ev.reason === 'aborted' ? 'interrupted' : ev.reason === 'error' || ev.reason === 'refusal' ? 'error' : 'done'
          if (ev.reason === 'answer') toast(m, cfg, `Request #${rq.n} finished in ${Math.round((t - rq.startAt) / 1000)}s · ${rq.agents} agent(s) · ${(rq.tok.i + rq.tok.o + rq.tok.cr + rq.tok.cc).toLocaleString('en-US')} tokens`)
        }
        const kids = liveChildren(m, MAIN)
        main.status = kids.length ? 'waiting' : 'idle'
        main.activity = kids.length ? `waiting on ${kids.length} agent(s)` : 'idle (turn finished)'
        main.activitySrc = kids.length ? 'inferred' : 'actual'
        main.endedAt = t
        // finalize time: how long the main loop took after the last agent report
        log(m, t, 'turn.end', 'actual', `Main turn ${ev.reason} in ${Math.round(ev.durationMs / 100) / 10}s`, MAIN)
      } else {
        // a subagent turn ended; it is now waiting to be reported/stopped (not yet confirmed done)
        if (busyStatus(a.status)) {
          a.status = ev.reason === 'error' ? 'failed' : 'waiting'
          a.activity = a.status === 'failed' ? 'turn ended with an error' : 'turn finished, awaiting report'
          a.activitySrc = 'inferred'
        }
        refreshMain(m)
      }
      break
    }
    case 'spawn': {
      const parent = aid(ev.parentId)
      const id = ev.agentId || `pending-${m.cov.spawn ?? m.handoffs.length + 1}`
      const a = ensure(m, id, ev.type, t, ev.desc || ev.type)
      a.type = ev.type
      a.name = ev.name
      a.spawnedAt = t
      a.task = clip(ev.desc || ev.prompt, 120)
      a.parentId = parent
      a.model = ev.model
      if (ev.denied) {
        a.status = 'failed'
        a.activity = `spawn refused: ${ev.denied}`
        a.endedAt = t
      } else if (a.status === 'starting') {
        a.activity = 'spawned, awaiting start'
        a.activitySrc = 'actual'
      }
      const src = ag(m, parent) ? wa(m, parent) : main
      const done = (src.todos || []).filter(x => x.status === 'completed').length
      const pend = (src.todos || []).filter(x => x.status !== 'completed').length
      const h: Handoff = {
        id: `h${m.cov.spawn ?? m.handoffs.length + 1}`,
        from: parent,
        to: id,
        toType: ev.type,
        task: clip(ev.desc ? `${ev.desc} — ${ev.prompt}` : ev.prompt, 200),
        spawnedAt: t,
        // the agent may have started before its spawn was recorded: then the handoff is already acknowledged
        status: ev.denied ? 'refused' : a.ackAt !== undefined ? 'acknowledged' : 'dispatched',
        ackAt: ev.denied ? undefined : a.ackAt,
        sourceDone: src.todos ? `${done} subtask(s) done in source` : `${src.tools} tool call(s) by source (no task list)`,
        remaining: src.todos ? `${pend} subtask(s) still open in source` : 'unknown (source exposes no task list)',
      }
      m.handoffs.push(h)
      if (m.handoffs.length > 80) m.handoffs.splice(0, m.handoffs.length - 80)
      src.nextHandoff = `${ev.type}`
      const rqs = curReq(m)
      if (rqs) rqs.agents += 1
      log(m, t, 'handoff.dispatch', 'actual', `${parent} → ${ev.type}: ${clip(ev.desc || ev.prompt, 100)}`, parent)
      refreshMain(m)
      break
    }
    case 'agent.start': {
      if (!ag(m, ev.agentId)) {
        const pend = m.order.find(id => id.startsWith('pending-') && ag(m, id).type === ev.type && ag(m, id).status === 'starting' && ag(m, id).endedAt === undefined)
        if (pend) {
          const rec = wa(m, pend)
          delete own(m, 'agents')[pend]
          rec.id = ev.agentId
          m.agents[ev.agentId] = rec
          m.order[m.order.indexOf(pend)] = ev.agentId
          for (const h of m.handoffs) if (h.to === pend) wh(m, h).to = ev.agentId
        }
      }
      const a = ensure(m, ev.agentId, ev.type, t)
      a.type = ev.type
      a.ackAt = a.ackAt ?? t
      if (!a.parentId) a.parentId = MAIN
      a.status = 'running'
      a.activity = 'started'
      a.activitySrc = 'actual'
      a.lastActivityAt = t
      ackHandoff(m, ev.agentId, t)
      log(m, t, 'agent.start', 'actual', `Agent started: ${ev.type}`, ev.agentId)
      refreshMain(m)
      break
    }
    case 'agent.stop': {
      const a = ensure(m, ev.agentId, ev.type, t)
      closeTurn(a, t)
      if (!['completed', 'failed', 'stopped'].includes(a.status)) {
        a.status = 'completed'
        a.endedAt = t
        a.activity = 'finished'
        a.activitySrc = 'actual'
      }
      log(m, t, 'agent.stop', 'actual', `Agent stopped: ${ev.type}`, ev.agentId)
      refreshMain(m)
      break
    }
    case 'report': {
      const a = ensure(m, ev.agentId, ev.type, t)
      closeTurn(a, t)
      a.status = ev.status
      a.endedAt = t
      a.activity = ev.status === 'completed' ? 'report delivered' : `ended: ${ev.status}`
      a.activitySrc = 'actual'
      const found = [...m.handoffs].reverse().find(x => x.to === ev.agentId)
      if (found) {
        const h = wh(m, found)
        h.reportAt = t
        h.output = clip(ev.text, 220)
        h.status = ev.status === 'completed' ? 'returned' : ev.status
        h.remaining = ev.status === 'completed' ? 'none reported by destination' : `destination ${ev.status}`
      }
      if (m.request) m.request.lastAgentReportAt = t
      if (ev.status === 'failed') toast(m, cfg, `Agent ${ev.type} failed`)
      log(m, t, 'agent.report', 'actual', `${ev.type} ${ev.status}: ${clip(ev.text, 100)}`, ev.agentId)
      refreshMain(m)
      break
    }
    case 'tool.start': {
      const running = own(m, 'running')
      for (const [k, r] of Object.entries(running)) if (t - r.startAt > TOOL_STALE_MS) delete running[k]
      const ids = Object.keys(running)
      if (ids.length >= RUNNING_CAP) delete running[ids[0] as string]
      running[ev.id] = { id: ev.id, tool: ev.tool, key: ev.key, startAt: t }
      // retry detection (inferred): same tool + same input right after a failure
      const i = m.failedTools.findIndex(f => f.tool === ev.tool && f.key === ev.key)
      if (i >= 0) {
        const f = m.failedTools[i] as (typeof m.failedTools)[number]
        m.retries.count += 1
        const rqr = curReq(m)
        if (rqr) rqr.retries += 1
        m.retries.ms += Math.max(0, t - f.startAt)
        m.failedTools.splice(i, 1)
        log(m, t, 'retry', 'inferred', `Retry of ${ev.tool} (same input as a failed call)`, f.agentId)
      }
      // Current activity. Parallel agents each report their own calls, so the host's agent id decides who ran it
      // (no id means the main thread). Only a host that sends no id at all falls back to "the one live agent".
      let target: Agent | null = main
      let src: 'actual' | 'inferred' = 'actual'
      if (ev.agentId && ag(m, ev.agentId)) target = wa(m, ev.agentId)
      else if (ev.agentId) {
        // a call from an agent whose start has not been seen yet: no record to credit, so it is not guessed at
        src = 'inferred'
        target = null
      } else {
        const live = Object.values(m.agents).filter(a => a.id !== MAIN && busyStatus(a.status))
        if (live.length === 1 && live[0] && main.status === 'waiting') {
          target = wa(m, live[0].id)
          src = 'inferred'
        }
      }
      if (target && (target.status !== 'waiting' || target.id !== MAIN)) {
        target.activity = `${ev.tool}: ${clip(ev.summary, 70)}`
        target.activitySrc = src
      }
      if (target) target.lastActivityAt = t
      break
    }
    case 'tool.end': {
      const run = m.running[ev.id]
      if (run) delete own(m, 'running')[ev.id]
      const a = ensure(m, aid(ev.agentId), aid(ev.agentId) === MAIN ? 'main session' : 'agent', t)
      a.tools += 1
      const rqt = curReq(m)
      if (rqt) {
        rqt.tools += 1
        if (!ev.ok) rqt.toolFails += 1
      }
      a.lastActivityAt = t
      a.activity = `${ev.ok ? 'finished' : 'FAILED'} ${ev.tool}: ${clip(ev.summary, 60)}`
      a.activitySrc = 'actual'
      const start = run?.startAt ?? t - (ev.durationMs ?? 0)
      if (ev.ok) {
        a.blocked = undefined
        if (ev.todos) {
          setTodos(a, ev.todos)
          const cur = ev.todos.find(x => x.status === 'in_progress')
          if (cur && a.id === MAIN) m.curTask = { label: clip(String(cur.content), 90), since: m.curTask?.label === clip(String(cur.content), 90) ? m.curTask.since : t, src: 'actual' }
        }
        if (ev.tool === 'Skill' && ev.summary) {
          a.skill = clip(ev.summary, 40)
          log(m, t, 'skill', 'actual', `Skill used: ${clip(ev.summary, 60)}`, a.id)
        }
        log(m, t, 'tool', 'actual', `${ev.tool} ok${ev.durationMs !== undefined ? ` (${ev.durationMs}ms)` : ''}: ${clip(ev.summary, 80)}`, a.id)
      } else {
        a.toolFails += 1
        a.blocked = `tool failed: ${ev.tool}`
        m.failedTools.push({ tool: ev.tool, key: ev.key, agentId: a.id, startAt: start, endAt: t })
        if (m.failedTools.length > 20) m.failedTools.shift()
        log(m, t, 'tool.fail', 'actual', `${ev.tool} FAILED: ${clip(ev.error || '', 120)}`, a.id)
      }
      break
    }
    case 'task.created': {
      const tasks = own(m, 'tasks')
      tasks[ev.id] = { id: ev.id, subject: clip(ev.subject, 100), who: ev.who, createdAt: t }
      const tk = Object.keys(tasks)
      if (tk.length > CAP_TASKS) for (const k of tk.slice(0, tk.length - CAP_TASKS)) delete tasks[k]
      log(m, t, 'task.created', 'actual', `Task created: ${clip(ev.subject, 100)}${ev.who ? ` (${ev.who})` : ''}`, ev.who)
      break
    }
    case 'task.completed': {
      const r = { ...(m.tasks[ev.id] ?? { id: ev.id, subject: clip(ev.subject, 100), who: ev.who, createdAt: t }) }
      own(m, 'tasks')[ev.id] = r
      r.doneAt = t
      log(m, t, 'task.completed', 'actual', `Task completed: ${clip(ev.subject, 100)}`, ev.who)
      break
    }
    case 'idle': {
      const hit = Object.values(m.agents).find(x => x.id === ev.who || x.type === ev.who)
      const a = hit ? wa(m, hit.id) : undefined
      if (a) {
        a.status = 'idle'
        a.activity = 'idle (teammate idle event)'
        a.activitySrc = 'actual'
      }
      log(m, t, 'idle', 'actual', `${ev.who} is idle`, ev.who)
      break
    }
    case 'model': {
      m.models.changes.push({ t, from: ev.from, to: ev.to })
      m.models.current = ev.to
      log(m, t, 'model', 'actual', `Model changed ${ev.from} → ${ev.to}`)
      break
    }
    case 'compact': {
      if (ev.phase === 'pre') {
        m.compactions.count += 1
        m.compactions.lastTrigger = ev.trigger
        m.compactions.open = true
      } else {
        m.compactions.open = false
      }
      m.compactions.lastAt = t
      log(m, t, 'compact', 'actual', `Context compaction ${ev.phase === 'pre' ? 'started' : 'finished'} (${ev.trigger})`)
      break
    }
    case 'interrupt': {
      m.interruptions += 1
      log(m, t, 'interrupt', 'actual', `Session interrupted${ev.running ? ' while a turn was running' : ''}`)
      if (ev.running) {
        for (const a of Object.values(m.agents)) if (['running', 'starting', 'waiting'].includes(a.status) && a.id !== MAIN) wa(m, a.id).blocked = 'interrupted'
      }
      break
    }
    case 'measure': {
      {
        const five = ev.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed
        const week = ev.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed
        const last = m.quotaHist[m.quotaHist.length - 1]
        if (!last || last.five !== five || last.week !== week) {
          m.quotaHist.push({ t, five, week })
          if (m.quotaHist.length > 40) m.quotaHist.shift()
        }
        for (const [kind, label, v] of [['five_hour', '5-hour', five], ['seven_day', 'weekly', week]] as const) {
          if (v === undefined) continue
          if (v >= 95) toast(m, cfg, `Quota: ${label} limit ${v}% used`, `quota:${kind}:crit`)
          else if (v >= cfg.quotaWarn) toast(m, cfg, `Quota: ${label} limit ${v}% used`, `quota:${kind}:warn`)
          else if (v < cfg.quotaWarn - 10) clearAlert(m, `quota:${kind}`)
        }
        if (ev.ctxPercent !== undefined) {
          if (ev.ctxPercent >= cfg.ctxWarn) toast(m, cfg, `Context window ${ev.ctxPercent}% full`, 'ctx:warn')
          else if (ev.ctxPercent < cfg.ctxWarn - 15) clearAlert(m, 'ctx:')
        }
      }
      m.quota = {
        at: t,
        rateLimits: ev.rateLimits,
        ctxTokens: ev.ctxTokens,
        ctxWindow: ev.ctxWindow,
        ctxPercent: ev.ctxPercent,
        costUsd: ev.costUsd,
      }
      break
    }
    case 'notify': {
      const who = aid(ev.agentId)
      if (ev.type && /permission/i.test(ev.type) && ag(m, who)) {
        wa(m, who).blocked = 'waiting for permission'
        toast(m, cfg, `${ag(m, who).type} is waiting for permission`, `perm:${who}:${Math.floor(t / 60000)}`)
        ag(m, who).status = ag(m, who).status === 'running' ? 'waiting' : ag(m, who).status
      }
      log(m, t, 'notify', 'actual', ev.text, who)
      break
    }
    case 'drain': {
      m.toasts = []
      break
    }
    case 'title': {
      m.title = clip(ev.title, 60)
      break
    }
    case 'stopfail': {
      m.turnErrors += 1
      log(m, t, 'stop.failure', 'actual', `Turn failed: ${ev.error}`, MAIN)
      break
    }
  }
  return m
}

function ackHandoff(m: Model, agentId: string, t: number) {
  const found = [...m.handoffs].reverse().find(x => x.to === agentId)
  if (found && found.ackAt === undefined) {
    const h = wh(m, found)
    h.ackAt = t
    if (h.status === 'dispatched') h.status = 'acknowledged'
  }
}
