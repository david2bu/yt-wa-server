import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TZ = 'Asia/Jerusalem'
const { nextFreeSlot } = await import('../src/scheduler.js')

// Monday 2026-10-19 12:00 Israel time
const MON_NOON = new Date(2026, 9, 19, 12, 0).getTime()
const slots = [
  { id: 1, weekday: 0, time: '10:00', active: 1, groups: ['g'] }, // Sunday
  { id: 2, weekday: 3, time: '18:30', active: 1, groups: ['g'] }, // Wednesday
]
const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).getTime()

test('picks the nearest upcoming slot', () => {
  const r = nextFreeSlot(slots, new Set(), MON_NOON)
  assert.equal(r.slot.id, 2)
  assert.equal(r.sendAt, at(2026, 10, 21, 18, 30))
})

test('skips taken occurrences and rolls into next week', () => {
  const taken = new Set([`2@${at(2026, 10, 21, 18, 30)}`, `1@${at(2026, 10, 25, 10, 0)}`])
  const r = nextFreeSlot(slots, taken, MON_NOON)
  assert.equal(r.sendAt, at(2026, 10, 28, 18, 30))
})

test('same day, earlier time already passed', () => {
  const r = nextFreeSlot([{ id: 9, weekday: 1, time: '09:00', active: 1, groups: ['g'] }], new Set(), MON_NOON)
  assert.equal(r.sendAt, at(2026, 10, 26, 9, 0))
})

test('keeps wall-clock time across DST end (Israel: 25 Oct 2026)', () => {
  const r = nextFreeSlot([{ id: 5, weekday: 0, time: '10:00', active: 1, groups: ['g'] }], new Set(), MON_NOON)
  const d = new Date(r.sendAt)
  assert.equal(d.getHours(), 10)
  assert.equal(d.getDate(), 25)
})

test('no usable slots', () => {
  assert.equal(nextFreeSlot([], new Set(), MON_NOON), null)
  assert.equal(nextFreeSlot([{ id: 1, weekday: 0, time: '10:00', active: 0, groups: ['g'] }], new Set(), MON_NOON), null)
  assert.equal(nextFreeSlot([{ id: 1, weekday: 0, time: '10:00', active: 1, groups: [] }], new Set(), MON_NOON), null)
})
