import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(config.dbFile)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  phone      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  chat_jid   TEXT,                       -- last JID the customer wrote from (may be @lid)
  active     INTEGER NOT NULL DEFAULT 1,
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  jid        TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1, -- 0 = bot is no longer a member
  updated_at INTEGER NOT NULL
);
-- recurring weekly time slots per customer, e.g. Sunday 10:00 -> groups A, B
CREATE TABLE IF NOT EXISTS slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL REFERENCES customers(phone) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL,           -- 0 = Sunday ... 6 = Saturday
  time       TEXT NOT NULL,              -- "HH:MM", server local time
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slot_groups (
  slot_id   INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  group_jid TEXT NOT NULL,
  PRIMARY KEY (slot_id, group_jid)
);
-- one post = one or more items (e.g. a picture and a text sent together)
CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'whatsapp', -- whatsapp | web
  state      TEXT NOT NULL DEFAULT 'collecting', -- collecting | ready | archived
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,           -- image | video | audio | document | text
  path          TEXT,
  mimetype      TEXT,
  filename      TEXT,
  caption       TEXT,
  size          INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  group_jid     TEXT NOT NULL,
  send_at       INTEGER NOT NULL,
  slot_id       INTEGER,                 -- set when placed in a recurring slot
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | cancelled
  items_sent    INTEGER NOT NULL DEFAULT 0,      -- resume point if it broke midway
  attempts      INTEGER NOT NULL DEFAULT 0,
  retry_at      INTEGER,
  error         TEXT,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, send_at);
-- texts the bot sends to customers / owner (confirmations etc.)
CREATE TABLE IF NOT EXISTS replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_jid     TEXT NOT NULL,
  text       TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sent_messages (
  id         TEXT PRIMARY KEY,
  content    BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
-- people who wrote to the bot but aren't customers
CREATE TABLE IF NOT EXISTS strangers (
  phone      TEXT PRIMARY KEY,
  name       TEXT,
  chat_jid   TEXT,
  last_text  TEXT,
  count      INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER,
  last_at    INTEGER NOT NULL
);
`)

const now = () => Date.now()
const one = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

export function tx(fn) {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ---------- customers ----------

export const getCustomer = (phone) => one('SELECT * FROM customers WHERE phone = ?', phone)

export function saveCustomer(phone, { name, active, notes, chatJid } = {}) {
  run(`
    INSERT INTO customers (phone, name, active, notes, chat_jid, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(?, customers.name),
      active = COALESCE(?, customers.active),
      notes = COALESCE(?, customers.notes),
      chat_jid = COALESCE(?, customers.chat_jid)
  `, phone, name ?? '', active === undefined ? 1 : +active, notes ?? '', chatJid ?? null, now(),
  name ?? null, active === undefined ? null : +active, notes ?? null, chatJid ?? null)
  run('DELETE FROM strangers WHERE phone = ?', phone)
  return getCustomer(phone)
}

export const deleteCustomer = (phone) => run('DELETE FROM customers WHERE phone = ?', phone)

export function listCustomers() {
  return all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM submissions s WHERE s.phone = c.phone) AS submissions,
      (SELECT MAX(created_at) FROM submissions s WHERE s.phone = c.phone) AS last_submission
    FROM customers c ORDER BY c.name COLLATE NOCASE, c.phone
  `).map((c) => ({ ...c, slots: listSlots(c.phone) }))
}

// ---------- groups ----------

export function syncGroups(groups) {
  tx(() => {
    run('UPDATE groups SET active = 0')
    const stmt = db.prepare(`
      INSERT INTO groups (jid, subject, active, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(jid) DO UPDATE SET subject = excluded.subject, active = 1, updated_at = excluded.updated_at
    `)
    for (const g of groups) stmt.run(g.id, g.subject || g.id, now())
  })
}

export function upsertGroup(jid, subject, active = true) {
  run(`
    INSERT INTO groups (jid, subject, active, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET subject = COALESCE(excluded.subject, groups.subject),
      active = excluded.active, updated_at = excluded.updated_at
  `, jid, subject ?? jid, active ? 1 : 0, now())
}

export const setGroupActive = (jid, active) =>
  run('UPDATE groups SET active = ?, updated_at = ? WHERE jid = ?', active ? 1 : 0, now(), jid)
export const listGroups = () => all('SELECT * FROM groups WHERE active = 1 ORDER BY subject COLLATE NOCASE')
export const getGroup = (jid) => one('SELECT * FROM groups WHERE jid = ?', jid)

// ---------- slots ----------

export function listSlots(phone) {
  const slots = phone
    ? all('SELECT * FROM slots WHERE phone = ? ORDER BY weekday, time', phone)
    : all('SELECT * FROM slots ORDER BY weekday, time')
  const groups = db.prepare('SELECT group_jid FROM slot_groups WHERE slot_id = ?')
  return slots.map((s) => ({ ...s, groups: groups.all(s.id).map((g) => g.group_jid) }))
}

