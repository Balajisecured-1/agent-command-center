// "Pipeline" view: one lane per agent, one under another in the order they were launched. Each lane shows the agent's
// own four stages (handed off, started, working, report delivered), its own progress bar, who it is and what it is
// doing now. Pure and self-contained, like the office: real hook state in, SVG parts out.
import { C, esc, place, roleOf } from './office'
import type { OfficeInput, Part, Placed } from './office'
import { dur, tok } from './sections'

const W = 760
const LANE_H = 48
const MAX_LANES = 8
const clip = (s: string, n: number) => {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const text = (x: number, y: number, s: string, size = 9, fill = C.text, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`
const toneColor = (t: Placed['tone']) => (t === 'ok' ? C.ok : t === 'warn' ? C.warn : t === 'bad' ? C.bad : t === 'live' ? C.live : C.dim)

const STAGES = ['Handed off', 'Started', 'Working', 'Report'] as const
export type StageState = 'done' | 'now' | 'warn' | 'bad' | 'todo'

/** Where one agent is in its four stages. Exported so the rules can be tested. */
export function stagesOf(p: { isMain: boolean; status: string; blocked?: string; handoff?: string }): StageState[] {
  if (p.status === 'completed') return ['done', 'done', 'done', 'done']
  if (p.handoff === 'refused') return ['bad', 'todo', 'todo', 'todo']
  const started = p.handoff !== 'dispatched' && p.status !== 'starting'
  if (p.status === 'failed' || p.status === 'stopped') {
    const at = started ? 2 : 1
    return STAGES.map((_, i) => (i < at ? 'done' : i === at ? 'bad' : 'todo'))
  }
  if (!started) return ['done', 'now', 'todo', 'todo']
  if (p.status === 'waiting' || p.status === 'idle' || p.blocked) return ['done', 'done', 'warn', 'todo']
  return ['done', 'done', 'now', 'todo']
}

/** Names repeat (five "mp ref lens"): the second and later get a number so each lane is its own thing. */
export function laneNames(placed: Placed[]): Record<string, string> {
  const total: Record<string, number> = {}
  for (const p of placed) total[p.name] = (total[p.name] ?? 0) + 1
  const seen: Record<string, number> = {}
  const out: Record<string, string> = {}
  for (const p of placed) {
    seen[p.name] = (seen[p.name] ?? 0) + 1
    out[p.id] = (total[p.name] ?? 0) > 1 ? `${p.name} #${seen[p.name]}` : p.name
  }
  return out
}

/** All live agents stay visible; the rest of the room goes to the newest finished ones. Order stays chronological. */
export function visibleLanes(placed: Placed[], max = MAX_LANES): { shown: Placed[]; hidden: number; hiddenLive: number } {
  const agents = placed.filter(p => !p.isMain)
  const isLive = (p: Placed) => p.status !== 'completed' && p.status !== 'failed' && p.status !== 'stopped'
  if (agents.length <= max) return { shown: agents, hidden: 0, hiddenLive: 0 }
  const live = agents.filter(isLive)
  const keep = new Set(live.slice(-max).map(p => p.id))
  for (let i = agents.length - 1; i >= 0 && keep.size < max; i--) keep.add((agents[i] as Placed).id)
  const shown = agents.filter(p => keep.has(p.id))
  return { shown, hidden: agents.length - shown.length, hiddenLive: live.filter(p => !keep.has(p.id)).length }
}

const mk = (id: string, h: number, inner: string): Part => ({
  id,
  w: W,
  h,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" font-family="Segoe UI, system-ui, sans-serif"><rect x="0" y="0" width="${W}" height="${h}" rx="10" fill="${C.bg}"/>${inner}</svg>`,
})

function statCard(x: number, y: number, w: number, label: string, value: string, color: string) {
  return `<rect x="${x}" y="${y}" width="${w}" height="52" rx="9" fill="${C.card}" stroke="${C.line}"/>${text(x + 10, y + 16, label, 7.5, C.dim, 'letter-spacing="0.8"')}${text(x + 10, y + 42, value, 24, color, 'font-weight="700"')}`
}

const HEADER_H = 138

