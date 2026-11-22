// "Virtual office": a large isometric animated SVG (SMIL) driven by real agent state.
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
export const ENTRANCE: Pos = { x: 505, y: 470 }
const FLOOR_TOP = 108
const FLOOR_H = 392
const PY = FLOOR_TOP + FLOOR_H // where the bottom panels start
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

// ---- isometric floor plan -------------------------------------------------------------------------------------------
// Every room is a diamond slab (hw = half width, half height = hw / 2) with two back walls. A point inside a room is
// addressed by (u, v) in 0..1: u runs down-right along the back-right wall, v runs down-left along the back-left wall.
// Walking is a straight line on the screen, so the plain translate animation still works.
type Slab = { cx: number; top: number; hw: number }
const SLAB: Record<Room, Slab> = {
  workspace: { cx: 205, top: 146, hw: 190 },
  meeting: { cx: 565, top: 144, hw: 115 },
  manager: { cx: 625, top: 284, hw: 105 },
  lounge: { cx: 135, top: 360, hw: 110 },
  kitchen: { cx: 365, top: 374, hw: 100 },
}
export const ROOMS: Room[] = ['workspace', 'meeting', 'manager', 'lounge', 'kitchen']
export const ROOM_LABEL: Record<Room, string> = { workspace: 'Workspace', meeting: 'Meeting room', manager: 'Manager office', lounge: 'Lounge', kitchen: 'Kitchen' }
const WALL = 24
const r1 = (n: number) => Math.round(n * 10) / 10

/** The screen point of (u, v) inside a room. */
export function iso(room: Room, u: number, v: number): Pos {
  const s = SLAB[room]
  return { x: r1(s.cx + (u - v) * s.hw), y: r1(s.top + ((u + v) * s.hw) / 2) }
}

const DESK_COLS = 5
const DESK_ROWS = 4
const DESKS: Pos[] = []
for (let j = 0; j < DESK_ROWS; j++) for (let i = 0; i < DESK_COLS; i++) DESKS.push(iso('workspace', 0.13 + i * 0.185, 0.22 + j * 0.2))
const DESK_N = DESKS.length
// Agents fill the desks spread out along the room (every 7th desk, starting in the middle; 7 and 20 share no factor), so a few
// agents do not stand shoulder to shoulder and their name tags stay readable.
const DESK_ORDER = DESKS.map((_, d) => d).sort((a, b) => (DESKS[a] as Pos).x - (DESKS[b] as Pos).x || (DESKS[a] as Pos).y - (DESKS[b] as Pos).y)
const deskIndex = (k: number) => DESK_ORDER[((k % DESK_N) * 7 + 10) % DESK_N] as number
const CHAIR: Pos = { x: -20, y: 11 } // where the worker stands, relative to the desk

export function slotPos(room: Room, k: number): Pos {
  switch (room) {
    case 'workspace': {
      const d = DESKS[deskIndex(k)] as Pos
      return { x: r1(d.x + CHAIR.x), y: r1(d.y + CHAIR.y) }
    }
    case 'meeting': {
      const c = iso('meeting', 0.5, 0.5)
      const a = ((k % 6) * Math.PI) / 3 - Math.PI / 2
      return { x: r1(c.x + 52 * Math.cos(a)), y: r1(c.y + 26 * Math.sin(a) + 6) }
    }
    case 'manager':
      return k === 0 ? iso('manager', 0.28, 0.45) : iso('manager', 0.5 + ((k - 1) % 3) * 0.14, 0.74 - ((k - 1) % 2) * 0.1)
    case 'lounge':
      return iso('lounge', 0.25 + (k % 4) * 0.17, 0.55 + (Math.floor(k / 4) % 2) * 0.17)
    case 'kitchen':
      return iso('kitchen', 0.3 + (k % 4) * 0.16, 0.55 + (Math.floor(k / 4) % 2) * 0.17)
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

/** Blend two #rrggbb colours: t = 0 gives a, t = 1 gives b. */
function tint(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) || 0)
  const x = p(a)
  const y = p(b)
  return '#' + x.map((v, i) => Math.round(v + ((y[i] as number) - v) * t).toString(16).padStart(2, '0')).join('')
}
const pts = (...n: number[]) => n.map(r1).join(' ')
const poly = (fill: string, stroke: string, ...n: number[]) => `<polygon points="${pts(...n)}" fill="${fill}" stroke="${stroke}" stroke-width=".7" stroke-linejoin="round"/>`

