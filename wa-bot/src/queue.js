import fs from 'node:fs'
import { config } from './config.js'
import { logger } from './logger.js'
import * as store from './db.js'
import { wa } from './whatsapp.js'

/**
 * Persistent send queue. Every outgoing message (files to groups AND replies to users)
 * goes through here, so nothing is lost when the connection drops or the process restarts.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const randomDelay = () => {
  const min = config.sendDelayMin * 1000
  const max = Math.max(min, config.sendDelayMax * 1000)
  return min + Math.random() * (max - min)
}

let running = false

export function reply(toJid, text) {
  store.enqueue({ toJid, kind: 'text', caption: text, priority: 10 })
  kick()
}

export function startQueue() {
  if (running) return
  running = true
  loop()
}

export function stopQueue() {
  running = false
  kick()
}

let wake = null
export function kick() {
  wake?.()
}

async function loop() {
  while (running) {
    const job = wa.connected ? store.nextJob() : null
    if (!job) {
      await new Promise((r) => {
        wake = r
        setTimeout(r, 2000)
      })
      wake = null
      continue
    }
    await runJob(job)
    // replies go out fast; group posts are spaced out to look human and avoid bans
    await sleep(job.kind === 'text' && !job.batch_id ? 300 : randomDelay())
  }
}

function buildContent(job) {
  if (job.kind === 'text') return { text: job.caption }
  if (!job.path || !fs.existsSync(job.path)) throw new PermanentError('הקובץ לא נמצא בשרת')
  const media = { url: job.path }
  const caption = job.caption || undefined
  switch (job.kind) {
    case 'image':
      return { image: media, caption }
    case 'video':
      return { video: media, caption, mimetype: job.mimetype || 'video/mp4' }
    case 'audio':
      return { audio: media, mimetype: job.mimetype || 'audio/mpeg' }
    default:
      return {
        document: media,
        mimetype: job.mimetype || 'application/octet-stream',
        fileName: job.filename || 'file',
        caption,
      }
  }
}

class PermanentError extends Error {}

async function runJob(job) {
  try {
    if (job.batch_id && !store.canSendTo(job.phone, job.to_jid, config.ownerPhones.includes(job.phone))) {
      throw new PermanentError('אין הרשאה לקבוצה (או שהבוט לא בקבוצה)')
    }
    await wa.send(job.to_jid, buildContent(job))
    store.markSent(job.id)
    logger.info({ job: job.id, to: job.to_jid, kind: job.kind }, 'sent')
  } catch (err) {
    const msg = err?.message || String(err)
    if (err instanceof PermanentError || job.attempts + 1 >= config.maxAttempts) {
      store.markFailed(job.id, msg)
      logger.error({ job: job.id, err: msg }, 'job failed permanently')
    } else {
      const backoff = Math.min(15_000 * 2 ** job.attempts, 15 * 60_000)
      store.markRetry(job.id, msg, Date.now() + backoff)
      logger.warn({ job: job.id, err: msg, retryInMs: backoff }, 'send failed, will retry')
    }
  }
  if (job.batch_id) finishBatchIfDone(job.batch_id)
}

function finishBatchIfDone(batchId) {
  const jobs = store.batchJobs(batchId)
  if (jobs.some((j) => j.status === 'pending')) return

  const first = jobs[0]
  const user = store.getUser(first.phone)
  const sent = jobs.filter((j) => j.status === 'sent')
  const failed = jobs.filter((j) => j.status === 'failed')
  const groupName = (jid) => store.getGroup(jid)?.subject || jid
  const okGroups = [...new Set(sent.map((j) => groupName(j.to_jid)))]

  let text = ''
  if (sent.length) text += `✅ נשלחו ${sent.length} הודעות אל: ${okGroups.join(', ')}`
  if (failed.length) {
    const lines = failed.map((j) => `• ${groupName(j.to_jid)}: ${j.error}`)
    text += `${text ? '\n\n' : ''}❌ ${failed.length} לא נשלחו:\n${lines.join('\n')}`
  }
  const to = user?.chat_jid || `${first.phone}@s.whatsapp.net`
  reply(to, text)

  for (const p of new Set(jobs.map((j) => j.path).filter(Boolean))) removeFileIfUnused(p)
}

export function removeFileIfUnused(path) {
  if (path && !store.isPathInUse(path)) fs.rm(path, { force: true }, () => {})
}