function header(input: OfficeInput, placed: Placed[], names: Record<string, string>): Part {
  const s = input.stats
  let o = ''
  const title = clip(input.title || 'This chat', 34)
  const tw = Math.max(190, 70 + title.length * 6)
  o += `<rect x="8" y="8" width="${tw}" height="34" rx="9" fill="${C.card}" stroke="${C.line}"/><rect x="14" y="14" width="22" height="22" rx="6" fill="${C.accent}"/>${text(20, 29, 'AI', 10, '#fff', 'font-weight="700"')}${text(42, 22, title, 9.5, C.text, 'font-weight="700"')}`
  o += `<circle cx="47" cy="33" r="2.6" fill="${s.live ? C.ok : C.dim}">${s.live ? '<animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>${text(54, 36, s.live ? `${s.active} agent${s.active === 1 ? '' : 's'} ${s.active > 1 ? 'working in parallel' : 'working'} · live` : 'idle', 7.5, C.dim)}`
  // the four stages, as a legend
  let lx = tw + 22
  STAGES.forEach((t, i) => {
    o += `<circle cx="${lx + 5}" cy="24" r="4.5" fill="${i === 3 ? C.ok : i === 2 ? C.live : i === 1 ? C.warn : C.dim}"/>${text(lx + 14, 27, `${i + 1}  ${t}`, 8, C.dim)}`
    lx += 22 + t.length * 5 + 22
  })
  o += statCard(8, 50, 108, 'ACTIVE AGENTS', `${s.active}/${s.total}`, C.ok)
  o += statCard(122, 50, 108, 'RUNNING TASKS', String(s.running), C.warn)
  o += statCard(236, 50, 108, 'COMPLETED', String(s.completed), '#60a5fa')
  o += statCard(350, 50, 108, 'PROGRESS', s.pct === undefined ? 'n/a' : `${s.pct}%`, '#a78bfa')
  o += `<rect x="464" y="50" width="288" height="52" rx="9" fill="${C.card}" stroke="${C.line}"/>${text(474, 68, clip(s.request, 46), 9, C.text, 'font-weight="600"')}${text(474, 82, `Tokens ${s.tokens}`, 8, C.dim)}<rect x="474" y="90" width="268" height="5" rx="2.5" fill="#232838"/><rect x="474" y="90" width="${s.pct === undefined ? 0 : Math.round(2.68 * s.pct)}" height="5" rx="2.5" fill="${C.accent}"/>`
  // one segment per agent, in launch order: the progress, step by step
  const agents = placed.filter(p => !p.isMain)
  o += text(12, 120, 'STEPS', 7.5, C.dim, 'letter-spacing="1"')
  if (!agents.length) o += text(54, 120, 'no agents launched yet', 8, C.dim)
  else {
    const n = Math.min(agents.length, 40)
    const shown = agents.slice(-n)
    const gap = 3
    const sw = Math.max(6, Math.min(40, (690 - gap * (n - 1)) / n))
    shown.forEach((p, i) => {
      const x = 54 + i * (sw + gap)
      const done = p.status === 'completed'
      const bad = p.status === 'failed' || p.status === 'stopped'
      const fill = done ? p.color : bad ? C.bad : '#232838'
      const tip = `${esc(names[p.id] ?? p.name)}: ${esc(p.label)}`
      o += `<g><title>${tip}</title><rect x="${x}" y="112" width="${sw}" height="10" rx="3" fill="${fill}"/>${!done && !bad ? `<rect x="${x}" y="112" width="${sw}" height="10" rx="3" fill="${p.color}" fill-opacity=".55"><animate attributeName="opacity" values=".25;1;.25" dur="1.4s" repeatCount="indefinite"/></rect>` : ''}</g>`
    })
    if (agents.length > n) o += text(54 + n * (sw + gap) + 2, 121, `+${agents.length - n}`, 7.5, C.dim)
  }
  return mk('header', HEADER_H, o)
}