/** An isometric box standing on (cx, cy): `h` tall, `tx` x `ty` half-extents on the ground. */
function ibox(cx: number, cy: number, tx: number, ty: number, h: number, top: string, left: string, right: string, stroke = '#05060a') {
  return poly(left, stroke, cx - tx, cy - h, cx, cy - h + ty, cx, cy + ty, cx - tx, cy) + poly(right, stroke, cx + tx, cy - h, cx, cy - h + ty, cx, cy + ty, cx + tx, cy) + poly(top, stroke, cx, cy - h - ty, cx + tx, cy - h, cx, cy - h + ty, cx - tx, cy - h)
}

/** A point on a back wall: side L (back-left) or R (back-right), f along it (0 = the back corner), lift above the floor. */
function wallPt(room: Room, side: 'L' | 'R', f: number, lift: number): Pos {
  const s = SLAB[room]
  const ex = side === 'L' ? s.cx - s.hw : s.cx + s.hw
  return { x: s.cx + (ex - s.cx) * f, y: s.top + (s.hw / 2) * f - lift }
}
function panel(room: Room, side: 'L' | 'R', fa: number, fb: number, la: number, lb: number, fill: string, stroke = 'none', extra = '') {
  const a = wallPt(room, side, fa, la)
  const b = wallPt(room, side, fb, la)
  const c = wallPt(room, side, fb, lb)
  const d = wallPt(room, side, fa, lb)
  return `<polygon points="${pts(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)}" fill="${fill}" stroke="${stroke}" stroke-width=".6" ${extra}/>`
}

/** Floor slab, two back walls and a faint tile grid. */
function shell(room: Room, fill: string, wallL: string, wallR: string): string {
  const s = SLAB[room]
  const hh = s.hw / 2
  const T = { x: s.cx, y: s.top }
  const L = { x: s.cx - s.hw, y: s.top + hh }
  const R = { x: s.cx + s.hw, y: s.top + hh }
  const B = { x: s.cx, y: s.top + 2 * hh }
  const TH = 7
  let o = ''
  o += poly(tint(fill, '#000000', 0.5), 'none', L.x, L.y, B.x, B.y, B.x, B.y + TH, L.x, L.y + TH)
  o += poly(tint(fill, '#000000', 0.68), 'none', R.x, R.y, B.x, B.y, B.x, B.y + TH, R.x, R.y + TH)
  o += poly(wallL, '#05060a', T.x, T.y, L.x, L.y, L.x, L.y - WALL, T.x, T.y - WALL)
  o += poly(wallR, '#05060a', T.x, T.y, R.x, R.y, R.x, R.y - WALL, T.x, T.y - WALL)
  o += poly(fill, '#05060a', T.x, T.y, R.x, R.y, B.x, B.y, L.x, L.y)
  o += `<polygon points="${pts(T.x, T.y, R.x, R.y, B.x, B.y, L.x, L.y)}" fill="url(#glow)"/>`
  for (const t of [0.25, 0.5, 0.75]) {
    const a = iso(room, t, 0)
    const b = iso(room, t, 1)
    const c = iso(room, 0, t)
    const d = iso(room, 1, t)
    o += `<path d="M${pts(a.x, a.y)}L${pts(b.x, b.y)}M${pts(c.x, c.y)}L${pts(d.x, d.y)}" stroke="#fff" stroke-opacity=".06" fill="none"/>`
  }
  o += `<polyline points="${pts(L.x, L.y - WALL, T.x, T.y - WALL, R.x, R.y - WALL)}" fill="none" stroke="${tint(wallR, '#ffffff', 0.35)}" stroke-width="1.4"/>`
  return o
}

