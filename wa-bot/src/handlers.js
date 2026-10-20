import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { downloadMediaMessage, getContentType, isJidGroup, normalizeMessageContent } from 'baileys'
import { config } from './config.js'
import { logger, waLogger } from './logger.js'
import * as store from './db.js'
import { wa, bareJid } from './whatsapp.js'
import { reply } from './queue.js'
import { autoSchedule, formatWhen } from './scheduler.js'
import { parseCommand, isCancel, extensionFor } from './parse.js'
import { personalCommands } from './commands/personal.js'
import { ownerPhones } from './settings.js'

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
}

export async function handleMessage(msg) {
  try {
    await route(msg)
  } catch (err) {
    logger.error({ err: err.stack || err.message, id: msg.key?.id }, 'message handler crashed')
  }
}

async function route(msg) {
  const jid = msg.key?.remoteJid
  if (!jid || !msg.message || isJidGroup(jid) || jid === 'status@broadcast') return

  const ctx = await identify(msg)
  if (!ctx) return

  const content = normalizeMessageContent(msg.message)
  const type = getContentType(content)
  const text = (content?.conversation || content?.extendedTextMessage?.text || '').trim()

  if (ctx.isOwner && text) {
    const cmd = parseCommand(text)
    if (cmd && (await runOwnerCommand(ctx, cmd))) return
  }

  let customer = store.getCustomer(ctx.phone)
  if (!customer && ctx.isOwner) customer = store.saveCustomer(ctx.phone, { name: 'אני' })
  if (!customer?.active) {
    const notify = store.noteStranger(ctx.phone, { name: msg.pushName, chatJid: ctx.jid, text: text || `[${type}]` })
    if (notify) {
      reply(ctx.jid, 'שלום! המספר שלך עדיין לא רשום לשירות. העברתי את הפנייה למנהל.')
      notifyOwners(`📩 ${msg.pushName || 'מישהו'} (${ctx.phone}) כתב/ה לבוט ואינו/ה רשום/ה. אפשר להוסיף אותו/ה באתר, בלשונית "לקוחות".`)
    }
    return
  }
  store.saveCustomer(ctx.phone, { chatJid: ctx.jid, name: customer.name ? undefined : msg.pushName || undefined })

  if (MEDIA_TYPES[type]) return receiveMedia(ctx, msg, content, type)
  if (!text) return

  if (['עזרה', '!עזרה', 'help'].includes(text.toLowerCase()) && !ctx.isOwner) return reply(ctx.jid, customerHelp())
  if (isCancel(text)) return cancelLatest(ctx)
  if (['סטטוס', 'מה מתוזמן', 'מתוזמן'].includes(text)) return reply(ctx.jid, customerStatus(ctx.phone))

  store.addItem(store.openSubmission(ctx.phone).id, { kind: 'text', caption: text })
}

// Works out who wrote and whether they're an owner. Returns null for messages we should ignore.
async function identify(msg) {
  const jid = msg.key.remoteJid
  const me = wa.me
  const myPhone = me?.id ? bareJid(me.id).split('@')[0] : null

  if (msg.key.fromMe) {
    // Only the "message yourself" chat counts, so the owner can control a bot running on their own number.
    const isSelfChat = bareJid(jid) === bareJid(me?.id) || (me?.lid && bareJid(jid) === bareJid(me.lid))
    if (!isSelfChat) return null
    await new Promise((r) => setTimeout(r, 1500)) // skip the bot's own replies, which also arrive here
    if (store.getSentMessage(msg.key.id)) return null
    return { jid, phone: myPhone, isOwner: true }
  }

  const phone = await wa.phoneOf(jid, msg.key.remoteJidAlt)
  if (!phone) {
    logger.warn({ jid }, 'could not resolve phone number for sender, ignoring message')
    return null
  }
  return { jid, phone, isOwner: ownerPhones().includes(phone) || phone === myPhone }
}

async function receiveMedia(ctx, msg, content, type) {
  const media = content[type]
  const size = Number(media.fileLength || 0)
  if (size > config.maxFileBytes) {
    return reply(ctx.jid, `⚠️ הקובץ גדול מדי (${Math.round(size / 1048576)}MB). המקסימום הוא ${config.maxFileBytes / 1048576}MB.`)
  }
  // open the submission first, so a caption-less picture followed by text stays one post
  const sub = store.openSubmission(ctx.phone)
  const file = newMediaPath(extensionFor(media.mimetype, media.fileName))
  try {
    const stream = await downloadMediaMessage(msg, 'stream', {}, {
      logger: waLogger,
      reuploadRequest: wa.sock.updateMediaMessage,
    })
    await pipeline(stream, fs.createWriteStream(file))
  } catch (err) {
    fs.rmSync(file, { force: true })
    logger.error({ err: err.message }, 'media download failed')
    return reply(ctx.jid, '⚠️ לא הצלחתי לקבל את הקובץ. נסו לשלוח אותו שוב.')
  }
  store.addItem(sub.id, {
    kind: MEDIA_TYPES[type],
    path: file,
    mimetype: media.mimetype,
    filename: media.fileName,
    caption: media.caption,
    size: fs.statSync(file).size,
  })
}