function lane(p: Placed, name: string, y: number, step: number): string {
  const col = toneColor(p.tone)
  const st = stagesOf(p)
  const done = p.status === 'completed'
  let o = `<g><title>${[`${name} (${roleOf(p)})`, `Status: ${p.label}${p.blocked ? ' — ' + p.blocked : ''}`, `Now: ${p.activity}`, p.skill ? `Skill: ${p.skill}` : '', p.pct !== undefined ? `Progress: ${p.pct}%` : '', `Tokens: ${p.tokens}`].filter(Boolean).map(esc).join('&#10;')}</title>`
  o += `<rect x="8" y="${y}" width="744" height="${LANE_H - 4}" rx="9" fill="${C.card}" stroke="${p.tone === 'bad' ? C.bad : C.line}"/>`
  // who: order number on the agent's colour, name, role, current activity
  o += `<circle cx="28" cy="${y + 22}" r="11" fill="${p.color}"/>${text(step > 9 ? 22 : 25, y + 26, String(step), 10, '#0b0d14', 'font-weight="800"')}`
  o += `${text(46, y + 18, clip(name, 22), 10, C.text, 'font-weight="700"')}${text(46 + Math.min(name.length, 22) * 5.9 + 6, y + 18, '· ' + roleOf(p), 8, C.dim)}`
  o += `${text(46, y + 32, clip(`${p.skill ? 'skill ' + p.skill + ' · ' : ''}${p.activity}`, 58), 8, C.dim)}`
  // the four stages, as a track
  const xs = [330, 430, 530, 630]
  o += `<path d="M${xs[0]} ${y + 17}H${xs[3]}" stroke="#232838" stroke-width="2"/>`
  for (let i = 0; i < 3; i++) if (st[i] === 'done' && st[i + 1] !== 'todo') o += `<path d="M${xs[i]} ${y + 17}H${xs[i + 1]}" stroke="${p.color}" stroke-width="2"/>`
  st.forEach((s, i) => {
    const cx = xs[i] as number
    const cy = y + 17
    const fill = s === 'done' ? p.color : s === 'bad' ? C.bad : s === 'warn' ? C.warn : C.card
    const ring = s === 'todo' ? '#3a4054' : s === 'now' ? col : fill
    o += `<circle cx="${cx}" cy="${cy}" r="7" fill="${fill}" stroke="${ring}" stroke-width="2">${s === 'now' ? '<animate attributeName="r" values="6;8.5;6" dur="1.5s" repeatCount="indefinite"/>' : ''}</circle>`
    if (s === 'done') o += `<path d="M${cx - 3} ${cy}l2.2 2.4 3.8-4.6" stroke="#0b0d14" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    if (s === 'bad') o += `<path d="M${cx - 2.6} ${cy - 2.6}l5.2 5.2M${cx + 2.6} ${cy - 2.6}l-5.2 5.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`
    if (s === 'warn') o += `<rect x="${cx - 1}" y="${cy - 3.5}" width="2" height="4.5" rx="1" fill="#0b0d14"/><circle cx="${cx}" cy="${cy + 3}" r="1.1" fill="#0b0d14"/>`
    o += text(cx, y + 36, STAGES[i] as string, 7, s === 'todo' ? '#586079' : C.dim, 'text-anchor="middle"')
  })
  // status chip, time and tokens
  o += `<rect x="676" y="${y + 6}" width="68" height="14" rx="7" fill="${col}" fill-opacity=".16"/>${text(710, y + 16, clip(p.label, 12), 7.5, col, 'font-weight="700" text-anchor="middle"')}`
  o += `${text(742, y + 31, `${dur(p.runMs ?? 0)} · ${tok(p.tokens)} tok`, 7.5, C.dim, 'text-anchor="end"')}`
  // its own progress bar along the bottom of the lane
  const bx = 14
  const bw = 732
  const by = y + LANE_H - 10
  o += `<rect x="${bx}" y="${by}" width="${bw}" height="3" rx="1.5" fill="#232838"/>`
  const w = done ? bw : p.pct === undefined ? 0 : Math.round((bw * Math.min(100, p.pct)) / 100)
  if (w) o += `<rect x="${bx}" y="${by}" width="${w}" height="3" rx="1.5" fill="${p.color}"/>`
  if (!done && p.pct === undefined && p.tone === 'live') o += `<rect x="${bx}" y="${by}" width="60" height="3" rx="1.5" fill="${p.color}"><animate attributeName="x" values="${bx};${bx + bw - 60};${bx}" dur="2.6s" repeatCount="indefinite"/></rect>`
  return o + '</g>'
}

