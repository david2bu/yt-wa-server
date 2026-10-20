import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { downloadMediaMessage, getContentType, isJidGroup, normalizeMessageContent } from 'baileys'
import { config, normalizePhone } from './config.js'
import { logger, waLogger } from './logger.js'
import * as store from './db.js'
import { wa, bareJid } from './whatsapp.js'
import { reply, kick, removeFileIfUnused } from './queue.js'
import { parseSelection, parseCommand, looksLikeSelection, isCancel, extensionFor } from './parse.js'
import { personalCommands } from './commands/personal.js'

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
}

const menuTimers = new Map()

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

  // ---- owner commands ----
  if (ctx.isOwner && text) {
    const cmd = parseCommand(text)
    if (cmd && (await runOwnerCommand(ctx, cmd))) return
  }

  // ---- gatekeeping ----
  if (!ctx.isOwner && !store.isApproved(ctx.phone)) {
    if (store.shouldNotifyStranger(ctx.phone)) {
      reply(ctx.jid, 'שלום! אינך מורשה עדיין לשלוח דרך הבוט. בקשתך הועברה למנהל.')
      notifyOwners(
        `📩 ${msg.pushName || 'משתמש לא מוכר'} (${ctx.phone}) כתב/ה לבוט ואינו/ה מורשה/ית.\n` +
          `לאישור: !אשר ${ctx.phone} <מספרי קבוצות>   (רשימה: !קבוצות)`,
      )
    }
    return
  }
  store.upsertUser(ctx.phone, { name: msg.pushName || null, chatJid: ctx.jid })

  // ---- incoming file ----
  if (MEDIA_TYPES[type]) {
    await receiveMedia(ctx, msg, content, type)
    return
  }
  if (!text) return

  // ---- user commands ----
  const cmd = parseCommand(text)
  if (cmd && ['עזרה', 'help'].includes(cmd.cmd)) return reply(ctx.jid, userHelp())
  if (text === 'עזרה') return reply(ctx.jid, userHelp())

  const drafts = store.getDrafts(ctx.phone)
  if (isCancel(text)) {
    discardDrafts(ctx.phone)
    return reply(ctx.jid, drafts.length ? '🗑️ בוטל. הקבצים לא יישלחו.' : 'אין כרגע שום דבר ממתין.')
  }

  if (drafts.length && looksLikeSelection(text)) return chooseGroups(ctx, text, drafts)

  if (looksLikeSelection(text)) {
    return reply(ctx.jid, 'אין קבצים שממתינים לשליחה. שלחו קובץ (או הודעת טקסט) ואז בחרו קבוצה.')
  }

  // plain text becomes a message to post, just like a file
  store.addDraft(ctx.phone, { kind: 'text', caption: text })
  scheduleMenu(ctx)
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
    // Skip the bot's own replies (they also show up here)
    await new Promise((r) => setTimeout(r, 1500))
    if (store.getSentMessage(msg.key.id)) return null
    return { jid, phone: myPhone, isOwner: true }
  }

  const phone = await wa.phoneOf(jid, msg.key.remoteJidAlt)
  if (!phone) {
    logger.warn({ jid }, 'could not resolve phone number for sender, ignoring message')
    return null
  }
  return { jid, phone, isOwner: config.ownerPhones.includes(phone) || phone === myPhone }
}