export function newMediaPath(ext) {
  fs.mkdirSync(config.mediaDir, { recursive: true })
  return path.join(config.mediaDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`)
}

/**
 * Called every few seconds: a submission nobody added to for `groupWindowMs` is complete.
 * It gets the customer's next free slot (if they have slots) and the customer is told when it will go out.
 */
export function finalizeSubmissions() {
  for (const sub of store.collectingSubmissions()) {
    if (Date.now() - sub.updated_at < config.groupWindowMs) continue
    if (!store.getItems(sub.id).length) {
      store.deleteSubmission(sub.id)
      continue
    }
    store.setSubmissionState(sub.id, 'ready')
    const placed = autoSchedule(sub.id)
    const customer = store.getCustomer(sub.phone)
    const to = customer?.chat_jid || `${sub.phone}@s.whatsapp.net`
    if (sub.source !== 'whatsapp') continue
    if (placed) {
      const names = placed.groups.map((g) => store.getGroup(g)?.subject || g).join(', ')
      reply(to, `✅ קיבלתי! יפורסם ${formatWhen(placed.sendAt)} ב: ${names}.\nלביטול: *ביטול*`)
    } else {
      reply(to, '✅ קיבלתי! המנהל יקבע את מועד הפרסום, ותקבל/י עדכון.')
    }
  }
}

function cancelLatest(ctx) {
  const open = store.listSubmissions({ phone: ctx.phone, limit: 20 })
    .find((s) => ['collecting', 'scheduled', 'unscheduled'].includes(s.status))
  if (!open) return reply(ctx.jid, 'אין כרגע פרסום שממתין.')
  if (open.status === 'collecting' || open.status === 'unscheduled') {
    for (const p of store.deleteSubmission(open.id)) fs.rm(p, { force: true }, () => {})
  } else {
    store.cancelPendingDeliveries(open.id)
    store.setSubmissionState(open.id, 'archived')
  }
  reply(ctx.jid, '🗑️ הפרסום האחרון שלך בוטל.')
}

function customerStatus(phone) {
  const upcoming = store.listSubmissions({ phone, limit: 50 }).filter((s) => s.status === 'scheduled')
  if (!upcoming.length) return 'אין לך כרגע פרסומים מתוזמנים.'
  const lines = upcoming.reverse().map((s) => {
    const next = s.deliveries.find((d) => d.status === 'pending')
    return `• ${formatWhen(next.send_at)}: ${summarize(s.items)}`
  })
  return `🗓️ *הפרסומים המתוזמנים שלך:*\n${lines.join('\n')}`
}

export function summarize(items) {
  const text = items.find((i) => i.caption)?.caption
  const files = items.filter((i) => i.kind !== 'text').length
  const t = text ? `"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"` : ''
  return [files ? `${files} קבצים` : '', t].filter(Boolean).join(' + ') || 'פרסום'
}

function notifyOwners(text) {
  for (const p of ownerPhones()) reply(store.getCustomer(p)?.chat_jid || `${p}@s.whatsapp.net`, text)
}

function customerHelp() {
  return [
    '🤖 *איך זה עובד*',
    'שולחים לכאן את מה שרוצים לפרסם: תמונה, סרטון, קובץ או טקסט. אפשר כמה דברים ביחד, והם יפורסמו כפוסט אחד.',
    'הבוט יחזיר את מועד הפרסום.',
    '',
    '*סטטוס*: מה מתוזמן לך',
    '*ביטול*: ביטול הפרסום האחרון',
  ].join('\n')
}

// ---------------- owner commands (the website is the main admin tool) ----------------

const ownerCommands = [
  {
    names: ['עזרה', 'help'],
    run: (ctx) => reply(ctx.jid, [
      '🛠️ *פקודות מנהל* (את רוב הניהול עושים באתר)',
      '!סטטוס - מצב החיבור והשליחות',
      '!קבוצות - רענון רשימת הקבוצות',
      ...personalCommands.map((c) => `!${c.names[0]} - ${c.description}`),
    ].join('\n')),
  },
  {
    names: ['סטטוס', 'status'],
    run: (ctx) => {
      const q = store.deliveryStats()
      const up = wa.openedAt ? Math.round((Date.now() - wa.openedAt) / 60000) : 0
      reply(ctx.jid, `🟢 מחובר ${up} דקות\n📬 מתוזמנים: ${q.pending || 0} | נשלחו: ${q.sent || 0} | נכשלו: ${q.failed || 0}`)
    },
  },
  {
    names: ['קבוצות', 'groups'],
    run: async (ctx) => {
      const list = await wa.refreshGroups()
      reply(ctx.jid, `👥 הבוט נמצא ב-${list.length} קבוצות.`)
    },
  },
  ...personalCommands,
]

async function runOwnerCommand(ctx, cmd) {
  const command = ownerCommands.find((c) => c.names.includes(cmd.cmd))
  if (!command) {
    reply(ctx.jid, `פקודה לא מוכרת: !${cmd.cmd}. לרשימה: !עזרה`)
    return true
  }
  try {
    await command.run(ctx, cmd, { reply, store, wa })
  } catch (err) {
    logger.error({ err: err.message, cmd: cmd.cmd }, 'command failed')
    reply(ctx.jid, `⚠️ הפקודה נכשלה: ${err.message}`)
  }
  return true
}