/** Each room's sign, hung in front of its slab (drawn after every room, so no wall covers one). */
function sign(room: Room, n: number): string {
  const s = SLAB[room]
  const at = room === 'meeting' ? { x: s.cx + s.hw - 30, y: s.top + s.hw / 2 - 4 } : { x: s.cx, y: s.top + s.hw }
  const label = ROOM_LABEL[room].toUpperCase() + (n ? ` · ${n}` : '')
  const w = 18 + label.length * 5.6
  return `<rect x="${r1(at.x - w / 2)}" y="${r1(at.y + 9)}" width="${r1(w)}" height="14" rx="7" fill="#0b0d14" fill-opacity=".9" stroke="${n ? C.accent : C.line}"/>${text(r1(at.x - w / 2 + 9), r1(at.y + 19), label, 7.5, n ? C.text : C.dim, 'font-weight="700" letter-spacing=".8"')}`
}

function monitor(x: number, y: number, who: Placed | undefined, d: number): string {
  const H = 12
  const lit = !who ? '#161a26' : who.tone === 'bad' ? C.bad : who.tone === 'ok' ? C.ok : who.tone === 'warn' ? C.warn : C.live
  const pulse = who && who.tone === 'live' ? `<animate attributeName="opacity" values=".55;1;.55" dur="${1.4 + (d % 3) * 0.5}s" repeatCount="indefinite"/>` : ''
  return (
    `<polygon points="${pts(x - 8, y - 4, x + 8, y + 4, x + 8, y + 4 - H, x - 8, y - 4 - H)}" fill="#0e1119" stroke="#05060a" stroke-width=".6"/>` +
    `<polygon points="${pts(x - 6.5, y - 4.7, x + 6.5, y + 1.7, x + 6.5, y + 3.2 - H + 1.5, x - 6.5, y - 3.2 - H + 1.5)}" fill="${lit}"${who ? ' opacity=".9"' : ''}>${pulse}</polygon>`
  )
}

/** One desk: a box with a keyboard and a monitor. The monitor is lit in the colour of its worker's state. */
function deskSvg(pos: Pos, who: Placed | undefined, d: number): string {
  const { x, y } = pos
  const top = y - 7
  return `<g>${ibox(x, y, 22, 11, 7, '#4b526b', '#353b52', '#2a3043')}<polygon points="${pts(x - 14, top + 1, x - 5, top + 5.5, x - 9, top + 7.5, x - 18, top + 3)}" fill="#202433"/>${monitor(x + 5, top - 1, who, d)}</g>`
}

