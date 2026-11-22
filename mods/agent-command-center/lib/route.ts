// "Route map" view: the work travels along a rail from the main chat to one station per agent, in launch order. A courier
// (tram) carries each new handoff to its station and a tag follows it; every station shows its agent, role and state;
// cards under the map give the step details of the agents that are working right now (several at once when they run in
// parallel), and a stepper shows how the request went. Pure and self-contained like the other views: real hook state in,
// SVG parts out. Two looks: light (cream and orange) and dark.
import { esc, place, roleOf } from './office'
import type { OfficeInput, Part, Placed } from './office'
import { dur, tok } from './sections'
import { laneNames, visibleLanes } from './flow'

export type Theme = 'light' | 'dark'
type Look = {
  bg: string
  card: string
  line: string
  text: string
  dim: string
  accent: string
  ground: string
  edge: string
  plat: string
  platSide: string
  rail: string
  tie: string
  tree: string
  trunk: string
  ok: string
  warn: string
  bad: string
  live: string
}
const LOOKS: Record<Theme, Look> = {
  light: { bg: '#f6f0df', card: '#ffffff', line: '#e7dcc3', text: '#23201b', dim: '#82796a', accent: '#ee6a24', ground: '#eef3d6', edge: '#d3dab4', plat: '#fcf9ef', platSide: '#e0d7bf', rail: '#46433f', tie: '#d9cfb6', tree: '#7fbf5a', trunk: '#8b6b4a', ok: '#0a8f3c', warn: '#d98a00', bad: '#c9302c', live: '#2f6fd0' },
  dark: { bg: '#0b0d14', card: '#12151f', line: '#232838', text: '#e6e9f2', dim: '#7c859c', accent: '#ff8a4c', ground: '#141d29', edge: '#0a1016', plat: '#27324a', platSide: '#172033', rail: '#05070b', tie: '#2c364a', tree: '#2f7a52', trunk: '#4a3a2a', ok: '#0ca30c', warn: '#fab219', bad: '#d03b3b', live: '#6da7ec' },
}