function lanes(input: OfficeInput, placed: Placed[], names: Record<string, string>): Part {
  const { shown, hidden, hiddenLive } = visibleLanes(placed)
  const liveNow = placed.filter(p => !p.isMain && p.status !== 'completed' && p.status !== 'failed' && p.status !== 'stopped').length
  const main = placed.find(p => p.isMain)
  let y = 6
  let o = text(12, y + 10, 'PIPELINE', 8, C.dim, 'letter-spacing="1"') + text(70, y + 10, liveNow > 1 ? `${liveNow} agents running in parallel, one lane each, in launch order` : 'one lane per agent, in the order they were launched', 8, liveNow > 1 ? C.live : '#586079')
  y += 18
  if (main) {
    const col = toneColor(main.tone)
    o += `<g><rect x="8" y="${y}" width="744" height="${LANE_H - 4}" rx="9" fill="${C.card}" stroke="${C.accent}" stroke-opacity=".7"/><circle cx="28" cy="${y + 22}" r="11" fill="${main.color}"/>${text(23, y + 26, 'M', 10, '#0b0d14', 'font-weight="800"')}${text(46, y + 18, clip(main.name, 28), 10, C.text, 'font-weight="700"')}${text(46 + Math.min(main.name.length, 28) * 5.9 + 6, y + 18, '· Manager', 8, C.dim)}${text(46, y + 32, clip(main.liveChildren ? `Waiting on ${main.liveChildren} agent${main.liveChildren > 1 ? 's' : ''}` : main.activity, 58), 8, C.dim)}${text(330, y + 22, clip(input.stats.request, 62), 9, C.text, 'font-weight="600"')}<rect x="676" y="${y + 6}" width="68" height="14" rx="7" fill="${col}" fill-opacity=".16"/>${text(710, y + 16, clip(main.label, 12), 7.5, col, 'font-weight="700" text-anchor="middle"')}${text(742, y + 31, `Tokens ${input.stats.tokens}`, 7.5, C.dim, 'text-anchor="end"')}</g>`
    y += LANE_H
  }
  if (hidden) {
    o += `${text(14, y + 12, hiddenLive ? `+${hidden} more agents not shown (${hiddenLive} of them still running)` : `+${hidden} earlier agent${hidden === 1 ? '' : 's'} already finished`, 8, hiddenLive ? C.warn : C.dim)}`
    y += 20
  }
  if (!shown.length) {
    o += text(14, y + 16, 'No agents launched yet. Each one appears here as its own lane the moment it is handed a task.', 9, C.dim)
    y += 30
  }
  const all = placed.filter(p => !p.isMain)
  shown.forEach(p => {
    o += lane(p, names[p.id] ?? p.name, y, all.indexOf(p) + 1)
    y += LANE_H
  })
  return mk('lanes', y + 4, o)
}

function comms(input: OfficeInput, placed: Placed[], names: Record<string, string>): Part {
  const feed = input.feed.slice(-6).reverse()
  let o = text(12, 14, 'HANDOFFS AND MESSAGES', 8, C.dim, 'letter-spacing="1"') + `<circle cx="150" cy="11" r="2.6" fill="${C.ok}"><animate attributeName="opacity" values="1;.2;1" dur="1.4s" repeatCount="indefinite"/></circle>`
  if (!feed.length) o += text(14, 36, 'No agent activity yet', 9, C.dim)
  feed.forEach((f, i) => {
    const y = 22 + i * 30
    const pc = placed.find(p => p.name === f.who)
    // when several agents share a name, the feed cannot tell which one spoke: show the plain name, never a wrong number
    const dup = placed.filter(p => p.name === f.who).length > 1
    const who = !dup && pc ? (names[pc.id] ?? f.who) : f.who
    o += `<rect x="8" y="${y}" width="744" height="26" rx="8" fill="${C.card}" stroke="${f.tone === 'bad' ? C.bad : C.line}"/><circle cx="22" cy="${y + 13}" r="4" fill="${pc?.color ?? C.accent}"/>${text(32, y + 16.5, clip(who, 18), 8.5, pc?.color ?? C.accent, 'font-weight="700"')}${text(150, y + 16.5, clip(f.text, 92), 8.5, C.text)}${text(742, y + 16.5, f.time, 7.5, C.dim, 'text-anchor="end"')}`
  })
  const h = 22 + Math.max(1, feed.length) * 30 + 6
  return mk('comms', h, o)
}

/** The pipeline as independent SVGs (header, lanes, handoff feed): each reloads only when its own content changes. */
export function flowParts(input: OfficeInput, now: number, animate = true): Part[] {
  const placed = place(input.people, now)
  const names = laneNames(placed)
  const head = header(input, placed, names)
  const ln = lanes(input, placed, names)
  const parts = [head, ln, comms(input, placed, names)]
  return animate ? parts : parts.map(p => ({ ...p, svg: p.svg.replace(/<animate(?:Transform)?[^>]*\/>/g, '') }))
}