function decor(room: Room): string {
  let o = ''
  switch (room) {
    case 'workspace':
      for (let k = 0; k < 3; k++) o += panel(room, 'R', 0.1 + k * 0.3, 0.3 + k * 0.3, 5, 18, '#7fb2ff', 'none', 'fill-opacity=".28"')
      o += panel(room, 'L', 0.25, 0.7, 5, 18, '#1b2030', '#05060a')
      o += panel(room, 'L', 0.3, 0.42, 6, 14, C.live, 'none', 'fill-opacity=".6"') + panel(room, 'L', 0.46, 0.58, 6, 11, C.ok, 'none', 'fill-opacity=".6"') + panel(room, 'L', 0.62, 0.68, 6, 16, C.warn, 'none', 'fill-opacity=".6"')
      break
    case 'meeting': {
      o += panel(room, 'L', 0.22, 0.78, 5, 19, '#e8ecf4', '#05060a')
      o += panel(room, 'L', 0.3, 0.55, 12, 12.6, '#7c6cff') + panel(room, 'L', 0.3, 0.68, 9, 9.6, '#7c6cff', 'none', 'fill-opacity=".6"')
      const c = iso('meeting', 0.5, 0.5)
      o += `<ellipse cx="${c.x}" cy="${c.y + 7}" rx="44" ry="22" fill="#1a1109"/><ellipse cx="${c.x}" cy="${c.y}" rx="44" ry="22" fill="#9a7647" stroke="#0a0c12"/><ellipse cx="${c.x}" cy="${c.y}" rx="30" ry="14" fill="none" stroke="#fff" stroke-opacity=".1"/>`
      o += `<polygon points="${pts(c.x - 10, c.y - 2, c.x - 2, c.y + 2, c.x - 8, c.y + 5, c.x - 16, c.y + 1)}" fill="#f4f5f9"/>`
      break
    }
    case 'manager': {
      o += panel(room, 'R', 0.15, 0.5, 5, 18, '#7fb2ff', 'none', 'fill-opacity=".28"')
      const sh = iso('manager', 0.22, 0.08)
      o += ibox(sh.x, sh.y, 17, 8.5, 28, '#6b4a2b', '#4d341d', '#3b2815')
      o += `<circle cx="${r1(sh.x + 2)}" cy="${r1(sh.y - 33)}" r="4" fill="#f5c542"/>`
      const d = iso('manager', 0.55, 0.3)
      o += ibox(d.x, d.y, 30, 15, 9, '#8a6238', '#5d3f22', '#472f19')
      o += monitor(d.x - 6, d.y - 9, undefined, 0).replace('fill="#161a26"', 'fill="#1e3a5f"') + monitor(d.x + 12, d.y - 8, undefined, 1).replace('fill="#161a26"', 'fill="#1e3a5f"')
      const pl = iso('manager', 0.9, 0.12)
      o += ibox(pl.x, pl.y, 6, 3, 7, '#9a5a35', '#7a4a2b', '#5f3920') + `<circle cx="${pl.x}" cy="${r1(pl.y - 15)}" r="8" fill="#2f8a4f"/><circle cx="${r1(pl.x + 5)}" cy="${r1(pl.y - 20)}" r="5" fill="#3aa35e"/>`
      break
    }
    case 'lounge': {
      const rug = iso('lounge', 0.5, 0.55)
      o += `<polygon points="${pts(rug.x, rug.y - 24, rug.x + 48, rug.y, rug.x, rug.y + 24, rug.x - 48, rug.y)}" fill="#7c6cff" fill-opacity=".22"/>`
      const so = iso('lounge', 0.3, 0.16)
      o += ibox(r1(so.x + 11), r1(so.y - 6), 14, 7, 18, '#6a8bc4', '#48649a', '#3a5280') + ibox(r1(so.x - 2), r1(so.y + 2), 22, 11, 8, '#7d9bd0', '#52709f', '#42608e')
      const tb = iso('lounge', 0.62, 0.42)
      o += ibox(tb.x, tb.y, 12, 6, 5, '#b98f56', '#8a6a3c', '#6b5230')
      o += panel(room, 'L', 0.25, 0.4, 6, 16, '#ffd9a0', '#05060a', 'fill-opacity=".5"') + panel(room, 'L', 0.5, 0.65, 6, 16, '#a7e3b5', '#05060a', 'fill-opacity=".5"')
      break
    }
    case 'kitchen': {
      o += panel(room, 'R', 0.15, 0.6, 12, 22, '#a0988a', '#05060a')
      const co = iso('kitchen', 0.55, 0.13)
      o += ibox(co.x, co.y, 34, 17, 14, '#c9c3b6', '#9c9689', '#7b766b')
      const cm = iso('kitchen', 0.62, 0.15)
      o += ibox(cm.x, r1(cm.y - 14), 6, 3, 9, '#ef4444', '#b91c1c', '#991b1b') + `<path d="M${r1(cm.x)} ${r1(cm.y - 30)}c-3-5 3-6 0-11" stroke="#fff" stroke-opacity=".5" fill="none"><animate attributeName="stroke-opacity" values=".1;.7;.1" dur="2s" repeatCount="indefinite"/></path>`
      const fr = iso('kitchen', 0.92, 0.2)
      o += ibox(fr.x, fr.y, 10, 5, 34, '#e3e8f0', '#b4bccb', '#98a1b2')
      break
    }
  }
  return o
}