// replaces all of a customer's slots: [{ weekday, time, groups: [jid], active }]
export function setSlots(phone, slots) {
  tx(() => {
    run('DELETE FROM slots WHERE phone = ?', phone)
    for (const s of slots) {
      const id = run('INSERT INTO slots (phone, weekday, time, active, created_at) VALUES (?, ?, ?, ?, ?)',
        phone, s.weekday, s.time, s.active === false ? 0 : 1, now()).lastInsertRowid
      for (const g of new Set(s.groups)) run('INSERT INTO slot_groups (slot_id, group_jid) VALUES (?, ?)', id, g)
    }
  })
  // pending deliveries pointing at removed slots keep their time but are no longer tied to a slot
  run('UPDATE deliveries SET slot_id = NULL WHERE slot_id IS NOT NULL AND slot_id NOT IN (SELECT id FROM slots)')
}

// slot occurrences already holding a post: Set of "slotId@timestamp"
export function takenSlotTimes(fromTs) {
  return new Set(all(`
    SELECT DISTINCT slot_id, send_at FROM deliveries
    WHERE slot_id IS NOT NULL AND status != 'cancelled' AND send_at >= ?
  `, fromTs).map((r) => `${r.slot_id}@${r.send_at}`))
}

// ---------- submissions & items ----------

export function openSubmission(phone, source = 'whatsapp') {
  const existing = one("SELECT * FROM submissions WHERE phone = ? AND state = 'collecting' ORDER BY id DESC LIMIT 1", phone)
  return existing || createSubmission(phone, source)
}

