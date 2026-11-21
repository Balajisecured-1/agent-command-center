// "Virtual office": a large, top-down animated SVG (SMIL) driven by real agent state.
// Pure and self-contained (no engine calls). Rooms/positions are a visual metaphor derived from
// real hook data; every label shows real names, statuses and numbers.
//
// Choreography per handoff:  parent hands a task -> the new agent walks in, TAKES THE TASK from the
// parent (document travels parent -> agent) -> goes to its desk and works -> on its report it walks
// back to the parent and HANDS OVER the result (document travels agent -> parent) -> rests in the lounge.

export type Room = 'workspace' | 'meeting' | 'manager' | 'lounge' | 'kitchen'

export type Person = {
  id: string
  name: string // real display name: agent name, else its type; main = the chat title
  type: string
  isMain: boolean
  parentId?: string
  status: string // starting|running|waiting|idle|completed|failed|stopped
  blocked?: string
  activity: string
  skill?: string
  handoff?: string // dispatched|acknowledged|returned|...
  spawnedAt?: number
  reportAt?: number
  ageMs: number
  runMs?: number // time worked so far (stops growing when the agent is done)
  pct?: number
  tokens: number
  liveChildren: number
}

export type FeedItem = { who: string; text: string; time: string; tone?: 'bad' | 'warn' | 'ok' }
export type OfficeInput = {
  title: string
  people: Person[]
  stats: { active: number; total: number; running: number; completed: number; pct?: number; tokens: string; request: string; live: boolean }
  feed: FeedItem[]
}

export type Pos = { x: number; y: number }
export type MoveState = Record<string, { room: Room; slot: number; from: Pos; to: Pos; startedAt: number }>

export const W = 760
const MOVE_MS = 2200
const RECEIVE_MS = 3500
const HANDOVER_MS = 4500
const ENTRANCE: Pos = { x: 380, y: 420 }
// Agent identity colours: the dataviz skill's validated dark categorical set (8 slots, fixed order; passes the
// lightness, chroma, CVD and contrast gates on the office surface). Identity is never colour alone: every agent
// also carries its name and a status glyph. A 9th agent reuses a slot; its name still tells it apart.
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']