async function receiveMedia(ctx, msg, content, type) {
  const media = content[type]
  const size = Number(media.fileLength || 0)
  if (size > config.maxFileBytes) {
    return reply(ctx.jid, `⚠️ הקובץ גדול מדי (${Math.round(size / 1048576)}MB). המקסימום הוא ${config.maxFileBytes / 1048576}MB.`)
  }

  fs.mkdirSync(config.mediaDir, { recursive: true })
  const ext = extensionFor(media.mimetype, media.fileName)
  const file = path.join(config.mediaDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`)

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

  store.addDraft(ctx.phone, {
    kind: MEDIA_TYPES[type],
    path: file,
    mimetype: media.mimetype,
    filename: media.fileName,
    caption: media.caption,
  })
  scheduleMenu(ctx)
}

// Wait a moment so that sending 10 files produces one question, not 10
function scheduleMenu(ctx) {
  clearTimeout(menuTimers.get(ctx.phone))
  menuTimers.set(
    ctx.phone,
    setTimeout(() => {
      menuTimers.delete(ctx.phone)
      sendMenu(ctx)
    }, 2500),
  )
}

function sendMenu(ctx, prefix = '') {
  const drafts = store.getDrafts(ctx.phone)
  if (!drafts.length) return
  const groups = store.groupsForUser(ctx.phone, ctx.isOwner)
  if (!groups.length) {
    discardDrafts(ctx.phone)
    return reply(ctx.jid, 'אין לך כרגע קבוצות פעילות לשליחה. פנה/י למנהל.')
  }
  const what = drafts.length === 1 ? describe(drafts[0]) : `${drafts.length} פריטים`
  const list = groups.map((g, i) => `*${i + 1}.* ${g.subject}`).join('\n')
  const hint = groups.length === 1 ? 'השב *1* לשליחה' : 'השב מספר, כמה מספרים (1,3) או *הכל*'
  reply(ctx.jid, `${prefix}📎 קיבלתי ${what}. לאן לשלוח?\n\n${list}\n\n${hint}. *ביטול* לביטול.`)
}

function chooseGroups(ctx, text, drafts) {
  const groups = store.groupsForUser(ctx.phone, ctx.isOwner)
  const sel = parseSelection(text, groups.length)
  if (!sel || sel.invalid) {
    const bad = sel?.invalid ? `אין קבוצה מספר ${sel.invalid.join(', ')}. ` : ''
    return sendMenu(ctx, `❓ ${bad}`)
  }
  const chosen = sel.indexes.map((i) => groups[i])
  const batchId = crypto.randomUUID()
  for (const g of chosen) {
    for (const d of drafts) {
      store.enqueue({
        batchId, phone: ctx.phone, toJid: g.jid,
        kind: d.kind, path: d.path, mimetype: d.mimetype, filename: d.filename, caption: d.caption,
      })
    }
  }
  store.clearDrafts(ctx.phone)
  kick()
  const count = chosen.length * drafts.length
  reply(ctx.jid, `📤 בתור לשליחה (${count}) אל: ${chosen.map((g) => g.subject).join(', ')}.\nאעדכן כשיישלח.`)
}

function discardDrafts(phone) {
  const drafts = store.getDrafts(phone)
  store.clearDrafts(phone)
  for (const d of drafts) removeFileIfUnused(d.path)
}

export function expireDrafts() {
  for (const d of store.expiredDrafts(config.draftTtlMs)) {
    store.deleteDraft(d.id)
    removeFileIfUnused(d.path)
  }
}

function describe(d) {
  return { image: 'תמונה', video: 'סרטון', audio: 'קובץ שמע', document: `קובץ ${d.filename || ''}`.trim(), text: 'הודעת טקסט' }[d.kind]
}

function notifyOwners(text) {
  for (const p of config.ownerPhones) reply(store.getUser(p)?.chat_jid || `${p}@s.whatsapp.net`, text)
}

function userHelp() {
  return [
    '🤖 *איך משתמשים בבוט*',
    '1. שלחו לכאן קובץ, תמונה, סרטון או הודעת טקסט (אפשר כמה בבת אחת).',
    '2. הבוט ישאל לאיזו קבוצה לשלוח. עונים במספר, כמה מספרים (1,3) או *הכל*.',
    '3. כשההודעות יישלחו, הבוט יעדכן כאן.',
    '',
    '*ביטול* מבטל את מה שממתין.',
  ].join('\n')
}

// ---------------- owner commands ----------------

const groupListText = (groups) => groups.map((g, i) => `*${i + 1}.* ${g.subject}`).join('\n')

function resolveGroupArgs(arg) {
  const groups = store.listGroups()
  const sel = parseSelection(arg || '', groups.length)
  if (!sel || sel.invalid) return { error: `מספרי קבוצות לא תקינים. ראו !קבוצות` }
  return { groups: sel.indexes.map((i) => groups[i]) }
}

const ownerCommands = [
  {
    names: ['עזרה', 'help'],
    run: (ctx) =>
      reply(ctx.jid, [
        '🛠️ *פקודות מנהל*',
        '!קבוצות - רשימת הקבוצות של הבוט (עם מספרים)',
        '!אשר <טלפון> <מספרים|הכל> - אישור משתמש לקבוצות',
        '!הסר <טלפון> [מספרים] - הסרת הרשאה (בלי מספרים = מחיקת המשתמש)',
        '!משתמשים - מי מורשה ולאן',
        '!סטטוס - מצב החיבור והתור',
        '!נסה-שוב - שליחה חוזרת של הודעות שנכשלו',
        ...personalCommands.map((c) => `!${c.names[0]} - ${c.description}`),
        '',
        'כמנהל אפשר גם פשוט לשלוח קבצים כמו כל משתמש.',
      ].join('\n')),
  },
  {
    names: ['קבוצות', 'groups'],
    run: async (ctx) => {
      await wa.refreshGroups()
      const groups = store.listGroups()
      reply(ctx.jid, groups.length ? `👥 *הקבוצות של הבוט:*\n${groupListText(groups)}` : 'הבוט לא חבר באף קבוצה.')
    },
  },
  {
    names: ['אשר', 'approve'],
    run: (ctx, { args }) => {
      const phone = normalizePhone(args[0])
      if (!phone || args.length < 2) return reply(ctx.jid, 'שימוש: !אשר 0501234567 1,3   או   !אשר 0501234567 הכל')
      const { groups, error } = resolveGroupArgs(args.slice(1).join(' '))
      if (error) return reply(ctx.jid, error)
      store.grant(phone, groups.map((g) => g.jid))
      reply(ctx.jid, `✅ ${phone} מורשה לשלוח אל: ${groups.map((g) => g.subject).join(', ')}`)
      const user = store.getUser(phone)
      reply(user?.chat_jid || `${phone}@s.whatsapp.net`, `🎉 אושרת לשלוח קבצים דרך הבוט!\n\n${userHelp()}`)
    },
  },
  {
    names: ['הסר', 'revoke'],
    run: (ctx, { args }) => {
      const phone = normalizePhone(args[0])
      if (!phone) return reply(ctx.jid, 'שימוש: !הסר 0501234567 [מספרי קבוצות]')
      if (args.length < 2) {
        store.revoke(phone)
        return reply(ctx.jid, `🚫 ${phone} הוסר לגמרי.`)
      }
      const { groups, error } = resolveGroupArgs(args.slice(1).join(' '))
      if (error) return reply(ctx.jid, error)
      store.revoke(phone, groups.map((g) => g.jid))
      reply(ctx.jid, `🚫 ההרשאה של ${phone} הוסרה מ: ${groups.map((g) => g.subject).join(', ')}`)
    },
  },
  {
    names: ['משתמשים', 'users'],
    run: (ctx) => {
      const users = store.listUsers().filter((u) => u.groups)
      reply(ctx.jid, users.length
        ? `👤 *משתמשים מורשים:*\n${users.map((u) => `• ${u.name || ''} ${u.phone}: ${u.groups}`).join('\n')}`
        : 'אין עדיין משתמשים מורשים.')
    },
  },
  {
    names: ['סטטוס', 'status'],
    run: (ctx) => {
      const q = store.queueStats()
      const up = wa.openedAt ? Math.round((Date.now() - wa.openedAt) / 60000) : 0
      reply(ctx.jid, [
        `🟢 מחובר ${up} דקות`,
        `📬 בתור: ${q.pending || 0} | נשלחו: ${q.sent || 0} | נכשלו: ${q.failed || 0}`,
        `👥 קבוצות: ${store.listGroups().length}`,
      ].join('\n'))
    },
  },
  {
    names: ['נסה-שוב', 'retry'],
    run: (ctx) => {
      const n = store.retryFailed()
      kick()
      reply(ctx.jid, n ? `🔁 ${n} הודעות חזרו לתור.` : 'אין הודעות שנכשלו.')
    },
  },
  ...personalCommands,
]

async function runOwnerCommand(ctx, cmd) {
  const command = ownerCommands.find((c) => c.names.includes(cmd.cmd))
  if (!command) {
    reply(ctx.jid, `פקודה לא מוכרת: !${cmd.cmd}. לרשימת הפקודות: !עזרה`)
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