function roomsBase(count: Record<Room, number>): string {
  let o = ''
  o += shell('workspace', '#58393f', '#35232b', '#432e37') + decor('workspace')
  o += shell('meeting', '#80603a', '#4d3a24', '#5c452c') + decor('meeting')
  o += shell('manager', '#5e2e3d', '#381b2c', '#452136') + decor('manager')
  o += shell('lounge', '#2c6e6b', '#18433f', '#205350') + decor('lounge')
  o += shell('kitchen', '#716456', '#483f35', '#564c40') + decor('kitchen')
  for (const r of ROOMS) o += sign(r, count[r])
  o += `<polygon points="${pts(ENTRANCE.x, ENTRANCE.y - 19, ENTRANCE.x + 40, ENTRANCE.y, ENTRANCE.x, ENTRANCE.y + 19, ENTRANCE.x - 40, ENTRANCE.y)}" fill="${C.accent}" fill-opacity=".3" stroke="${C.accent}" stroke-opacity=".6"/>${text(ENTRANCE.x, ENTRANCE.y + 3, 'ENTRANCE', 7, C.text, 'text-anchor="middle" letter-spacing="1"')}`
  return o
}

const DOC = `<rect x="-5" y="-7" width="10" height="13" rx="1.5" fill="#fff" stroke="#7c6cff"/><path d="M-3 -3h6M-3 0h6M-3 3h4" stroke="#7c6cff" stroke-width="1"/>`

function flyingDoc(from: Pos, to: Pos, id: string): string {
  return `<g id="doc-${esc(id)}" transform="translate(${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 52})"><animateTransform attributeName="transform" type="translate" values="${from.x} ${from.y - 34};${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 52};${to.x} ${to.y - 34}" keyTimes="0;.5;1" dur="1.6s" repeatCount="indefinite"/>${DOC}</g>`
}

function motion(p: Placed, m: MoveState[string] | undefined, now: number) {
  const to = slotPos(p.room, p.slot)
  const walking = !!m && now - m.startedAt < MOVE_MS && (m.from.x !== m.to.x || m.from.y !== m.to.y)
  const dur = walking && m ? Math.max(0.2, (MOVE_MS - (now - m.startedAt)) / 1000) : 0
  const anim = walking && m ? `<animateTransform attributeName="transform" type="translate" from="${m.from.x.toFixed(1)} ${m.from.y.toFixed(1)}" to="${to.x} ${to.y}" dur="${dur.toFixed(2)}s" fill="freeze"/>` : ''
  return { to, walking, anim }
}
const tooltip = (p: Placed) =>
  [`${p.name} (${roleOf(p)})`, `Status: ${p.label}${p.blocked ? ' — ' + p.blocked : ''}`, `Now: ${p.activity}`, p.skill ? `Skill: ${p.skill}` : '', p.pct !== undefined ? `Progress: ${p.pct}%` : '', `Tokens: ${p.tokens}`].filter(Boolean).map(esc).join('&#10;')

