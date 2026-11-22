import { expect, test } from 'claude-code/testing'

import { officeInput } from '../lib/compact'
import { emptyHistory } from '../lib/derive'
import { newModel, reduce } from '../lib/model'
import type { Ev } from '../lib/model'
import { ENTRANCE, ROOMS, advance, iso, officeParts, officeSvg, place, sceneKey, slotPos } from '../lib/office'
import type { Room } from '../lib/office'

const T0 = 5_000_000
const run = (evs: Ev[]) => evs.reduce((a, e) => reduce(a, e), newModel('s1', T0))
const h = emptyHistory()

const base: Ev[] = [
  { k: 'title', t: T0, title: 'Landing page chat' },
  { k: 'request.start', t: T0, text: 'build it' },
  { k: 'turn.start', t: T0 },
  { k: 'spawn', t: T0 + 1000, agentId: 'r1', parentId: undefined, type: 'hm-researcher', name: 'scout', desc: 'research', prompt: 'p' },
]

test('names follow the real chat title, agent name and agent type', () => {
  const m = run([...base, { k: 'spawn', t: T0 + 1100, agentId: 'w1', type: 'general-purpose', desc: 'write', prompt: 'p' }])
  const input = officeInput(m, T0 + 2000, h)
  expect(input.people.map(p => p.name)).toEqual(['Landing page chat', 'scout', 'general purpose'])
  expect(input.title).toBe('Landing page chat')
})

test('a skill used by an agent shows up on it and in the feed', () => {
  const m = run([...base, { k: 'agent.start', t: T0 + 1200, agentId: 'r1', type: 'hm-researcher' }, { k: 'tool.end', t: T0 + 3000, id: 's', tool: 'Skill', agentId: 'r1', ok: true, key: 'Skill|hm-motion', summary: 'hm-motion' }])
  const input = officeInput(m, T0 + 3500, h)
  expect(input.people.find(p => p.id === 'r1')?.skill).toBe('hm-motion')
  expect(input.feed.some(f => /Skill used: hm-motion/.test(f.text) && f.who === 'scout')).toBe(true)
  expect(place(input.people, T0 + 6000).find(p => p.id === 'r1')?.bubble).toBe('skill: hm-motion')
})

test('handoff choreography: take task from parent -> work at desk -> hand over -> rest', () => {
  let m = run(base)
  // 1) dispatched: the new agent is with the manager, taking the task; a document flies parent -> agent
  let placed = place(officeInput(m, T0 + 1500, h).people, T0 + 1500)
  let r = placed.find(p => p.id === 'r1')!
  expect(r.room).toBe('manager')
  expect(r.label).toBe('Taking task')
  expect(r.docFrom).toBe('main')
  // 2) acknowledged and past the receive window: at a workspace desk, working
  m = reduce(m, { k: 'agent.start', t: T0 + 1200, agentId: 'r1', type: 'hm-researcher' })
  placed = place(officeInput(m, T0 + 9000, h).people, T0 + 9000)
  r = placed.find(p => p.id === 'r1')!
  expect(r.room).toBe('workspace')
  expect(r.label).toBe('Working')
  // 3) report arrives: walks back to the manager and hands the result over (document agent -> parent)
  m = reduce(m, { k: 'report', t: T0 + 20000, agentId: 'r1', type: 'hm-researcher', status: 'completed', text: 'found it' })
  placed = place(officeInput(m, T0 + 21000, h).people, T0 + 21000)
  r = placed.find(p => p.id === 'r1')!
  expect(r.room).toBe('manager')
  expect(r.label).toBe('Handing over')
  expect(r.docTo).toBe('main')
  // 4) then it rests in the lounge
  placed = place(officeInput(m, T0 + 30000, h).people, T0 + 30000)
  expect(placed.find(p => p.id === 'r1')?.room).toBe('lounge')
})

test('movement: a new agent walks in from the entrance, a room change becomes a walk', () => {
  const m = run(base)
  const p0 = place(officeInput(m, T0 + 1500, h).people, T0 + 1500)
  let moves = advance({}, p0, T0 + 1500)
  expect(moves['r1']?.from).toEqual(ENTRANCE)
  expect(moves['main']?.from).toEqual(moves['main']?.to)
  // later it moves to a desk: the walk starts from where it stood
  const m2 = reduce(m, { k: 'agent.start', t: T0 + 1200, agentId: 'r1', type: 'hm-researcher' })
  const p1 = place(officeInput(m2, T0 + 9000, h).people, T0 + 9000)
  moves = advance(moves, p1, T0 + 9000)
  expect(moves['r1']?.room).toBe('workspace')
  expect((moves['r1']?.from.y ?? 0) > 0).toBe(true)
  const svg = officeSvg(officeInput(m2, T0 + 9100, h), moves, T0 + 9100)
  expect(svg.includes('<animateTransform attributeName="transform" type="translate" from=')).toBe(true)
  expect(svg.includes('scout')).toBe(true)
  expect(svg.length < 131072).toBe(true)
  expect(slotPos('workspace', 0).x).toBeGreaterThan(0)
})

test('a failed agent stays at its desk marked failed; no document flies', () => {
  const m = run([...base, { k: 'agent.start', t: T0 + 1200, agentId: 'r1', type: 'hm-researcher' }, { k: 'report', t: T0 + 5000, agentId: 'r1', type: 'hm-researcher', status: 'failed', text: 'boom' }])
  const r = place(officeInput(m, T0 + 6000, h).people, T0 + 6000).find(p => p.id === 'r1')!
  expect(r.label).toBe('Failed')
  expect(r.room).toBe('workspace')
  expect(r.docTo).toBeUndefined()
})

