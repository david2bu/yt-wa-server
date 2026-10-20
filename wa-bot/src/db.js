import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(config.dbFile)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  phone      TEXT PRIMARY KEY,
  name       TEXT,
  chat_jid   TEXT,              -- last JID the user wrote from (may be @lid)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS permissions (
  phone     TEXT NOT NULL,
  group_jid TEXT NOT NULL,
  PRIMARY KEY (phone, group_jid)
);
CREATE TABLE IF NOT EXISTS groups (
  jid        TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,   -- 0 = bot is no longer a member
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  kind       TEXT NOT NULL,     -- image | video | audio | document | text
  path       TEXT,
  mimetype   TEXT,
  filename   TEXT,
  caption    TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   TEXT,
  phone      TEXT,              -- who asked for it (for the report back)
  to_jid     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  path       TEXT,
  mimetype   TEXT,
  filename   TEXT,
  caption    TEXT,
  priority   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  error      TEXT,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (status, next_at);
CREATE TABLE IF NOT EXISTS sent_messages (
  id         TEXT PRIMARY KEY,
  content    BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS strangers (
  phone      TEXT PRIMARY KEY,
  notified_at INTEGER NOT NULL
);
`)

const now = () => Date.now()

// ---------- users & permissions ----------

export function upsertUser(phone, { name, chatJid } = {}) {
  db.prepare(`
    INSERT INTO users (phone, name, chat_jid, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(excluded.name, users.name),
      chat_jid = COALESCE(excluded.chat_jid, users.chat_jid)
  `).run(phone, name ?? null, chatJid ?? null, now())
}

export const getUser = (phone) => db.prepare('SELECT * FROM users WHERE phone = ?').get(phone)

export function listUsers() {
  return db.prepare(`
    SELECT u.phone, u.name, GROUP_CONCAT(g.subject, ', ') AS groups
    FROM users u
    LEFT JOIN permissions p ON p.phone = u.phone
    LEFT JOIN groups g ON g.jid = p.group_jid
    GROUP BY u.phone ORDER BY u.name, u.phone
  `).all()
}

export function grant(phone, groupJids) {
  upsertUser(phone)
  const stmt = db.prepare('INSERT OR IGNORE INTO permissions (phone, group_jid) VALUES (?, ?)')
  for (const jid of groupJids) stmt.run(phone, jid)
}

export function revoke(phone, groupJids) {
  if (!groupJids) {
    db.prepare('DELETE FROM permissions WHERE phone = ?').run(phone)
    db.prepare('DELETE FROM users WHERE phone = ?').run(phone)
    return
  }
  const stmt = db.prepare('DELETE FROM permissions WHERE phone = ? AND group_jid = ?')
  for (const jid of groupJids) stmt.run(phone, jid)
}

export function isApproved(phone) {
  return !!db.prepare('SELECT 1 FROM permissions WHERE phone = ? LIMIT 1').get(phone)
}

export function groupsForUser(phone, isOwner) {
  if (isOwner) return listGroups()
  return db.prepare(`
    SELECT g.* FROM groups g JOIN permissions p ON p.group_jid = g.jid
    WHERE p.phone = ? AND g.active = 1 ORDER BY g.subject COLLATE NOCASE
  `).all(phone)
}

export function canSendTo(phone, groupJid, isOwner) {
  const g = db.prepare('SELECT active FROM groups WHERE jid = ?').get(groupJid)
  if (!g || !g.active) return false
  if (isOwner) return true
  return !!db.prepare('SELECT 1 FROM permissions WHERE phone = ? AND group_jid = ?').get(phone, groupJid)
}

// ---------- groups ----------

export function syncGroups(groups) {
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE groups SET active = 0').run()
    const stmt = db.prepare(`
      INSERT INTO groups (jid, subject, active, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(jid) DO UPDATE SET subject = excluded.subject, active = 1, updated_at = excluded.updated_at
    `)
    for (const g of groups) stmt.run(g.id, g.subject || g.id, now())
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function upsertGroup(jid, subject, active = true) {
  db.prepare(`
    INSERT INTO groups (jid, subject, active, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET subject = COALESCE(excluded.subject, groups.subject),
      active = excluded.active, updated_at = excluded.updated_at
  `).run(jid, subject ?? jid, active ? 1 : 0, now())
}

export function setGroupActive(jid, active) {
  db.prepare('UPDATE groups SET active = ?, updated_at = ? WHERE jid = ?').run(active ? 1 : 0, now(), jid)
}

// Numbered list used by the admin commands; numbering is by name so it stays stable
export function listGroups() {
  return db.prepare('SELECT * FROM groups WHERE active = 1 ORDER BY subject COLLATE NOCASE').all()
}

export const getGroup = (jid) => db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid)

// ---------- drafts (files waiting for the user to pick groups) ----------

export function addDraft(phone, d) {
  db.prepare(`
    INSERT INTO drafts (phone, kind, path, mimetype, filename, caption, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(phone, d.kind, d.path ?? null, d.mimetype ?? null, d.filename ?? null, d.caption ?? null, now())
}

export const getDrafts = (phone) => db.prepare('SELECT * FROM drafts WHERE phone = ? ORDER BY id').all(phone)

export function clearDrafts(phone) {
  db.prepare('DELETE FROM drafts WHERE phone = ?').run(phone)
}

export function expiredDrafts(ttlMs) {
  return db.prepare('SELECT * FROM drafts WHERE created_at < ?').all(now() - ttlMs)
}

export function deleteDraft(id) {
  db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
}

// ---------- jobs (persistent send queue) ----------

export function enqueue(job) {
  return db.prepare(`
    INSERT INTO jobs (batch_id, phone, to_jid, kind, path, mimetype, filename, caption, priority, next_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.batchId ?? null, job.phone ?? null, job.toJid, job.kind, job.path ?? null,
    job.mimetype ?? null, job.filename ?? null, job.caption ?? null, job.priority ?? 0, now(), now(),
  ).lastInsertRowid
}

export function nextJob() {
  return db.prepare(`
    SELECT * FROM jobs WHERE status = 'pending' AND next_at <= ?
    ORDER BY priority DESC, id LIMIT 1
  `).get(now())
}

export function markSent(id) {
  db.prepare("UPDATE jobs SET status = 'sent', done_at = ?, error = NULL WHERE id = ?").run(now(), id)
}

export function markRetry(id, error, nextAt) {
  db.prepare('UPDATE jobs SET attempts = attempts + 1, error = ?, next_at = ? WHERE id = ?').run(error, nextAt, id)
}

export function markFailed(id, error) {
  db.prepare("UPDATE jobs SET status = 'failed', attempts = attempts + 1, error = ?, done_at = ? WHERE id = ?")
    .run(error, now(), id)
}

export function batchJobs(batchId) {
  return db.prepare('SELECT * FROM jobs WHERE batch_id = ?').all(batchId)
}

export function retryFailed() {
  return db.prepare(`
    UPDATE jobs SET status = 'pending', attempts = 0, next_at = ?, error = NULL
    WHERE status = 'failed' AND kind != 'text'
  `).run(now()).changes
}

export function queueStats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}

export function isPathInUse(path) {
  return !!(
    db.prepare("SELECT 1 FROM jobs WHERE path = ? AND status IN ('pending', 'failed') LIMIT 1").get(path) ||
    db.prepare('SELECT 1 FROM drafts WHERE path = ? LIMIT 1').get(path)
  )
}

export function pruneOldJobs(olderThanMs) {
  db.prepare("DELETE FROM jobs WHERE status != 'pending' AND done_at < ?").run(now() - olderThanMs)
}

// ---------- sent messages (needed so WhatsApp can re-request a message that failed to decrypt) ----------

export function saveSentMessage(id, content) {
  db.prepare('INSERT OR REPLACE INTO sent_messages (id, content, created_at) VALUES (?, ?, ?)').run(id, content, now())
}

export function getSentMessage(id) {
  return db.prepare('SELECT content FROM sent_messages WHERE id = ?').get(id)?.content
}

export function pruneSentMessages(olderThanMs) {
  db.prepare('DELETE FROM sent_messages WHERE created_at < ?').run(now() - olderThanMs)
}

// ---------- strangers (unapproved people who wrote to the bot) ----------

export function shouldNotifyStranger(phone) {
  const row = db.prepare('SELECT notified_at FROM strangers WHERE phone = ?').get(phone)
  if (row && now() - row.notified_at < 24 * 60 * 60 * 1000) return false
  db.prepare('INSERT OR REPLACE INTO strangers (phone, notified_at) VALUES (?, ?)').run(phone, now())
  return true
}
