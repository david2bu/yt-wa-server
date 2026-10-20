import { config } from './config.js'
import * as store from './db.js'

/**
 * Times are wall-clock in the server's time zone (TZ, Asia/Jerusalem in Docker),
 * so "Sunday 10:00" stays 10:00 across daylight-saving changes.
 */

export const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

// Occurrence of a weekly slot in the week that contains `weekStart` (a Sunday at 00:00)
function occurrence(slot, weekStart) {
  const [h, m] = slot.time.split(':').map(Number)
  return new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + slot.weekday, h, m).getTime()
}

function sundayOf(ts) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())
}

/**
 * Earliest free occurrence among `slots`, no earlier than `fromTs`.
 * `taken` is a Set of "slotId@timestamp" already holding a post.
 * Returns { slot, sendAt } or null.
 */
export function nextFreeSlot(slots, taken, fromTs, maxWeeks = 104) {
  const usable = slots.filter((s) => s.active && s.groups.length)
  if (!usable.length) return null
  const start = sundayOf(fromTs)
  for (let w = 0; w < maxWeeks; w++) {
    const weekStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * w)
    const candidates = usable
      .map((slot) => ({ slot, sendAt: occurrence(slot, weekStart) }))
      .filter((c) => c.sendAt >= fromTs && !taken.has(`${c.slot.id}@${c.sendAt}`))
      .sort((a, b) => a.sendAt - b.sendAt || a.slot.id - b.slot.id)
    if (candidates.length) return candidates[0]
  }
  return null
}

/** Puts a submission into the customer's next free slot. Returns { sendAt, groups } or null. */
export function autoSchedule(submissionId) {
  const sub = store.getSubmission(submissionId)
  if (!sub) return null
  const activeGroups = new Set(store.listGroups().map((g) => g.jid))
  const slots = store.listSlots(sub.phone).map((s) => ({ ...s, groups: s.groups.filter((g) => activeGroups.has(g)) }))
  const from = Date.now() + config.leadMinutes * 60_000
  const pick = nextFreeSlot(slots, store.takenSlotTimes(from), from)
  if (!pick) return null
  store.tx(() => {
    for (const g of pick.slot.groups) store.addDelivery(submissionId, g, pick.sendAt, pick.slot.id)
  })
  return { sendAt: pick.sendAt, groups: pick.slot.groups }
}

export function formatWhen(ts) {
  const d = new Date(ts)
  const date = `${d.getDate()}/${d.getMonth() + 1}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `יום ${WEEKDAYS[d.getDay()]} ${date} בשעה ${time}`
}