test('animation off: no SMIL elements remain, avatars keep tooltips, status has a glyph', () => {
  const m = run([
    { k: 'request.start', t: T0, text: 'job' },
    { k: 'turn.start', t: T0 },
    { k: 'spawn', t: T0 + 10, agentId: 'a1', type: 'Explore', desc: 'scan', prompt: 'scan' },
    { k: 'agent.start', t: T0 + 20, agentId: 'a1', type: 'Explore' },
  ])
  const input = officeInput(m, T0 + 9000, emptyHistory())
  const on = officeSvg(input, {}, T0 + 9000, true)
  const off = officeSvg(input, {}, T0 + 9000, false)
  expect(/<animate/.test(on)).toBe(true)
  expect(/<animate/.test(off)).toBe(false)
  expect(/<title>[^<]*Status:/.test(off)).toBe(true)
  expect(/[✓✕!●○] /.test(off)).toBe(true)
})

test('no flicker: redraws give the same parts, even mid-walk and when the walk ends', () => {
  const m = run([
    { k: 'request.start', t: T0, text: 'job' },
    { k: 'turn.start', t: T0 },
    { k: 'spawn', t: T0 + 10, agentId: 'a1', type: 'Explore', desc: 'scan', prompt: 'scan' },
    { k: 'agent.start', t: T0 + 20, agentId: 'a1', type: 'Explore' },
  ])
  let moves = {}
  const keys = (now: number) => {
    const input = officeInput(m, now, h)
    moves = advance(moves, place(input.people, now), now)
    return Object.fromEntries(officeParts(input, moves, now).map(p => [p.id, sceneKey(p.svg)]))
  }
  const k0 = keys(T0 + 100)
  expect(Object.keys(k0).sort().join(',')).toBe('activity,comms,floor,header,timeline')
  for (const dt of [600, 1100, 1600, 2600]) {
    const k = keys(T0 + dt)
    for (const id of Object.keys(k0)) expect(`${id}:${k[id] === k0[id]}`).toBe(`${id}:true`)
  }
})

/** Is the screen point inside the room's diamond? (u and v both within 0..1, with a little slack) */
function inside(room: Room, p: { x: number; y: number }): boolean {
  const o = iso(room, 0, 0)
  const r = iso(room, 1, 0)
  const hw = r.x - o.x
  const u = ((p.x - o.x) / hw + (p.y - o.y) / (hw / 2)) / 2
  const v = ((o.x - p.x) / hw + (p.y - o.y) / (hw / 2)) / 2
  return u > -0.02 && u < 1.02 && v > -0.02 && v < 1.02
}

test('isometric floor: every seat of every room is inside its own room, and the first desks are spread apart', () => {
  for (const room of ROOMS) {
    for (let k = 0; k < 24; k++) expect(`${room}${k}:${inside(room, slotPos(room, k))}`).toBe(`${room}${k}:true`)
  }
  // the first agents do not stand on top of each other
  const seats = [0, 1, 2, 3].map(k => slotPos('workspace', k))
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i]!
      const b = seats[j]!
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30)
    }
  }
  // all 20 desks are distinct
  expect(new Set(Array.from({ length: 20 }, (_, k) => `${slotPos('workspace', k).x},${slotPos('workspace', k).y}`)).size).toBe(20)
})

test('the floor shows every room with its sign, a desk with a monitor per seat, and lit tabs for occupied rooms', () => {
  const m = run([
    { k: 'request.start', t: T0, text: 'job' },
    { k: 'turn.start', t: T0 },
    { k: 'spawn', t: T0 + 10, agentId: 'a1', type: 'Explore', desc: 'scan', prompt: 'scan' },
    { k: 'agent.start', t: T0 + 20, agentId: 'a1', type: 'Explore' },
  ])
  const ps = officeParts(officeInput(m, T0 + 9000, emptyHistory()), {}, T0 + 9000)
  const floor = ps.find(p => p.id === 'floor')!
  const header = ps.find(p => p.id === 'header')!
  for (const label of ['WORKSPACE · 1', 'MEETING ROOM', 'MANAGER OFFICE · 1', 'LOUNGE', 'KITCHEN', 'ENTRANCE']) expect(floor.svg.includes(label)).toBe(true)
  // one lit screen for the one agent at a desk (the live colour is used on no other element of the floor's furniture)
  expect((floor.svg.match(/fill="#6da7ec" opacity="\.9"/g) ?? []).length).toBe(1)
  expect(header.svg.includes('1 active')).toBe(true)
  for (const t of ['Workspace', 'Meeting room', 'Manager office', 'Lounge', 'Kitchen']) expect(header.svg.includes(t)).toBe(true)
})

test('a crowded office stays readable and bounded: tags shrink to the name, no bubbles at the desks, no stray values', () => {
  const evs: Ev[] = [{ k: 'request.start', t: T0, text: 'job' }, { k: 'turn.start', t: T0 }]
  for (let i = 0; i < 40; i++) {
    evs.push({ k: 'spawn', t: T0 + 10 + i, agentId: `a${i}`, type: i === 0 ? '<b onload="x">&"' : 'Explore', desc: 'scan', prompt: 'scan' })
    evs.push({ k: 'agent.start', t: T0 + 20 + i, agentId: `a${i}`, type: 'Explore' })
  }
  const m = run(evs)
  const input = officeInput(m, T0 + 9000, emptyHistory())
  const ps = officeParts(input, advance({}, place(input.people, T0 + 9000), T0 + 9000), T0 + 9000)
  for (const p of ps) {
    expect(/NaN|undefined|\[object|Infinity/.test(p.svg)).toBe(false)
    expect(p.svg.includes('<b onload')).toBe(false)
  }
  const floor = ps.find(p => p.id === 'floor')!.svg
  expect(floor.length).toBeLessThan(400_000)
  expect(/skill: |Task from/.test(floor)).toBe(false)
})