export const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, n: number) => {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
function wrap2(s: string, n: number): [string, string] {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  if (t.length <= n) return [t, '']
  let cut = t.lastIndexOf(' ', n)
  if (cut < n * 0.5) cut = n
  return [t.slice(0, cut), clip(t.slice(cut).trim(), n)]
}

export function roleOf(p: Person): string {
  if (p.isMain) return 'Manager'
  const t = `${p.type} ${p.name}`.toLowerCase()
  if (/explore|research|search|guide|scout/.test(t)) return 'Research'
  if (/plan|architect/.test(t)) return 'Planner'
  if (/review|verif|test|qa|audit|jury|check/.test(t)) return 'QA'
  if (/design|draw|panel|story|motion/.test(t)) return 'Designer'
  if (/general|dev|build|produc|code|writer/.test(t)) return 'Developer'
  return clip(p.type, 12)
}

export type Placed = Person & {
  color: string
  room: Room
  slot: number
  label: string
  tone: 'ok' | 'warn' | 'bad' | 'live' | 'dim'
  bubble: string
  docFrom?: string // id: a task document travels from this agent to me
  docTo?: string // id: my result document travels from me to this agent
}

export function place(people: Person[], now: number): Placed[] {
  const slots: Record<string, number> = {}
  const desk = { n: 0 }
  const byId: Record<string, Person> = {}
  for (const p of people) byId[p.id] = p
  const out: Placed[] = people.map((p, i) => {
    const parent = (p.parentId && byId[p.parentId]) || people.find(x => x.isMain)
    const parentIsMain = !parent || parent.isMain
    let room: Room
    let tone: Placed['tone'] = 'dim'
    let label = p.status
    let bubble = ''
    let docFrom: string | undefined
    let docTo: string | undefined
    const pname = parent ? clip(parent.name, 12) : 'manager'
    const receiving = !p.isMain && (p.handoff === 'dispatched' || p.status === 'starting' || (p.spawnedAt !== undefined && now - p.spawnedAt < RECEIVE_MS && p.status === 'running'))
    const handing = !p.isMain && p.status === 'completed' && p.reportAt !== undefined && now - p.reportAt < HANDOVER_MS
    if (p.isMain) {
      room = 'manager'
      if (p.liveChildren) {
        label = `Managing ${p.liveChildren}`
        tone = 'live'
        bubble = `Waiting on ${p.liveChildren} agent${p.liveChildren > 1 ? 's' : ''}`
      } else if (p.status === 'running') {
        label = 'Working'
        tone = 'live'
        bubble = p.activity
      } else {
        label = 'Idle'
      }
    } else if (receiving) {
      room = parentIsMain ? 'manager' : 'meeting'
      label = 'Taking task'
      tone = 'warn'
      bubble = `Task from ${pname}`
      docFrom = parent?.id
    } else if (p.status === 'running') {
      room = 'workspace'
      label = p.blocked ? 'Blocked' : 'Working'
      tone = p.blocked ? 'bad' : 'live'
      bubble = p.blocked ? p.blocked : p.skill ? `skill: ${p.skill}` : p.activity
    } else if (handing) {
      room = parentIsMain ? 'manager' : 'meeting'
      label = 'Handing over'
      tone = 'ok'
      bubble = `Result → ${pname}`
      docTo = parent?.id
    } else if (p.status === 'completed') {
      room = 'lounge'
      label = 'Done'
      tone = 'ok'
      bubble = 'Report delivered'
    } else if (p.status === 'failed' || p.status === 'stopped') {
      room = 'workspace'
      label = p.status === 'failed' ? 'Failed' : 'Stopped'
      tone = 'bad'
      bubble = p.activity
    } else if (p.blocked) {
      room = 'workspace'
      label = 'Blocked'
      tone = 'bad'
      bubble = p.blocked
    } else {
      room = 'kitchen'
      label = 'Waiting'
      tone = 'warn'
      bubble = 'Waiting for next step'
    }
    const k = room === 'workspace' ? desk.n++ : (slots[room] = (slots[room] ?? -1) + 1)
    return { ...p, color: PALETTE[i % PALETTE.length] ?? '#888', room, slot: k, label, tone, bubble: clip(bubble, 30), docFrom, docTo }
  })
  return out
}

export function slotPos(room: Room, k: number): Pos {
  switch (room) {
    case 'workspace':
      return k < 10 ? { x: 50 + k * 72, y: 192 } : { x: 50 + ((k - 10) % 10) * 72, y: 224 }
    case 'meeting':
      return ([{ x: 52, y: 306 }, { x: 113, y: 290 }, { x: 174, y: 306 }, { x: 52, y: 366 }, { x: 174, y: 366 }, { x: 113, y: 380 }] as Pos[])[k % 6] as Pos
    case 'manager':
      return k === 0 ? { x: 326, y: 312 } : { x: 276 + ((k - 1) % 2) * 116, y: (k - 1) % 2 === 0 ? 390 : 360 }
    case 'lounge':
      return { x: 452 + (k % 5) * 30, y: k < 5 ? 378 : 398 }
    case 'kitchen':
      return { x: 628 + (k % 4) * 30, y: k < 4 ? 378 : 398 }
  }
}

/** Remember where each agent was, so a change of room is a walk (new agents walk in from the entrance). */
export function advance(moves: MoveState, placed: Placed[], now: number): MoveState {
  const next: MoveState = {}
  for (const p of placed) {
    const to = slotPos(p.room, p.slot)
    const prev = moves[p.id]
    if (!prev) {
      const fresh = p.ageMs < 3500 && !p.isMain
      next[p.id] = { room: p.room, slot: p.slot, from: fresh ? ENTRANCE : to, to, startedAt: fresh ? now : now - MOVE_MS }
    } else if (prev.room === p.room && prev.slot === p.slot) {
      next[p.id] = prev
    } else {
      const t = Math.min(1, Math.max(0, (now - prev.startedAt) / MOVE_MS))
      const from = { x: prev.from.x + (prev.to.x - prev.from.x) * t, y: prev.from.y + (prev.to.y - prev.from.y) * t }
      next[p.id] = { room: p.room, slot: p.slot, from, to, startedAt: now }
    }
  }
  return next
}

export const C = { bg: '#0b0d14', card: '#12151f', line: '#232838', text: '#e6e9f2', dim: '#7c859c', accent: '#7c6cff', ok: '#0ca30c', warn: '#fab219', bad: '#d03b3b', live: '#6da7ec' }
const toneGlyph = (t: Placed['tone']) => (t === 'ok' ? '✓' : t === 'bad' ? '✕' : t === 'warn' ? '!' : t === 'live' ? '●' : '○')
const toneColor = (t: Placed['tone']) => (t === 'ok' ? C.ok : t === 'warn' ? C.warn : t === 'bad' ? C.bad : t === 'live' ? C.live : C.dim)
const text = (x: number, y: number, s: string, size = 9, fill = C.text, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`

function card(x: number, y: number, w: number, h: number, label: string, value: string, color: string) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${C.card}" stroke="${C.line}"/>${text(x + 10, y + 16, label, 7.5, C.dim, 'letter-spacing="0.8"')}${text(x + 10, y + 42, value, 24, color, 'font-weight="700"')}`
}

function rooms(): string {
  const room = (x: number, y: number, w: number, h: number, fill: string, label: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="#05060a" stroke-width="3"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="url(#glow)"/>${text(x + 10, y + 15, label.toUpperCase(), 8, 'rgba(255,255,255,.6)', 'letter-spacing="1.4"')}`
  let s = ''
  s += room(8, 108, 744, 128, '#4a2326', 'Workspace')
  for (let i = 0; i < 10; i++) {
    const x = 22 + i * 72
    s += `<rect x="${x}" y="126" width="56" height="30" rx="4" fill="#2b2f3c" stroke="#0a0c12"/><rect x="${x + 17}" y="130" width="22" height="13" rx="1.5" fill="#101420"/><rect x="${x + 19}" y="132" width="18" height="9" fill="#1e3a5f"><animate attributeName="opacity" values=".5;1;.5" dur="${2 + (i % 3) * 0.7}s" repeatCount="indefinite"/></rect>`
  }
  s += room(8, 244, 210, 164, '#6b4f2d', 'Meeting room')
  s += `<ellipse cx="113" cy="334" rx="62" ry="30" fill="#2c1d10" stroke="#0a0c12"/>`
  s += room(224, 244, 200, 164, '#43202a', 'Manager office')
  s += `<rect x="262" y="276" width="116" height="28" rx="4" fill="#2b2f3c" stroke="#0a0c12"/><rect x="304" y="280" width="26" height="14" rx="2" fill="#101420"/><rect x="390" y="268" width="26" height="34" rx="3" fill="#3a2a14"/><circle cx="403" cy="276" r="6" fill="#f5c542"/>`
  s += room(430, 244, 170, 164, '#1f4a4a', 'Lounge')
  s += `<rect x="442" y="262" width="80" height="24" rx="7" fill="#33425a" stroke="#0a0c12"/><rect x="528" y="300" width="64" height="40" rx="3" fill="#166534" stroke="#3b2a14" stroke-width="3"/>`
  s += room(606, 244, 146, 164, '#5b5046', 'Kitchen')
  s += `<rect x="616" y="262" width="126" height="18" rx="3" fill="#2f3038" stroke="#0a0c12"/><rect x="708" y="256" width="18" height="14" rx="2" fill="#ef4444"/><path d="M717 252c-3-5 3-6 0-11" stroke="#fff" stroke-opacity=".5" fill="none"><animate attributeName="stroke-opacity" values=".1;.7;.1" dur="2s" repeatCount="indefinite"/></path>`
  s += `<rect x="360" y="408" width="40" height="8" rx="2" fill="#7c6cff" fill-opacity=".5"/>${text(366, 428, 'ENTRANCE', 6.5, C.dim, 'letter-spacing="1"')}`
  return s
}

const DOC = `<rect x="-5" y="-7" width="10" height="13" rx="1.5" fill="#fff" stroke="#7c6cff"/><path d="M-3 -3h6M-3 0h6M-3 3h4" stroke="#7c6cff" stroke-width="1"/>`

function flyingDoc(from: Pos, to: Pos, id: string): string {
  return `<g id="doc-${esc(id)}" transform="translate(${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 52})"><animateTransform attributeName="transform" type="translate" values="${from.x} ${from.y - 34};${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 52};${to.x} ${to.y - 34}" keyTimes="0;.5;1" dur="1.6s" repeatCount="indefinite"/>${DOC}</g>`
}

function avatar(p: Placed, m: MoveState[string] | undefined, now: number): string {
  const to = slotPos(p.room, p.slot)
  const walking = !!m && now - m.startedAt < MOVE_MS && (m.from.x !== m.to.x || m.from.y !== m.to.y)
  const dur = walking && m ? Math.max(0.2, (MOVE_MS - (now - m.startedAt)) / 1000) : 0
  const anim = walking && m ? `<animateTransform attributeName="transform" type="translate" from="${m.from.x.toFixed(1)} ${m.from.y.toFixed(1)}" to="${to.x} ${to.y}" dur="${dur.toFixed(2)}s" fill="freeze"/>` : ''
  const col = toneColor(p.tone)
  const fast = p.tone === 'live' || walking
  const bob = fast ? 0.9 : 3.5
  const amp = fast ? 2.6 : 1.2
  const bubbleW = Math.min(190, 16 + p.bubble.length * 5)
  const tag = `${toneGlyph(p.tone)} ${clip(p.name, p.room === 'manager' ? 9 : 14)} · ${p.label}`
  const tagW = 20 + tag.length * 5
  const typing = p.tone === 'live' && p.room === 'workspace'
  const clampX = (w: number) => (to.x - w / 2 < 6 ? 6 - (to.x - w / 2) : to.x + w / 2 > W - 6 ? W - 6 - (to.x + w / 2) : 0)
  const sh = clampX(tagW)
  const shb = clampX(bubbleW)
  const tip = [`${p.name} (${roleOf(p)})`, `Status: ${p.label}${p.blocked ? ' — ' + p.blocked : ''}`, `Now: ${p.activity}`, p.skill ? `Skill: ${p.skill}` : '', p.pct !== undefined ? `Progress: ${p.pct}%` : '', `Tokens: ${p.tokens}`].filter(Boolean).map(esc).join('&#10;')
  return `<g transform="translate(${to.x} ${to.y})"><title>${tip}</title>${anim}<g transform="scale(1.35)">
<ellipse cx="0" cy="13" rx="9" ry="3" fill="#000" opacity=".4"/>
<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -${amp};0 0" dur="${bob}s" repeatCount="indefinite" additive="sum"/>
<circle cx="0" cy="0" r="13" fill="none" stroke="${col}" stroke-width="1.5" opacity=".9">${p.tone === 'live' || p.tone === 'bad' || walking ? '<animate attributeName="r" values="11;16;11" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values=".9;.1;.9" dur="1.6s" repeatCount="indefinite"/>' : ''}</circle>
<rect x="-7" y="-1" width="14" height="14" rx="6" fill="${p.color}"/>
<circle cx="0" cy="-6" r="6" fill="#f2c9a5"/><path d="M-6 -7a6 6 0 0 1 12 0z" fill="#3b2a1f"/>
${walking ? `<g stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M-3 13v5"><animate attributeName="d" values="M-3 13v5;M-3 13v2;M-3 13v5" dur=".4s" repeatCount="indefinite"/></path><path d="M3 13v2"><animate attributeName="d" values="M3 13v2;M3 13v5;M3 13v2" dur=".4s" repeatCount="indefinite"/></path></g>` : ''}
${typing ? `<g fill="#fff"><circle cx="-4" cy="17" r="1.3"><animate attributeName="opacity" values=".2;1;.2" dur=".9s" repeatCount="indefinite"/></circle><circle cx="0" cy="17" r="1.3"><animate attributeName="opacity" values=".2;1;.2" dur=".9s" begin=".3s" repeatCount="indefinite"/></circle><circle cx="4" cy="17" r="1.3"><animate attributeName="opacity" values=".2;1;.2" dur=".9s" begin=".6s" repeatCount="indefinite"/></circle></g>` : ''}
</g></g>
<g transform="translate(${sh} -34)"><rect x="${-tagW / 2}" y="-13" width="${tagW}" height="13" rx="6.5" fill="#0b0d14" stroke="${col}" stroke-opacity=".8"/><circle cx="${-tagW / 2 + 8}" cy="-6.5" r="2.6" fill="${col}"/>${text(-tagW / 2 + 15, -3.5, tag, 8, C.text, 'font-weight="600"')}</g>
${p.bubble ? `<g transform="translate(${shb} -51)"><rect x="${-bubbleW / 2}" y="-15" width="${bubbleW}" height="14" rx="7" fill="#f4f5f9"/><path d="M-3 -1l3 4 3-4z" fill="#f4f5f9"/>${text(-bubbleW / 2 + 8, -5, p.bubble, 8, '#12151f')}</g>` : ''}
</g>`
}

export type Part = { id: string; w: number; h: number; svg: string }

/** The scene as independent SVGs (header, floor, three panels): each one reloads only when its own content changes. */
export function officeParts(input: OfficeInput, moves: MoveState, now: number, animate = true): Part[] {
  const parts = drawParts(input, moves, now)
  return animate ? parts : parts.map(p => ({ ...p, svg: p.svg.replace(/<animate(?:Transform)?[^>]*\/>/g, '') }))
}

/** One string with every part, for tests and previews. */
export function officeSvg(input: OfficeInput, moves: MoveState, now: number, animate = true): string {
  return officeParts(input, moves, now, animate).map(p => p.svg).join(' ')
}

const GLOW = `<defs><radialGradient id="glow" cx="50%" cy="35%" r="70%"><stop offset="0" stop-color="#ffd9a0" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient></defs>`
const mk = (id: string, x: number, y: number, w: number, h: number, inner: string): Part => ({
  id,
  w,
  h,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" font-family="Segoe UI, system-ui, sans-serif">${GLOW}<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.bg}"/>${inner}</svg>`,
})

function drawParts(input: OfficeInput, moves: MoveState, now: number): Part[] {
  const placed = place(input.people, now)
  const rows = Math.max(3, Math.min(6, Math.max(placed.length, input.feed.length)))
  const H = 436 + 30 + Math.max(rows * 40 + (placed.length > 6 ? 14 : 0), Math.min(10, placed.length) * 23) + 12
  const s = input.stats
  const byId: Record<string, Placed> = {}
  for (const p of placed) byId[p.id] = p
  const posOf = (p: Placed): Pos => slotPos(p.room, p.slot)
  let o = ''
  const parts: Part[] = []
  const HB = H - 436
  // header: product + the chat's own title
  const title = clip(input.title || 'This chat', 34)
  o += `<rect x="8" y="8" width="${Math.max(190, 70 + title.length * 6)}" height="34" rx="9" fill="${C.card}" stroke="${C.line}"/><rect x="14" y="14" width="22" height="22" rx="6" fill="${C.accent}"/>${text(20, 29, 'AI', 10, '#fff', 'font-weight="700"')}${text(42, 22, title, 9.5, C.text, 'font-weight="700"')}`
  o += `<circle cx="47" cy="33" r="2.6" fill="${s.live ? C.ok : C.dim}">${s.live ? '<animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>${text(54, 36, s.live ? `${s.active} agent${s.active === 1 ? '' : 's'} working · live` : 'idle', 7.5, C.dim)}`
  const tabs = ['Workspace', 'Meeting room', 'Manager office', 'Lounge', 'Kitchen']
  let tx = Math.max(190, 70 + title.length * 6) + 22
  tabs.forEach(t => {
    const w = 16 + t.length * 5.2
    o += `<rect x="${tx}" y="14" width="${w}" height="20" rx="6" fill="none" stroke="${C.line}"/>${text(tx + 8, 27.5, t, 8, C.dim)}`
    tx += w + 6
  })
  // stats row
  o += card(8, 50, 108, 52, 'ACTIVE AGENTS', `${s.active}/${s.total}`, C.ok)
  o += card(122, 50, 108, 52, 'RUNNING TASKS', String(s.running), C.warn)
  o += card(236, 50, 108, 52, 'COMPLETED', String(s.completed), '#60a5fa')
  o += card(350, 50, 108, 52, 'PROGRESS', s.pct === undefined ? 'n/a' : `${s.pct}%`, '#a78bfa')
  o += `<rect x="464" y="50" width="288" height="52" rx="9" fill="${C.card}" stroke="${C.line}"/>${text(474, 68, clip(s.request, 46), 9, C.text, 'font-weight="600"')}${text(474, 82, `Tokens ${s.tokens}`, 8, C.dim)}<rect x="474" y="90" width="268" height="5" rx="2.5" fill="#232838"/><rect x="474" y="90" width="${s.pct === undefined ? 0 : Math.round(2.68 * s.pct)}" height="5" rx="2.5" fill="${C.accent}"/>${s.pct === undefined && s.live ? `<rect x="474" y="90" width="44" height="5" rx="2.5" fill="${C.accent}"><animate attributeName="x" values="474;698;474" dur="2.4s" repeatCount="indefinite"/></rect>` : ''}`
  parts.push(mk('header', 0, 0, W, 108, o))
  o = ''
  // office
  o += rooms()
  // documents in flight (task handed in / result handed over)
  for (const p of placed) {
    if (p.docFrom && byId[p.docFrom]) o += flyingDoc(posOf(byId[p.docFrom] as Placed), posOf(p), 'in-' + p.id)
    if (p.docTo && byId[p.docTo]) o += flyingDoc(posOf(p), posOf(byId[p.docTo] as Placed), 'out-' + p.id)
  }
  for (const p of placed) o += avatar(p, moves[p.id], now)
  parts.push(mk('floor', 0, 108, W, 328, o))
  o = ''
  // bottom panels
  const PY = 436
  o += text(12, PY + 12, 'AGENT ACTIVITY', 8, C.dim, 'letter-spacing="1"')
  placed.slice(0, 6).forEach((p, i) => {
    const y = PY + 18 + i * 40
    const col = toneColor(p.tone)
    o += `<rect x="8" y="${y}" width="244" height="36" rx="8" fill="${C.card}" stroke="${C.line}"/><circle cx="26" cy="${y + 18}" r="10" fill="${p.color}"/>${text(22, y + 22, (p.name[0] ?? '?').toUpperCase(), 10, '#0b0d14', 'font-weight="800"')}${text(42, y + 14, clip(p.name, 14), 9.5, C.text, 'font-weight="700"')}${text(42 + Math.min(p.name.length, 14) * 5.6 + 5, y + 14, '· ' + roleOf(p), 8, C.dim)}<rect x="192" y="${y + 6}" width="54" height="13" rx="6.5" fill="${col}" fill-opacity=".16"/>${text(197, y + 15.5, clip(p.label, 11), 7, col, 'font-weight="700"')}${text(42, y + 28, clip(`${p.pct !== undefined ? p.pct + '% · ' : ''}${p.skill ? 'skill ' + p.skill + ' · ' : ''}${p.activity}`, 44), 7.5, C.dim)}`
  })
  if (placed.length > 6) o += text(12, PY + 18 + 6 * 40 + 8, `+${placed.length - 6} more agents`, 8, C.dim)
  parts.push(mk('activity', 0, 436, 256, HB, o))
  o = ''
  o += text(262, PY + 12, 'AGENT COMMUNICATION', 8, C.dim, 'letter-spacing="1"') + `<circle cx="490" cy="${PY + 9}" r="2.6" fill="${C.ok}"><animate attributeName="opacity" values="1;.2;1" dur="1.4s" repeatCount="indefinite"/></circle>`
  const feed = input.feed.slice(-6).reverse()
  if (!feed.length) o += text(264, PY + 34, 'No agent activity yet', 9, C.dim)
  feed.forEach((f, i) => {
    const y = PY + 18 + i * 40
    const pc = placed.find(p => p.name === f.who)
    const lines = wrap2(f.text, 42)
    o += `<rect x="258" y="${y}" width="244" height="36" rx="8" fill="${C.card}" stroke="${f.tone === 'bad' ? C.bad : C.line}"/>${text(266, y + 12, clip(f.who, 16), 8.5, pc?.color ?? C.accent, 'font-weight="700"')}${text(458, y + 12, f.time, 7.5, C.dim)}${text(266, y + 23, lines[0], 8, C.text)}${text(266, y + 32, lines[1], 8, C.dim)}`
  })
  parts.push(mk('comms', 256, 436, 254, HB, o))
  o = ''
  o += text(512, PY + 12, 'TASK TIMELINE', 8, C.dim, 'letter-spacing="1"')
  placed.slice(0, 10).forEach((p, i) => {
    const y = PY + 20 + i * 23
    const full = p.status === 'completed'
    const w = full ? 124 : p.pct === undefined ? 0 : Math.round(1.24 * p.pct)
    o += `${text(512, y + 9, clip(p.name, 12), 8, C.text)}<rect x="590" y="${y + 1}" width="124" height="8" rx="4" fill="#232838"/><rect x="590" y="${y + 1}" width="${w}" height="8" rx="4" fill="${p.color}"/>${p.tone === 'live' && !full && p.pct === undefined ? `<rect x="590" y="${y + 1}" width="26" height="8" rx="4" fill="${p.color}"><animate attributeName="x" values="590;688;590" dur="${2 + (i % 3) * 0.5}s" repeatCount="indefinite"/></rect>` : ''}${text(720, y + 9, full ? '✓ done' : p.pct === undefined ? '…' : p.pct + '%', 7.5, C.dim)}`
  })
  parts.push(mk('timeline', 510, 436, 250, HB, o))
  return parts
}

/**
 * What identifies a scene: its structure (who is where, labels, numbers) without any animation element and without
 * the walking legs. A walk that ends, a countdown of its duration or a pulse starting must not look like a new scene:
 * swapping the markup reloads the frame and is the flicker.
 */
export const sceneKey = (svg: string) =>
  svg
    .replace(/<animate(?:Transform)?\b[^>]*\/>/g, '')
    .replace(/<g stroke="#fff" stroke-width="1.4" stroke-linecap="round">.*?<\/g>/gs, '')