export function createSubmission(phone, source, state = 'collecting') {
  const id = run('INSERT INTO submissions (phone, source, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    phone, source, state, now(), now()).lastInsertRowid
  return getSubmission(id)
}

export function addItem(submissionId, it) {
  run(`INSERT INTO items (submission_id, kind, path, mimetype, filename, caption, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  submissionId, it.kind, it.path ?? null, it.mimetype ?? null, it.filename ?? null, it.caption ?? null, it.size ?? null, now())
  run('UPDATE submissions SET updated_at = ? WHERE id = ?', now(), submissionId)
}

export const setSubmissionState = (id, state) =>
  run('UPDATE submissions SET state = ?, updated_at = ? WHERE id = ?', state, now(), id)
export const getSubmission = (id) => one('SELECT * FROM submissions WHERE id = ?', id)
export const getItems = (submissionId) => all('SELECT * FROM items WHERE submission_id = ? ORDER BY id', submissionId)
export const getItem = (id) => one('SELECT * FROM items WHERE id = ?', id)
export const collectingSubmissions = () => all("SELECT * FROM submissions WHERE state = 'collecting'")

export function deleteSubmission(id) {
  const paths = getItems(id).map((i) => i.path).filter(Boolean)
  run('DELETE FROM submissions WHERE id = ?', id)
  return paths
}

// Full view used by the website: submission + customer + items + deliveries + overall status
export function submissionView(s) {
  const deliveries = all(`
    SELECT d.*, g.subject AS group_name FROM deliveries d LEFT JOIN groups g ON g.jid = d.group_jid
    WHERE d.submission_id = ? ORDER BY d.send_at, g.subject`, s.id)
  const live = deliveries.filter((d) => d.status !== 'cancelled')
  let status = 'unscheduled'
  if (s.state === 'collecting') status = 'collecting'
  else if (live.some((d) => d.status === 'failed')) status = 'failed'
  else if (live.some((d) => d.status === 'pending')) status = 'scheduled'
  else if (live.length && live.every((d) => d.status === 'sent')) status = 'sent'
  const c = getCustomer(s.phone)
  return { ...s, customer_name: c?.name || '', items: getItems(s.id), deliveries, status }
}

export function listSubmissions({ phone, status, limit = 200 } = {}) {
  const rows = phone
    ? all("SELECT * FROM submissions WHERE phone = ? AND state != 'archived' ORDER BY id DESC LIMIT ?", phone, limit)
    : all("SELECT * FROM submissions WHERE state != 'archived' ORDER BY id DESC LIMIT ?", limit)
  const views = rows.map(submissionView)
  return status ? views.filter((v) => v.status === status) : views
}

// ---------- deliveries ----------

export function addDelivery(submissionId, groupJid, sendAt, slotId = null) {
  return run(`INSERT INTO deliveries (submission_id, group_jid, send_at, slot_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    submissionId, groupJid, sendAt, slotId, now()).lastInsertRowid
}

export const getDelivery = (id) => one('SELECT * FROM deliveries WHERE id = ?', id)

export function nextDueDelivery() {
  return one(`
    SELECT * FROM deliveries WHERE status = 'pending' AND send_at <= ? AND (retry_at IS NULL OR retry_at <= ?)
    ORDER BY send_at, id LIMIT 1`, now(), now())
}

export const setItemsSent = (id, n) => run('UPDATE deliveries SET items_sent = ? WHERE id = ?', n, id)
export const markDeliverySent = (id) =>
  run("UPDATE deliveries SET status = 'sent', sent_at = ?, error = NULL, retry_at = NULL WHERE id = ?", now(), id)
export const markDeliveryRetry = (id, error, retryAt) =>
  run('UPDATE deliveries SET attempts = attempts + 1, error = ?, retry_at = ? WHERE id = ?', error, retryAt, id)
export const markDeliveryFailed = (id, error) =>
  run("UPDATE deliveries SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?", error, id)

export function updateDelivery(id, { sendAt, status }) {
  if (sendAt !== undefined) run('UPDATE deliveries SET send_at = ?, slot_id = NULL WHERE id = ?', sendAt, id)
  if (status === 'pending') run("UPDATE deliveries SET status = 'pending', attempts = 0, retry_at = NULL, error = NULL WHERE id = ?", id)
  else if (status) run('UPDATE deliveries SET status = ? WHERE id = ?', status, id)
}

export const cancelPendingDeliveries = (submissionId) =>
  run("UPDATE deliveries SET status = 'cancelled' WHERE submission_id = ? AND status IN ('pending', 'failed')", submissionId)

export function upcomingDeliveries(fromTs, toTs) {
  return all(`
    SELECT d.*, g.subject AS group_name, s.phone, c.name AS customer_name
    FROM deliveries d
    JOIN submissions s ON s.id = d.submission_id
    LEFT JOIN groups g ON g.jid = d.group_jid
    LEFT JOIN customers c ON c.phone = s.phone
    WHERE d.status != 'cancelled' AND d.send_at BETWEEN ? AND ?
    ORDER BY d.send_at, g.subject`, fromTs, toTs)
}

export function deliveryStats() {
  return Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status').map((r) => [r.status, r.n]))
}

// ---------- replies (texts to customers / owner) ----------

export function enqueueReply(toJid, text) {
  run('INSERT INTO replies (to_jid, text, next_at, created_at) VALUES (?, ?, ?, ?)', toJid, text, now(), now())
}
export const nextReply = () => one('SELECT * FROM replies WHERE next_at <= ? ORDER BY id LIMIT 1', now())
export const deleteReply = (id) => run('DELETE FROM replies WHERE id = ?', id)
export const retryReply = (id, nextAt) => run('UPDATE replies SET attempts = attempts + 1, next_at = ? WHERE id = ?', nextAt, id)

// ---------- sent messages (WhatsApp may re-request one that failed to decrypt) ----------

export const saveSentMessage = (id, content) =>
  run('INSERT OR REPLACE INTO sent_messages (id, content, created_at) VALUES (?, ?, ?)', id, content, now())
export const getSentMessage = (id) => one('SELECT content FROM sent_messages WHERE id = ?', id)?.content
export const pruneSentMessages = (olderThanMs) => run('DELETE FROM sent_messages WHERE created_at < ?', now() - olderThanMs)

// ---------- strangers ----------

// records the contact; returns true if the owner should be notified (at most once a day per person)
export function noteStranger(phone, { name, chatJid, text }) {
  const row = one('SELECT * FROM strangers WHERE phone = ?', phone)
  const notify = !row?.notified_at || now() - row.notified_at > 24 * 60 * 60 * 1000
  run(`
    INSERT INTO strangers (phone, name, chat_jid, last_text, count, notified_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, strangers.name), chat_jid = excluded.chat_jid,
      last_text = COALESCE(excluded.last_text, strangers.last_text), count = strangers.count + 1,
      notified_at = CASE WHEN ? THEN excluded.notified_at ELSE strangers.notified_at END, last_at = excluded.last_at
  `, phone, name ?? null, chatJid ?? null, text ?? null, notify ? now() : row?.notified_at ?? null, now(), notify ? 1 : 0)
  return notify
}
export const listStrangers = () => all('SELECT * FROM strangers ORDER BY last_at DESC LIMIT 100')
export const deleteStranger = (phone) => run('DELETE FROM strangers WHERE phone = ?', phone)

// ---------- media housekeeping ----------

export const isPathInUse = (path) => !!one('SELECT 1 FROM items WHERE path = ? LIMIT 1', path)

// finished posts older than the cutoff (nothing pending) - their media can be cleaned up
export function finishedSubmissionsBefore(ts) {
  return all(`
    SELECT s.id FROM submissions s
    WHERE s.state != 'collecting' AND s.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.submission_id = s.id AND d.status = 'pending')
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.submission_id = s.id)`, ts).map((r) => r.id)
}
