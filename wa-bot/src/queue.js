import fs from 'node:fs'
import { config } from './config.js'
import { logger } from './logger.js'
import * as store from './db.js'
import { wa } from './whatsapp.js'
import { videoPreview, imagePreview } from './media.js'

/**
 * Sends everything that is due, from the database:
 *  - replies to customers/owner (right away)
 *  - scheduled deliveries of posts to groups (at their time, spaced out)
 * Because the state lives in SQLite, nothing is lost on a disconnect or restart.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const randomDelay = () => {
  const min = config.sendDelayMin * 1000
  const max = Math.max(min, config.sendDelayMax * 1000)
  return min + Math.random() * (max - min)
}

class PermanentError extends Error {}

let running = false
let wake = null

export function reply(toJid, text) {
  store.enqueueReply(toJid, text)
  kick()
}

export function kick() {
  wake?.()
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

async function loop() {
  while (running) {
    let worked = false
    if (wa.connected) {
      const r = store.nextReply()
      if (r) {
        await sendReply(r)
        worked = true
      } else {
        const d = store.nextDueDelivery()
        if (d) {
          await sendDelivery(d)
          await sleep(randomDelay()) // look human between group posts
          worked = true
        }
      }
    }
    if (!worked) {
      await new Promise((resolve) => {
        wake = resolve
        setTimeout(resolve, 2000)
      })
      wake = null
    }
  }
}

async function sendReply(r) {
  try {
    await wa.send(r.to_jid, { text: r.text })
    store.deleteReply(r.id)
  } catch (err) {
    if (r.attempts + 1 >= config.maxAttempts) {
      logger.error({ to: r.to_jid, err: err.message }, 'giving up on reply')
      store.deleteReply(r.id)
    } else {
      store.retryReply(r.id, Date.now() + 10_000 * 2 ** r.attempts)
    }
  }
}

export async function contentFor(item) {
  if (item.kind === 'text') return { text: item.caption || '' }
  if (!item.path || !fs.existsSync(item.path)) throw new PermanentError('הקובץ לא נמצא בשרת')
  const media = { url: item.path }
  const caption = item.caption || undefined
  switch (item.kind) {
    case 'image':
      return { image: media, caption, ...(await previewFor(item, imagePreview)) }
    case 'video':
      return { video: media, caption, mimetype: item.mimetype || 'video/mp4', ...(await previewFor(item, videoPreview)) }
    case 'audio':
      return { audio: media, mimetype: item.mimetype || 'audio/mpeg' }
    default:
      return { document: media, mimetype: item.mimetype || 'application/octet-stream', fileName: item.filename || 'file', caption }
  }
}

// Prefer the thumbnail and size that came with the customer's message (made by WhatsApp itself);
// fall back to generating them with ffmpeg (uploads from the website)
async function previewFor(item, generate) {
  const stored = {
    jpegThumbnail: item.thumb || undefined,
    width: item.width || undefined,
    height: item.height || undefined,
    seconds: item.seconds || undefined,
  }
  const missing = !stored.jpegThumbnail || !stored.width || (item.kind === 'video' && !stored.seconds)
  const made = missing ? await generate(item.path) : {}
  const out = { ...made }
  for (const [k, v] of Object.entries(stored)) if (v !== undefined) out[k] = v
  if (item.kind !== 'video') delete out.seconds
  return out
}

async function sendDelivery(d) {
  try {
    const group = store.getGroup(d.group_jid)
    if (!group?.active) throw new PermanentError('הבוט לא חבר בקבוצה')
    const items = store.getItems(d.submission_id)
    if (!items.length) throw new PermanentError('אין תוכן לשליחה')
    for (let i = d.items_sent; i < items.length; i++) {
      await wa.send(d.group_jid, await contentFor(items[i]))
      store.setItemsSent(d.id, i + 1) // so a retry doesn't post the same item twice
      if (i < items.length - 1) await sleep(1000 + Math.random() * 1000)
    }
    store.markDeliverySent(d.id)
    logger.info({ delivery: d.id, group: group.subject }, 'delivered')
    tellCustomerIfPosted(d.submission_id)
  } catch (err) {
    const msg = err?.message || String(err)
    if (err instanceof PermanentError || d.attempts + 1 >= config.maxAttempts) {
      store.markDeliveryFailed(d.id, msg)
      logger.error({ delivery: d.id, err: msg }, 'delivery failed')
    } else {
      const backoff = Math.min(15_000 * 2 ** d.attempts, 15 * 60_000)
      store.markDeliveryRetry(d.id, msg, Date.now() + backoff)
      logger.warn({ delivery: d.id, err: msg, retryInMs: backoff }, 'delivery failed, will retry')
    }
  }
}

function tellCustomerIfPosted(submissionId) {
  const view = store.submissionView(store.getSubmission(submissionId))
  if (view.status !== 'sent' || view.source !== 'whatsapp') return
  const customer = store.getCustomer(view.phone)
  if (!customer) return
  const names = [...new Set(view.deliveries.filter((x) => x.status === 'sent').map((x) => x.group_name || x.group_jid))]
  reply(customer.chat_jid || `${view.phone}@s.whatsapp.net`, `📢 הפרסום שלך יצא ל: ${names.join(', ')}`)
}

export function removeFileIfUnused(path) {
  if (path && !store.isPathInUse(path)) fs.rm(path, { force: true }, () => {})
}