const W = 760
const COLS = 5 // stations per row; a longer route turns at the right edge and comes back along a second row
const X0 = 90
const DX = 145
const ROW_Y = [118, 268]
const TX = 54 // half width of a platform tile
const TY = 27
const clip = (s: string, n: number) => {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const f1 = (n: number) => Math.round(n * 10) / 10

/** Mix two #rrggbb colours: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) || 0)
  const x = p(a)
  const y = p(b)
  return '#' + x.map((v, i) => Math.round(v + ((y[i] as number) - v) * t).toString(16).padStart(2, '0')).join('')
}

type Spot = { x: number; y: number }
/** Where station `i` stands (0 is the main chat's depot). Rows snake: the second row runs right to left. */
export function stationPos(i: number, count: number): Spot {
  if (count <= COLS) {
    const step = count <= 1 ? 0 : Math.min(DX, (W - 2 * X0) / (count - 1))
    const x0 = count <= 1 ? W / 2 : count === COLS ? X0 : (W - step * (count - 1)) / 2
    return { x: x0 + i * step, y: ROW_Y[0] as number }
  }
  if (i < COLS) return { x: X0 + i * DX, y: ROW_Y[0] as number }
  return { x: X0 + (2 * COLS - 1 - i) * DX, y: ROW_Y[1] as number }
}

type Phase = 'done' | 'bad' | 'sent' | 'work' | 'warn'
export function phaseOf(p: Pick<Placed, 'status' | 'handoff' | 'blocked'>): Phase {
  if (p.status === 'completed') return 'done'
  if (p.status === 'failed' || p.status === 'stopped' || p.handoff === 'refused') return 'bad'
  if (p.handoff === 'dispatched' || p.status === 'starting') return 'sent'
  if (p.status === 'waiting' || p.status === 'idle' || p.blocked) return 'warn'
  return 'work'
}

const mk = (L: Look, id: string, h: number, inner: string): Part => ({
  id,
  w: W,
  h,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" font-family="Segoe UI, system-ui, sans-serif"><rect x="0" y="0" width="${W}" height="${h}" rx="10" fill="${L.bg}"/>${inner}</svg>`,
})
const text = (x: number, y: number, s: string, size: number, fill: string, extra = '') => `<text x="${f1(x)}" y="${f1(y)}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`

/** An isometric box standing on (cx, cy): `h` tall, `tx` x `ty` half-extents on the ground. */
function box(cx: number, cy: number, tx: number, ty: number, h: number, top: string, left: string, right: string, stroke = 'none') {
  const p = (...pts: number[]) => pts.map(f1).join(' ')
  return (
    `<polygon points="${p(cx - tx, cy - h, cx, cy - h + ty, cx, cy + ty, cx - tx, cy)}" fill="${left}" stroke="${stroke}" stroke-width=".6"/>` +
    `<polygon points="${p(cx + tx, cy - h, cx, cy - h + ty, cx, cy + ty, cx + tx, cy)}" fill="${right}" stroke="${stroke}" stroke-width=".6"/>` +
    `<polygon points="${p(cx, cy - h - ty, cx + tx, cy - h, cx, cy - h + ty, cx - tx, cy - h)}" fill="${top}" stroke="${stroke}" stroke-width=".6"/>`
  )
}

/** A small pictogram for the agent's role, drawn on the top of its building. */
function glyph(role: string, cx: number, cy: number): string {
  const s = '#ffffff'
  const g = (inner: string) => `<g fill="none" stroke="${s}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" transform="translate(${f1(cx)} ${f1(cy)}) scale(.9)">${inner}</g>`
  switch (role) {
    case 'Research':
      return g('<circle cx="-1.5" cy="-1" r="4"/><path d="M1.5 2l4 4"/>')
    case 'Planner':
      return g('<path d="M-5 -4h10M-5 0h10M-5 4h6"/>')
    case 'QA':
      return g('<path d="M0 -6l5 2v4c0 3-2.5 5-5 6-2.5-1-5-3-5-6v-4z"/><path d="M-2 0l1.7 1.8L2.4 -2"/>')
    case 'Designer':
      return g('<path d="M-5 5l1-4 7-7 3 3-7 7z"/>')
    case 'Developer':
      return g('<path d="M-2 -4l-4 4 4 4M2 -4l4 4-4 4"/>')
    case 'Manager':
      return g('<path d="M0 -6l1.8 3.8 4.2.5-3.1 2.9.8 4.2L0 3.3-3.7 6l.8-4.2L-6 -1.7l4.2-.5z"/>')
    default:
      return g('<circle cx="0" cy="0" r="3.5"/>')
  }
}

type Station = { i: number; p?: Placed; name: string; role: string; phase?: Phase; color: string; x: number; y: number }

function stationSvg(L: Look, s: Station, live: boolean): string {
  const { x, y } = s
  let o = `<g>`
  if (s.p) o += `<title>${[`Step ${s.i}: ${s.name} (${s.role})`, `Status: ${s.p.label}${s.p.blocked ? ' — ' + s.p.blocked : ''}`, `Now: ${s.p.activity}`, s.p.skill ? `Skill: ${s.p.skill}` : '', `Tokens: ${s.p.tokens}`].filter(Boolean).map(esc).join('&#10;')}</title>`
  // working: a pulsing ring in the agent's colour around its platform
  if (s.phase === 'work') o += `<ellipse cx="${f1(x)}" cy="${f1(y + 3)}" rx="${TX + 10}" ry="${TY + 6}" fill="none" stroke="${s.color}" stroke-width="2.4"><animate attributeName="stroke-opacity" values=".95;.2;.95" dur="1.6s" repeatCount="indefinite"/></ellipse>`
  if (s.phase === 'sent') o += `<ellipse cx="${f1(x)}" cy="${f1(y + 3)}" rx="${TX + 8}" ry="${TY + 5}" fill="none" stroke="${L.warn}" stroke-width="1.6" stroke-dasharray="5 4"/>`
  // platform and building
  o += box(x, y, TX, TY, 7, L.plat, L.platSide, mix(L.platSide, '#000000', 0.12), L.platSide)
  const bTop = s.color
  o += box(x, y - 7, 21, 10.5, 24, bTop, mix(s.color, '#000000', 0.28), mix(s.color, '#000000', 0.42))
  o += glyph(s.role, x, y - 7 - 24)
  // numbered flag
  const fx = x - TX + 12
  const fy = y - 4
  if (s.i > 0) o += `<path d="M${f1(fx)} ${f1(fy)}V${f1(fy - 44)}" stroke="${L.rail}" stroke-width="1.6"/><rect x="${f1(fx)}" y="${f1(fy - 44)}" width="${s.i > 9 ? 22 : 17}" height="13" rx="3" fill="${L.accent}"/>${text(fx + (s.i > 9 ? 11 : 8.5), fy - 34, String(s.i), 9.5, '#ffffff', 'font-weight="800" text-anchor="middle"')}`
  // state badge on the platform's right corner
  const bx = x + TX - 10
  const by = y - 22
  if (s.phase === 'done') o += `<circle cx="${f1(bx)}" cy="${f1(by)}" r="8.5" fill="${L.ok}" stroke="${L.plat}" stroke-width="1.5"/><path d="M${f1(bx - 3.6)} ${f1(by)}l2.6 2.8 4.6-5.4" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  else if (s.phase === 'bad') o += `<circle cx="${f1(bx)}" cy="${f1(by)}" r="8.5" fill="${L.bad}" stroke="${L.plat}" stroke-width="1.5"/><path d="M${f1(bx - 3)} ${f1(by - 3)}l6 6M${f1(bx + 3)} ${f1(by - 3)}l-6 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`
  else if (s.phase === 'warn') o += `<circle cx="${f1(bx)}" cy="${f1(by)}" r="8.5" fill="${L.warn}" stroke="${L.plat}" stroke-width="1.5"/><rect x="${f1(bx - 1)}" y="${f1(by - 4.5)}" width="2" height="6" rx="1" fill="#fff"/><circle cx="${f1(bx)}" cy="${f1(by + 3.6)}" r="1.2" fill="#fff"/>`
  // labels: name, then role and state
  const label = s.p ? s.p.label : live ? 'Waiting' : 'Idle'
  o += text(x, y + 43, clip(s.name, 17), 10, L.text, 'font-weight="700" text-anchor="middle"')
  o += text(x, y + 55, `${s.role} · ${clip(label, 14)}`, 8, L.dim, 'text-anchor="middle"')
  // what a working agent is doing right now
  if (s.p && s.phase === 'work' && s.p.activity) {
    const a = clip(s.p.skill ? `skill ${s.p.skill}` : s.p.activity, 22)
    const w = Math.max(48, a.length * 5 + 16)
    o += `<rect x="${f1(x - w / 2)}" y="${f1(y - 78)}" width="${f1(w)}" height="16" rx="8" fill="${L.card}" stroke="${s.color}" stroke-width="1.2"/>${text(x, y - 67, a, 8, L.text, 'font-weight="600" text-anchor="middle"')}`
  }
  return o + '</g>'
}

/** The rail between station i-1 and i, as a path piece starting at the previous station. */
function legD(i: number, count: number, ox = 0, oy = 0): string {
  const a = stationPos(i - 1, count)
  const b = stationPos(i, count)
  const P = (s: Spot) => `${f1(s.x - ox)} ${f1(s.y - oy)}`
  if (count > COLS && i === COLS) {
    // the turn: out to the right, then back along the second row
    const r = a.x + 62
    return `C${f1(r - ox)} ${f1(a.y - oy)} ${f1(r - ox)} ${f1(b.y - oy)} ${P(b)}`
  }
  return `L${P(b)}`
}
function pathTo(k: number, count: number, ox = 0, oy = 0): string {
  const s = stationPos(0, count)
  let d = `M${f1(s.x - ox)} ${f1(s.y - oy)}`
  for (let i = 1; i <= k; i++) d += legD(i, count, ox, oy)
  return d
}

function tram(L: Look, num: number | undefined): string {
  return `<g><ellipse cx="0" cy="9" rx="17" ry="4" fill="#000" fill-opacity=".14"/><rect x="-15" y="-7" width="30" height="15" rx="4" fill="#ffffff" stroke="${L.rail}" stroke-width="1"/><rect x="-15" y="2" width="30" height="6" rx="3" fill="${L.accent}"/><rect x="-11" y="-4" width="7" height="5" rx="1.2" fill="${L.rail}" fill-opacity=".75"/><rect x="-2" y="-4" width="7" height="5" rx="1.2" fill="${L.rail}" fill-opacity=".75"/><circle cx="9" cy="-12" r="3.4" fill="${L.accent}"/>${num !== undefined ? `<circle cx="10" cy="-1.5" r="4.6" fill="${L.accent}"/>${text(10, 1.3, String(num), 6.5, '#fff', 'font-weight="800" text-anchor="middle"')}` : ''}</g>`
}
function tag(L: Look, s: string, up = 0) {
  const w = Math.max(70, s.length * 5.1 + 18)
  return `<g transform="translate(0 ${-up})"><rect x="${f1(-w / 2)}" y="-40" width="${f1(w)}" height="17" rx="8.5" fill="${L.card}" stroke="${L.accent}" stroke-width="1.2"/><circle cx="${f1(-w / 2 + 9)}" cy="-31.5" r="2.6" fill="${L.accent}"/>${text(-w / 2 + 16, -28.4, s, 8, L.text, 'font-weight="700"')}</g>`
}

function header(L: Look, input: OfficeInput, placed: Placed[]): Part {
  const s = input.stats
  const agents = placed.filter(p => !p.isMain)
  const live = agents.filter(p => p.status !== 'completed' && p.status !== 'failed' && p.status !== 'stopped').length
  const returned = agents.filter(p => p.status === 'completed').length
  let o = ''
  const title = clip(input.title || 'This chat', 34)
  const tw = Math.max(190, 70 + title.length * 6.2)
  o += `<rect x="8" y="8" width="${f1(tw)}" height="34" rx="10" fill="${L.card}" stroke="${L.line}"/><rect x="14" y="14" width="22" height="22" rx="7" fill="${L.accent}"/><path d="M19 27l4-8 4 8" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>${text(42, 22, title, 9.5, L.text, 'font-weight="700"')}`
  o += `<circle cx="47" cy="33" r="2.6" fill="${s.live ? L.ok : L.dim}">${s.live ? '<animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>${text(54, 36, s.live ? (live > 1 ? `${live} agents in parallel · live` : live === 1 ? '1 agent working · live' : 'live') : 'idle', 7.5, L.dim)}`
  o += `<rect x="${f1(tw + 14)}" y="8" width="${f1(744 - tw - 6)}" height="34" rx="10" fill="${L.card}" stroke="${L.line}"/>${text(tw + 26, 22, clip(s.request, 70), 9, L.text, 'font-weight="600"')}<rect x="${f1(tw + 26)}" y="30" width="${f1(744 - tw - 30)}" height="5" rx="2.5" fill="${L.line}"/><rect x="${f1(tw + 26)}" y="30" width="${s.pct === undefined ? 0 : f1(((744 - tw - 30) * s.pct) / 100)}" height="5" rx="2.5" fill="${L.accent}"/>`
  const pill = (x: number, w: number, label: string, value: string, col: string) =>
    `<rect x="${x}" y="50" width="${w}" height="40" rx="10" fill="${L.card}" stroke="${L.line}"/><circle cx="${x + 14}" cy="62" r="3.4" fill="${col}"/>${text(x + 22, 65, label, 7.5, L.dim, 'letter-spacing=".6"')}${text(x + 12, 83, value, 16, col === L.dim ? L.text : L.text, 'font-weight="800"')}`
  o += pill(8, 140, 'AGENTS', `${s.active}/${s.total}`, L.ok)
  o += pill(154, 140, 'IN PARALLEL', String(live), L.live)
  o += pill(300, 140, 'REPORTS IN', `${returned}/${agents.length}`, L.accent)
  o += pill(446, 140, 'TOKENS', s.tokens, L.warn)
  o += pill(592, 160, 'PROGRESS', s.pct === undefined ? 'n/a' : `${s.pct}%`, L.dim)
  return mk(L, 'rhead', 98, o)
}

function trees(L: Look, H: number, spots: Spot[]): string {
  const cand: Spot[] = [[34, 70], [726, 76], [210, 62], [330, 60], [452, 62], [560, 66], [36, H - 34], [724, H - 36], [260, H - 26], [500, H - 28], [150, 176], [610, 186]].map(([x, y]) => ({ x: x as number, y: y as number }))
  let o = ''
  let n = 0
  for (const c of cand) {
    if (n >= 9) break
    if (spots.some(s => Math.abs(s.x - c.x) < 78 && Math.abs(s.y - c.y) < 70)) continue
    n++
    o += `<rect x="${c.x - 1.6}" y="${c.y}" width="3.2" height="8" fill="${L.trunk}"/><circle cx="${c.x}" cy="${c.y - 2}" r="8" fill="${L.tree}"/><circle cx="${c.x - 3}" cy="${c.y - 4}" r="3.4" fill="#ffffff" fill-opacity=".18"/>`
  }
  return o
}

function map(L: Look, input: OfficeInput, placed: Placed[], names: Record<string, string>): Part {
  const { shown, hidden, hiddenLive } = visibleLanes(placed)
  const all = placed.filter(p => !p.isMain)
  const main = placed.find(p => p.isMain)
  const count = shown.length + 1
  const rows = count > COLS ? 2 : 1
  const H = rows === 1 ? 214 : 372
  const liveNow = all.filter(p => p.status !== 'completed' && p.status !== 'failed' && p.status !== 'stopped').length
  const stations: Station[] = [
    { i: 0, name: clip(main?.name ?? 'Main chat', 17), role: 'Manager', color: main?.color ?? L.accent, x: stationPos(0, count).x, y: stationPos(0, count).y, phase: undefined, p: undefined },
    ...shown.map((p, k) => ({ i: all.indexOf(p) + 1, p, name: names[p.id] ?? p.name, role: roleOf(p), phase: phaseOf(p), color: p.color, ...stationPos(k + 1, count) })),
  ]
  let o = `<rect x="10" y="${42 + 7}" width="740" height="${H - 50}" rx="18" fill="${L.edge}"/><rect x="10" y="40" width="740" height="${H - 50}" rx="18" fill="${L.ground}" stroke="${L.accent}" stroke-width="4"/>`
  o += `<path d="M30 ${H - 24}H730" stroke="${L.rail}" stroke-opacity=".5" stroke-width="3" stroke-dasharray="14 10"/>`
  o += text(14, 24, 'ROUTE MAP', 8, L.dim, 'letter-spacing="1"') + text(78, 24, liveNow > 1 ? `${liveNow} agents running in parallel, one station each` : 'work travels along the rail to one station per agent, in launch order', 8, liveNow > 1 ? L.live : L.dim)
  o += trees(L, H, stations)
  // rails: each leg is laid (solid) once its agent has started, and dashed while the handoff is still on its way
  for (let k = 1; k < stations.length; k++) {
    const st = stations[k] as Station
    const laid = st.phase !== 'sent'
    const d = `M${f1((stationPos(k - 1, count)).x)} ${f1(stationPos(k - 1, count).y)}${legD(k, count)}`
    o += `<path d="${d}" fill="none" stroke="${L.rail}" stroke-opacity=".28" stroke-width="9" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${laid ? st.color : L.tie}" stroke-width="5" stroke-linecap="butt" stroke-dasharray="2.5 5"/><path d="${d}" fill="none" stroke="${L.rail}" stroke-width="1.4" stroke-opacity="${laid ? 0.8 : 0.35}"/>`
    const a0 = stationPos(k - 1, count)
    const b0 = stationPos(k, count)
    if (!(count > COLS && k === COLS)) {
      const ang = (Math.atan2(b0.y - a0.y, b0.x - a0.x) * 180) / Math.PI
      o += `<path d="M-4.5 -4L4 0L-4.5 4z" transform="translate(${f1((a0.x + b0.x) / 2)} ${f1((a0.y + b0.y) / 2 + 2)}) rotate(${f1(ang)})" fill="${L.accent}"/>`
    }
  }
  // stations back to front so a lower row never hides a higher one
  for (const s of [...stations].sort((a, b) => a.y - b.y || a.x - b.x)) o += stationSvg(L, s, input.stats.live)
  // the couriers: one per handoff that is still on its way (so parallel launches each get a tram), else parked
  const pending = stations.filter(s => s.phase === 'sent')
  const place1 = (k: number, spot: Spot, label: string | undefined, num: number | undefined, animateTo?: number, full?: boolean, up = 0) => {
    const anim = animateTo !== undefined
    const d = anim ? pathTo(animateTo, count, spot.x, spot.y) : ''
    const dt = anim ? Math.max(3.2, 2.1 * animateTo + 1.2) : 0
    const begin = anim ? `begin="${f1((k % 3) * 0.9)}s" ` : ''
    return `<g transform="translate(${f1(spot.x)} ${f1(spot.y + 18)})">${anim ? `<animateMotion path="${d}" dur="${f1(dt)}s" ${begin}repeatCount="indefinite" calcMode="linear"/>` : ''}${tram(L, num)}${full && label ? tag(L, label, up) : ''}</g>`
  }
  if (pending.length) {
    pending.slice(-3).forEach((s, k, arr) => {
      const idx = stations.indexOf(s)
      const last = k === arr.length - 1
      o += place1(k, { x: s.x, y: s.y }, `Courier · Step ${s.i} · ${clip(s.name, 14)} · handed off`, s.i, idx, last)
    })
    if (pending.length > 3) o += text(14, H - 30, `+${pending.length - 3} more handoffs on the way`, 8, L.warn)
  } else {
    const dep = stations[0] as Station
    const lastSt = stations[stations.length - 1] as Station
    if (liveNow > 0) o += place1(0, { x: dep.x, y: dep.y }, `Waiting on ${liveNow} agent${liveNow === 1 ? '' : 's'}`, undefined, undefined, true, 38)
    else if (all.length) o += place1(0, { x: lastSt.x, y: lastSt.y }, all.every(p => p.status === 'completed') ? 'All reports delivered' : 'Run finished', undefined, undefined, true, 38)
    else o += place1(0, { x: dep.x, y: dep.y }, 'No agents yet', undefined, undefined, true, 38)
  }
  if (hidden) o += text(746, H - 30, hiddenLive ? `+${hidden} more agents not shown (${hiddenLive} still running)` : `+${hidden} earlier agent${hidden === 1 ? '' : 's'} finished`, 8, hiddenLive ? L.warn : L.dim, 'text-anchor="end"')
  return mk(L, 'rmap', H, o)
}

const PHASE_LABEL: Record<Phase, string> = { done: 'REPORT DELIVERED', bad: 'STOPPED', sent: 'HANDED OFF', work: 'WORKING', warn: 'WAITING' }

function cards(L: Look, input: OfficeInput, placed: Placed[], names: Record<string, string>): Part {
  const all = placed.filter(p => !p.isMain)
  const live = all.filter(p => p.status !== 'completed' && p.status !== 'failed' && p.status !== 'stopped')
  const focus = (live.length ? live : all.slice(-1)).slice(-3)
  let o = ''
  let y = 6
  if (!focus.length) {
    o += `<rect x="8" y="${y}" width="744" height="62" rx="12" fill="${L.card}" stroke="${L.line}"/>${text(22, y + 26, 'No agents yet', 12, L.text, 'font-weight="700"')}${text(22, y + 44, 'Each agent becomes a station on the route the moment it is handed a task.', 9, L.dim)}`
  } else {
    const n = focus.length
    const w = Math.min(360, (744 - 8 * (n - 1)) / n)
    focus.forEach((p, k) => {
      const x = 8 + k * (w + 8)
      const ph = phaseOf(p)
      const col = ph === 'done' ? L.ok : ph === 'bad' ? L.bad : ph === 'warn' ? L.warn : ph === 'sent' ? L.warn : L.live
      const step = all.indexOf(p) + 1
      const chars = Math.floor((w - 28) / 5.2)
      o += `<g><rect x="${f1(x)}" y="${y}" width="${f1(w)}" height="86" rx="12" fill="${L.card}" stroke="${ph === 'bad' ? L.bad : L.line}"/><rect x="${f1(x)}" y="${y + 14}" width="4" height="58" rx="2" fill="${p.color}"/>`
      o += `${text(x + 16, y + 20, `STEP ${step} · ${PHASE_LABEL[ph]}`, 7.5, col, 'font-weight="800" letter-spacing=".8"')}${text(x + 16, y + 37, clip(names[p.id] ?? p.name, chars), 12, L.text, 'font-weight="800"')}`
      o += `${text(x + 16, y + 52, clip(`${roleOf(p)} · ${p.skill ? 'skill ' + p.skill + ' · ' : ''}${p.activity}`, chars), 8.5, L.dim)}`
      o += `<rect x="${f1(x + 16)}" y="${y + 61}" width="${f1(w - 32)}" height="5" rx="2.5" fill="${L.line}"/>`
      const pw = ph === 'done' ? w - 32 : p.pct === undefined ? 0 : ((w - 32) * Math.min(100, p.pct)) / 100
      if (pw) o += `<rect x="${f1(x + 16)}" y="${y + 61}" width="${f1(pw)}" height="5" rx="2.5" fill="${p.color}"/>`
      if (ph === 'work' && p.pct === undefined) o += `<rect x="${f1(x + 16)}" y="${y + 61}" width="46" height="5" rx="2.5" fill="${p.color}"><animate attributeName="x" values="${f1(x + 16)};${f1(x + w - 62)};${f1(x + 16)}" dur="2.6s" repeatCount="indefinite"/></rect>`
      o += `${text(x + 16, y + 79, `${dur(p.runMs ?? 0)} · ${tok(p.tokens)} tok`, 8, L.dim)}${text(x + w - 14, y + 79, p.pct === undefined ? '' : `${p.pct}%`, 8, L.dim, 'text-anchor="end"')}</g>`
    })
    if (live.length > 3) o += text(752, y + 100, `+${live.length - 3} more working`, 8, L.warn, 'text-anchor="end"')
  }
  y += 98
  // the stepper: how the request went, one node per agent in launch order
  const { shown } = visibleLanes(placed)
  o += text(12, y + 8, 'HOW IT WENT', 8, L.dim, 'letter-spacing="1"')
  y += 22
  if (shown.length) {
    const n = shown.length
    const x0 = 60
    const x1 = 700
    const stepX = n === 1 ? 0 : (x1 - x0) / (n - 1)
    const xs = shown.map((_, k) => (n === 1 ? 380 : x0 + k * stepX))
    o += `<path d="M${f1(xs[0] as number)} ${y}H${f1(xs[n - 1] as number)}" stroke="${L.line}" stroke-width="3" stroke-linecap="round"/>`
    // the line fills up to the last agent in a row that has delivered
    let lastDone = -1
    shown.forEach((p, k) => {
      if (phaseOf(p) === 'done') lastDone = k
    })
    if (lastDone > 0) o += `<path d="M${f1(xs[0] as number)} ${y}H${f1(xs[lastDone] as number)}" stroke="${L.accent}" stroke-width="3" stroke-linecap="round"/>`
    shown.forEach((p, k) => {
      const ph = phaseOf(p)
      const cx = xs[k] as number
      const fill = ph === 'done' ? L.accent : ph === 'bad' ? L.bad : L.card
      const ring = ph === 'done' ? L.accent : ph === 'bad' ? L.bad : ph === 'work' ? p.color : ph === 'warn' || ph === 'sent' ? L.warn : L.line
      o += `<g><title>${esc(`Step ${all.indexOf(p) + 1}: ${names[p.id] ?? p.name} — ${p.label}`)}</title><circle cx="${f1(cx)}" cy="${y}" r="9" fill="${fill}" stroke="${ring}" stroke-width="2.2">${ph === 'work' ? '<animate attributeName="r" values="8;10.5;8" dur="1.5s" repeatCount="indefinite"/>' : ''}</circle>${text(cx, y + 3.4, String(all.indexOf(p) + 1), 8.5, ph === 'done' || ph === 'bad' ? '#fff' : L.text, 'font-weight="800" text-anchor="middle"')}${text(cx, y + 24, clip(names[p.id] ?? p.name, Math.max(8, Math.floor(stepX / 5.4) || 14)), 7.5, ph === 'work' ? L.text : L.dim, 'text-anchor="middle"')}</g>`
    })
    y += 34
  } else {
    o += text(14, y + 4, 'No steps yet', 8.5, L.dim)
    y += 14
  }
  return mk(L, 'rcards', y + 6, o)
}

function feed(L: Look, input: OfficeInput, placed: Placed[], names: Record<string, string>): Part {
  const items = input.feed.slice(-4).reverse()
  let o = text(12, 14, 'HANDOFFS AND MESSAGES', 8, L.dim, 'letter-spacing="1"') + `<circle cx="150" cy="11" r="2.6" fill="${L.ok}"><animate attributeName="opacity" values="1;.2;1" dur="1.4s" repeatCount="indefinite"/></circle>`
  if (!items.length) o += text(14, 36, 'No agent activity yet', 9, L.dim)
  items.forEach((f, i) => {
    const y = 22 + i * 30
    const pc = placed.find(p => p.name === f.who)
    const dup = placed.filter(p => p.name === f.who).length > 1
    const who = !dup && pc ? (names[pc.id] ?? f.who) : f.who
    o += `<rect x="8" y="${y}" width="744" height="26" rx="9" fill="${L.card}" stroke="${f.tone === 'bad' ? L.bad : L.line}"/><circle cx="22" cy="${y + 13}" r="4" fill="${pc?.color ?? L.accent}"/>${text(32, y + 16.5, clip(who, 18), 8.5, L.text, 'font-weight="700"')}${text(150, y + 16.5, clip(f.text, 92), 8.5, L.dim)}${text(742, y + 16.5, f.time, 7.5, L.dim, 'text-anchor="end"')}`
  })
  return mk(L, 'rfeed', 22 + Math.max(1, items.length) * 30 + 6, o)
}

/** The route map as independent SVGs (header, map, step cards with the stepper, feed). */
export function routeParts(input: OfficeInput, now: number, animate = true, theme: Theme = 'light'): Part[] {
  const L = LOOKS[theme]
  const placed = place(input.people, now)
  const names = laneNames(placed)
  const parts = [header(L, input, placed), map(L, input, placed, names), cards(L, input, placed, names), feed(L, input, placed, names)]
  return animate ? parts : parts.map(p => ({ ...p, svg: p.svg.replace(/<animate(?:Motion|Transform)?\b[^>]*\/>/g, '') }))
}