/** The character itself (drawn in depth order with the furniture). */
function avatarBody(p: Placed, m: MoveState[string] | undefined, now: number): string {
  const { to, walking, anim } = motion(p, m, now)
  const col = toneColor(p.tone)
  const fast = p.tone === 'live' || walking
  const bob = fast ? 0.9 : 3.5
  const amp = fast ? 2.6 : 1.2
  const typing = p.tone === 'live' && p.room === 'workspace'
  return `<g transform="translate(${to.x} ${to.y})"><title>${tooltip(p)}</title>${anim}<g transform="scale(1.35)">
<ellipse cx="0" cy="13" rx="9" ry="3" fill="#000" opacity=".4"/>
<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -${amp};0 0" dur="${bob}s" repeatCount="indefinite" additive="sum"/>
<circle cx="0" cy="0" r="13" fill="none" stroke="${col}" stroke-width="1.5" opacity=".9">${p.tone === 'live' || p.tone === 'bad' || walking ? '<animate attributeName="r" values="11;16;11" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values=".9;.1;.9" dur="1.6s" repeatCount="indefinite"/>' : ''}</circle>
<rect x="-7" y="-1" width="14" height="14" rx="6" fill="${p.color}"/>
<circle cx="0" cy="-6" r="6" fill="#f2c9a5"/><path d="M-6 -7a6 6 0 0 1 12 0z" fill="#3b2a1f"/>
${walking ? `<g stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M-3 13v5"><animate attributeName="d" values="M-3 13v5;M-3 13v2;M-3 13v5" dur=".4s" repeatCount="indefinite"/></path><path d="M3 13v2"><animate attributeName="d" values="M3 13v2;M3 13v5;M3 13v2" dur=".4s" repeatCount="indefinite"/></path></g>` : ''}
${typing ? `<g fill="#fff"><circle cx="-4" cy="17" r="1.3"><animate attributeName="opacity" values=".2;1;.2" dur=".9s" repeatCount="indefinite"/></circle><circle cx="0" cy="17" r="1.3"><animate attributeName="opacity" values=".2;1;.2" dur=".9s" begin=".3s" repeatCount="indefinite"/></circle><circle cx="4" cy="17" r="1.3"><animate attributeName="opacity" values=".2;1;.2" dur=".9s" begin=".6s" repeatCount="indefinite"/></circle></g>` : ''}
</g></g></g>`
}

/** Name tag (and speech bubble) above the character. Always on top, so no desk or wall can hide who is who. */
function avatarTag(p: Placed, m: MoveState[string] | undefined, now: number, compact: boolean, bubbleOn: boolean): string {
  const { to, anim } = motion(p, m, now)
  const col = toneColor(p.tone)
  const bubbleW = Math.min(190, 16 + p.bubble.length * 5)
  const tag = compact ? `${toneGlyph(p.tone)} ${clip(p.name, 12)}` : `${toneGlyph(p.tone)} ${clip(p.name, p.room === 'manager' ? 9 : 14)} · ${p.label}`
  const tagW = 20 + tag.length * 5
  const clampX = (w: number) => (to.x - w / 2 < 6 ? 6 - (to.x - w / 2) : to.x + w / 2 > W - 6 ? W - 6 - (to.x + w / 2) : 0)
  const sh = clampX(tagW)
  const shb = clampX(bubbleW)
  return `<g transform="translate(${to.x} ${to.y})"><title>${tooltip(p)}</title>${anim}
<g transform="translate(${sh} -34)"><rect x="${-tagW / 2}" y="-13" width="${tagW}" height="13" rx="6.5" fill="#0b0d14" stroke="${col}" stroke-opacity=".8"/><circle cx="${-tagW / 2 + 8}" cy="-6.5" r="2.6" fill="${col}"/>${text(-tagW / 2 + 15, -3.5, tag, 8, C.text, 'font-weight="600"')}</g>
${p.bubble && bubbleOn ? `<g transform="translate(${shb} -51)"><rect x="${-bubbleW / 2}" y="-15" width="${bubbleW}" height="14" rx="7" fill="#f4f5f9"/><path d="M-3 -1l3 4 3-4z" fill="#f4f5f9"/>${text(-bubbleW / 2 + 8, -5, p.bubble, 8, '#12151f')}</g>` : ''}
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
  const H = PY + 30 + Math.max(rows * 40 + (placed.length > 6 ? 14 : 0), Math.min(10, placed.length) * 23) + 12
  const s = input.stats
  const byId: Record<string, Placed> = {}
  for (const p of placed) byId[p.id] = p
  const posOf = (p: Placed): Pos => slotPos(p.room, p.slot)
  const count: Record<Room, number> = { workspace: 0, meeting: 0, manager: 0, lounge: 0, kitchen: 0 }
  for (const p of placed) count[p.room]++
  let o = ''
  const parts: Part[] = []
  const HB = H - PY
  // header: the chat's own title, the room tabs (a lit tab has people in it) and how many agents are active
  const title = clip(input.title || 'This chat', 26)
  const titleW = Math.max(190, 70 + title.length * 6)
  o += `<rect x="8" y="8" width="${titleW}" height="34" rx="9" fill="${C.card}" stroke="${C.line}"/><rect x="14" y="14" width="22" height="22" rx="6" fill="${C.accent}"/>${text(20, 29, 'AI', 10, '#fff', 'font-weight="700"')}${text(42, 22, title, 9.5, C.text, 'font-weight="700"')}`
  o += `<circle cx="47" cy="33" r="2.6" fill="${s.live ? C.ok : C.dim}">${s.live ? '<animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>${text(54, 36, s.live ? `${s.active} agent${s.active === 1 ? '' : 's'} working · live` : 'idle', 7.5, C.dim)}`
  let tx = titleW + 22
  for (const r of ROOMS) {
    const n = count[r]
    const label = ROOM_LABEL[r]
    const w = 16 + label.length * 5.2 + (n ? 14 : 0)
    o += `<rect x="${r1(tx)}" y="14" width="${r1(w)}" height="20" rx="6" fill="${n ? C.accent : 'none'}" fill-opacity=".18" stroke="${n ? C.accent : C.line}"/>${text(r1(tx + 8), 27.5, label, 8, n ? C.text : C.dim)}`
    if (n) o += `<circle cx="${r1(tx + w - 9)}" cy="24" r="6" fill="${C.accent}"/>${text(r1(tx + w - 9 - (n > 9 ? 4 : 2.2)), 27, String(Math.min(n, 99)), 8, '#fff', 'font-weight="700"')}`
    tx += w + 6
  }
  const pill = s.live ? `${s.active} active` : 'idle'
  const pw = 34 + pill.length * 5
  o += `<rect x="${W - 8 - pw}" y="14" width="${pw}" height="20" rx="10" fill="${s.live ? C.ok : C.dim}" fill-opacity=".16" stroke="${s.live ? C.ok : C.dim}"/><circle cx="${W - 8 - pw + 11}" cy="24" r="3" fill="${s.live ? C.ok : C.dim}">${s.live ? '<animate attributeName="opacity" values="1;.25;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>${text(W - 8 - pw + 19, 27.5, pill, 8.5, C.text, 'font-weight="700"')}`
  // stats row
  o += card(8, 50, 108, 52, 'ACTIVE AGENTS', `${s.active}/${s.total}`, C.ok)
  o += card(122, 50, 108, 52, 'RUNNING TASKS', String(s.running), C.warn)
  o += card(236, 50, 108, 52, 'COMPLETED', String(s.completed), '#60a5fa')
  o += card(350, 50, 108, 52, 'PROGRESS', s.pct === undefined ? 'n/a' : `${s.pct}%`, '#a78bfa')
  o += `<rect x="464" y="50" width="288" height="52" rx="9" fill="${C.card}" stroke="${C.line}"/>${text(474, 68, clip(s.request, 46), 9, C.text, 'font-weight="600"')}${text(474, 82, `Tokens ${s.tokens}`, 8, C.dim)}<rect x="474" y="90" width="268" height="5" rx="2.5" fill="#232838"/><rect x="474" y="90" width="${s.pct === undefined ? 0 : Math.round(2.68 * s.pct)}" height="5" rx="2.5" fill="${C.accent}"/>${s.pct === undefined && s.live ? `<rect x="474" y="90" width="44" height="5" rx="2.5" fill="${C.accent}"><animate attributeName="x" values="474;698;474" dur="2.4s" repeatCount="indefinite"/></rect>` : ''}`
  parts.push(mk('header', 0, 0, W, 108, o))
  // the office: rooms first, then everything that stands on the floor in depth order, then the tags on top
  o = roomsBase(count)
  const occ: Record<number, Placed> = {}
  for (const p of placed) if (p.room === 'workspace') occ[deskIndex(p.slot)] = p
  const ws: { y: number; svg: string }[] = DESKS.map((pos, d) => ({ y: pos.y, svg: deskSvg(pos, occ[d], d) }))
  const others: { y: number; svg: string }[] = []
  for (const p of placed) (p.room === 'workspace' ? ws : others).push({ y: posOf(p).y + 0.5, svg: avatarBody(p, moves[p.id], now) })
  const byY = (a: { y: number }, b: { y: number }) => a.y - b.y
  o += ws.sort(byY).map(i => i.svg).join('') + others.sort(byY).map(i => i.svg).join('')
  // documents in flight (task handed in / result handed over)
  for (const p of placed) {
    if (p.docFrom && byId[p.docFrom]) o += flyingDoc(posOf(byId[p.docFrom] as Placed), posOf(p), 'in-' + p.id)
    if (p.docTo && byId[p.docTo]) o += flyingDoc(posOf(p), posOf(byId[p.docTo] as Placed), 'out-' + p.id)
  }
  // with many people at desks the tags shrink to the name and the bubbles go (the cards below say the rest)
  const crowded = count.workspace > 3
  o += [...placed].sort((a, b) => posOf(a).y - posOf(b).y).map(p => avatarTag(p, moves[p.id], now, crowded && p.room === 'workspace', !(crowded && p.room === 'workspace'))).join('')
  parts.push(mk('floor', 0, FLOOR_TOP, W, FLOOR_H, o))
  o = ''
  // bottom: one card per agent (avatar, name, role, status, progress), the feed and the timeline
  o += text(12, PY + 12, 'AGENT ACTIVITY', 8, C.dim, 'letter-spacing="1"')
  placed.slice(0, 6).forEach((p, i) => {
    const y = PY + 18 + i * 40
    const col = toneColor(p.tone)
    o += `<rect x="8" y="${y}" width="244" height="36" rx="8" fill="${C.card}" stroke="${C.line}"/><circle cx="26" cy="${y + 18}" r="11" fill="${p.color}"/><circle cx="26" cy="${y + 15.5}" r="4.6" fill="#f2c9a5"/><path d="M21.4 ${y + 15}a4.6 4.6 0 0 1 9.2 0z" fill="#3b2a1f"/><path d="M21.5 ${y + 28}a4.5 5 0 0 1 9 0z" fill="#fff" fill-opacity=".85"/>${text(42, y + 14, clip(p.name, 14), 9.5, C.text, 'font-weight="700"')}${text(42 + Math.min(p.name.length, 14) * 5.6 + 5, y + 14, '· ' + roleOf(p), 8, C.dim)}<rect x="192" y="${y + 6}" width="54" height="13" rx="6.5" fill="${col}" fill-opacity=".16"/>${text(197, y + 15.5, clip(p.label, 11), 7, col, 'font-weight="700"')}${text(42, y + 26, clip(`${p.pct !== undefined ? p.pct + '% · ' : ''}${p.skill ? 'skill ' + p.skill + ' · ' : ''}${p.activity}`, 44), 7.5, C.dim)}${p.pct !== undefined ? `<rect x="42" y="${y + 30}" width="198" height="2.5" rx="1.2" fill="#232838"/><rect x="42" y="${y + 30}" width="${Math.round(1.98 * p.pct)}" height="2.5" rx="1.2" fill="${p.color}"/>` : ''}`
  })
  if (placed.length > 6) o += text(12, PY + 18 + 6 * 40 + 8, `+${placed.length - 6} more agents`, 8, C.dim)
  parts.push(mk('activity', 0, PY, 256, HB, o))
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
  parts.push(mk('comms', 256, PY, 254, HB, o))
  o = ''
  o += text(512, PY + 12, 'TASK TIMELINE', 8, C.dim, 'letter-spacing="1"')
  placed.slice(0, 10).forEach((p, i) => {
    const y = PY + 20 + i * 23
    const full = p.status === 'completed'
    const w = full ? 124 : p.pct === undefined ? 0 : Math.round(1.24 * p.pct)
    o += `${text(512, y + 9, clip(p.name, 12), 8, C.text)}<rect x="590" y="${y + 1}" width="124" height="8" rx="4" fill="#232838"/><rect x="590" y="${y + 1}" width="${w}" height="8" rx="4" fill="${p.color}"/>${p.tone === 'live' && !full && p.pct === undefined ? `<rect x="590" y="${y + 1}" width="26" height="8" rx="4" fill="${p.color}"><animate attributeName="x" values="590;688;590" dur="${2 + (i % 3) * 0.5}s" repeatCount="indefinite"/></rect>` : ''}${text(720, y + 9, full ? '✓ done' : p.pct === undefined ? '…' : p.pct + '%', 7.5, C.dim)}`
  })
  parts.push(mk('timeline', 510, PY, 250, HB, o))
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
