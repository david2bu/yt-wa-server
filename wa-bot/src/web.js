import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Busboy from 'busboy'
import QRCode from 'qrcode'
import { config, normalizePhone } from './config.js'
import { logger } from './logger.js'
import * as store from './db.js'
import { wa } from './whatsapp.js'
import { reply, kick } from './queue.js'
import { autoSchedule, formatWhen } from './scheduler.js'
import { newMediaPath, summarize } from './handlers.js'
import { extensionFor, kindFor } from './parse.js'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------------- auth ----------------

const SESSION_DAYS = 30
const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('hex')

function makeSession() {
  const exp = String(Date.now() + SESSION_DAYS * 86400_000)
  return `${exp}.${sign(exp)}`
}

function isLoggedIn(req) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1]
  if (!sid) return false
  const [exp, mac] = sid.split('.')
  if (!exp || !mac || Number(exp) < Date.now()) return false
  const expected = sign(exp)
  return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
}

const failedLogins = new Map() // ip -> { n, since }
function checkRateLimit(ip) {
  const f = failedLogins.get(ip)
  if (f && Date.now() - f.since < 15 * 60_000 && f.n >= 10) throw new HttpError(429, 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.')
}
function noteFailedLogin(ip) {
  const f = failedLogins.get(ip)
  if (!f || Date.now() - f.since > 15 * 60_000) failedLogins.set(ip, { n: 1, since: Date.now() })
  else f.n++
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest()
  const b = crypto.createHash('sha256').update(config.adminPassword).digest()
  return crypto.timingSafeEqual(a, b)
}

// ---------------- helpers ----------------

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 1_000_000) throw new HttpError(413, 'בקשה גדולה מדי')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'JSON לא תקין')
  }
}

const originHost = (o) => {
  try {
    return new URL(o).host
  } catch {
    return null
  }
}
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https'
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim()

function requireSubmission(id) {
  const s = store.getSubmission(Number(id))
  if (!s) throw new HttpError(404, 'לא נמצא')
  return s
}

function validGroups(jids) {
  const active = new Set(store.listGroups().map((g) => g.jid))
  const list = [...new Set(jids || [])].filter((j) => active.has(j))
  if (!list.length) throw new HttpError(400, 'צריך לבחור לפחות קבוצה אחת')
  return list
}

function validTime(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n < Date.now() - 60_000) throw new HttpError(400, 'המועד חייב להיות בעתיד')
  return n
}

function customerJid(phone) {
  return store.getCustomer(phone)?.chat_jid || `${phone}@s.whatsapp.net`
}

function notifySchedule(sub, sendAt, groups) {
  const names = groups.map((g) => store.getGroup(g)?.subject || g).join(', ')
  reply(customerJid(sub.phone), `🗓️ הפרסום שלך (${summarize(store.getItems(sub.id))}) נקבע ל${formatWhen(sendAt)} ב: ${names}.`)
}

// ---------------- API ----------------

const routes = []
const route = (method, pattern, handler) => {
  const keys = []
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$')
  routes.push({ method, re, keys, handler })
}

route('GET', '/api/status', async () => ({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  state: wa.state,
  me: wa.me?.id?.split(':')[0] || null,
  qr: wa.state === 'qr' && wa.qr ? await QRCode.toDataURL(wa.qr, { margin: 1, width: 300 }) : null,
  pairingCode: wa.pairingCode,
  connectedSince: wa.connected ? wa.openedAt : null,
  stats: store.deliveryStats(),
  unscheduled: store.listSubmissions({ status: 'unscheduled' }).length,
  failed: store.listSubmissions({ status: 'failed' }).length,
  strangers: store.listStrangers().length,
}))

route('GET', '/api/groups', () => store.listGroups())
route('POST', '/api/groups/refresh', async () => {
  if (!wa.connected) throw new HttpError(503, 'הבוט לא מחובר לוואטסאפ')
  await wa.refreshGroups()
  return store.listGroups()
})

route('GET', '/api/customers', () => store.listCustomers())
route('POST', '/api/customers', async (req) => {
  const body = await readJson(req)
  const phone = normalizePhone(body.phone)
  if (phone.length < 9) throw new HttpError(400, 'מספר טלפון לא תקין')
  if (store.getCustomer(phone)) throw new HttpError(409, 'הלקוח כבר קיים')
  const name = String(body.name || '').trim()
  return store.saveCustomer(phone, { name, notes: body.notes || '', active: true })
})
route('PUT', '/api/customers/:phone', async (req, { phone }) => {
  if (!store.getCustomer(phone)) throw new HttpError(404, 'לא נמצא')
  const body = await readJson(req)
  return store.saveCustomer(phone, {
    name: body.name !== undefined ? String(body.name).trim() : undefined,
    notes: body.notes,
    active: body.active === undefined ? undefined : !!body.active,
  })
})
route('DELETE', '/api/customers/:phone', ({}, { phone }) => {
  store.deleteCustomer(phone)
  return { ok: true }
})
route('PUT', '/api/customers/:phone/slots', async (req, { phone }) => {
  if (!store.getCustomer(phone)) throw new HttpError(404, 'לא נמצא')
  const body = await readJson(req)
  const slots = (Array.isArray(body) ? body : []).map((s) => {
    const weekday = Number(s.weekday)
    if (!(weekday >= 0 && weekday <= 6)) throw new HttpError(400, 'יום לא תקין')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '')) throw new HttpError(400, 'שעה לא תקינה')
    return { weekday, time: s.time, active: s.active !== false, groups: (s.groups || []).filter(Boolean) }
  })
  store.setSlots(phone, slots)
  return store.listSlots(phone)
})

route('GET', '/api/strangers', () => store.listStrangers())
route('DELETE', '/api/strangers/:phone', ({}, { phone }) => {
  store.deleteStranger(phone)
  return { ok: true }
})

route('GET', '/api/submissions', ({}, {}, url) => store.listSubmissions({
  status: url.searchParams.get('status') || undefined,
  phone: url.searchParams.get('phone') || undefined,
}))

// upload from the website (the owner posting for a customer, or for themselves)
route('POST', '/api/submissions', (req) => receiveUpload(req))

route('DELETE', '/api/submissions/:id', ({}, { id }) => {
  requireSubmission(id)
  for (const p of store.deleteSubmission(Number(id))) fs.rm(p, { force: true }, () => {})
  return { ok: true }
})
route('POST', '/api/submissions/:id/schedule', async (req, { id }) => {
  const sub = requireSubmission(id)
  const body = await readJson(req)
  const sendAt = validTime(body.sendAt)
  const groups = validGroups(body.groups)
  store.tx(() => { for (const g of groups) store.addDelivery(sub.id, g, sendAt) })
  if (sub.state === 'collecting') store.setSubmissionState(sub.id, 'ready')
  if (body.notify !== false && sub.source === 'whatsapp') notifySchedule(sub, sendAt, groups)
  kick()
  return store.submissionView(store.getSubmission(sub.id))
})
route('POST', '/api/submissions/:id/auto', async (req, { id }) => {
  const sub = requireSubmission(id)
  const body = await readJson(req)
  const placed = autoSchedule(sub.id)
  if (!placed) throw new HttpError(400, 'ללקוח אין משבצות קבועות פעילות. הגדירו אותן בלשונית "לקוחות".')
  if (body.notify !== false && sub.source === 'whatsapp') notifySchedule(sub, placed.sendAt, placed.groups)
  return store.submissionView(store.getSubmission(sub.id))
})
route('POST', '/api/submissions/:id/send-now', async (req, { id }) => {
  const sub = requireSubmission(id)
  const body = await readJson(req)
  const view = store.submissionView(sub)
  const pending = view.deliveries.filter((d) => d.status === 'pending' || d.status === 'failed')
  store.tx(() => {
    if (body.groups?.length) {
      for (const g of validGroups(body.groups)) store.addDelivery(sub.id, g, Date.now())
    } else if (pending.length) {
      for (const d of pending) {
        store.updateDelivery(d.id, { sendAt: Date.now() })
        if (d.status === 'failed') store.updateDelivery(d.id, { status: 'pending' })
      }
    } else {
      throw new HttpError(400, 'בחרו קבוצות לשליחה')
    }
  })
  if (sub.state === 'collecting') store.setSubmissionState(sub.id, 'ready')
  kick()
  return store.submissionView(store.getSubmission(sub.id))
})
route('POST', '/api/submissions/:id/cancel', ({}, { id }) => {
  const sub = requireSubmission(id)
  store.cancelPendingDeliveries(sub.id)
  return store.submissionView(store.getSubmission(sub.id))
})

route('PATCH', '/api/deliveries/:id', async (req, { id }) => {
  const d = store.getDelivery(Number(id))
  if (!d) throw new HttpError(404, 'לא נמצא')
  const body = await readJson(req)
  if (d.status === 'sent') throw new HttpError(400, 'כבר נשלח')
  if (body.sendAt !== undefined) store.updateDelivery(d.id, { sendAt: validTime(body.sendAt) })
  if (['cancelled', 'pending'].includes(body.status)) store.updateDelivery(d.id, { status: body.status })
  kick()
  return store.getDelivery(d.id)
})

route('GET', '/api/calendar', ({}, {}, url) => {
  const from = Number(url.searchParams.get('from')) || Date.now() - 86400_000
  const to = Number(url.searchParams.get('to')) || from + 14 * 86400_000
  return store.upcomingDeliveries(from, to)
})

// ---------------- uploads ----------------

function receiveUpload(req) {
  return new Promise((resolve, reject) => {
    const fields = {}
    const files = []
    const writes = []
    let tooBig = false
    let bb
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: config.maxFileBytes, files: 20 } })
    } catch {
      return reject(new HttpError(400, 'העלאה לא תקינה'))
    }
    bb.on('field', (name, val) => { fields[name] = val })
    bb.on('file', (_name, stream, info) => {
      const file = newMediaPath(extensionFor(info.mimeType, info.filename))
      const out = fs.createWriteStream(file)
      stream.on('limit', () => { tooBig = true })
      writes.push(new Promise((res, rej) => out.on('finish', res).on('error', rej)))
      stream.pipe(out)
      files.push({ file, mimetype: info.mimeType, filename: Buffer.from(info.filename || '', 'latin1').toString('utf8') })
    })
    bb.on('error', (e) => reject(new HttpError(400, e.message)))
    bb.on('close', async () => {
      try {
        await Promise.all(writes)
        if (tooBig) {
          for (const f of files) fs.rmSync(f.file, { force: true })
          throw new HttpError(413, `קובץ גדול מ-${config.maxFileBytes / 1048576}MB`)
        }
        const phone = normalizePhone(fields.phone) || config.ownerPhones[0] || 'owner'
        if (!store.getCustomer(phone)) store.saveCustomer(phone, { name: config.ownerPhones.includes(phone) ? 'אני' : '' })
        const text = (fields.text || '').trim()
        if (!files.length && !text) throw new HttpError(400, 'אין תוכן')

        const sub = store.createSubmission(phone, 'web', 'ready') // web posts are complete right away
        files.forEach((f, i) => store.addItem(sub.id, {
          kind: kindFor(f.mimetype),
          path: f.file,
          mimetype: f.mimetype,
          filename: f.filename,
          caption: i === 0 && text && kindFor(f.mimetype) !== 'audio' ? text : null,
          size: fs.statSync(f.file).size,
        }))
        const captionUsed = files.length && kindFor(files[0].mimetype) !== 'audio'
        if (text && !captionUsed) store.addItem(sub.id, { kind: 'text', caption: text })
        resolve(store.submissionView(store.getSubmission(sub.id)))
      } catch (err) {
        reject(err)
      }
    })
    req.pipe(bb)
  })
}

// ---------------- media (with Range support so videos can be previewed) ----------------

function serveMedia(req, res, itemId) {
  const item = store.getItem(Number(itemId))
  if (!item?.path || !fs.existsSync(item.path)) return send(res, 404, { error: 'לא נמצא' })
  const { size } = fs.statSync(item.path)
  const headers = {
    'content-type': item.mimetype || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=86400',
  }
  if (item.kind === 'document') {
    headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(item.filename || 'file')}`
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    return fs.createReadStream(item.path, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...headers, 'content-length': size })
  fs.createReadStream(item.path).pipe(res)
}

// ---------------- server ----------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname

  if (p === '/health') {
    // 200 only when actually connected, so uptime monitors can alert on it
    return send(res, wa.connected ? 200 : 503, { state: wa.state })
  }

  if (req.method === 'GET' && STATIC[p]) {
    const file = path.join(PUBLIC_DIR, STATIC[p])
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)],
      'cache-control': 'no-cache',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
    })
    return fs.createReadStream(file).pipe(res)
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req)
    checkRateLimit(ip)
    if (!config.adminPassword) throw new HttpError(500, 'לא הוגדרה סיסמה (ADMIN_PASSWORD בקובץ .env)')
    const { password } = await readJson(req)
    if (!passwordMatches(password)) {
      noteFailedLogin(ip)
      throw new HttpError(401, 'סיסמה שגויה')
    }
    failedLogins.delete(ip)
    const cookie = `sid=${makeSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`
    res.setHeader('set-cookie', cookie)
    return send(res, 200, { ok: true })
  }
  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    return send(res, 200, { ok: true })
  }

  if (!p.startsWith('/api/') && !p.startsWith('/media/')) return send(res, 404, { error: 'לא נמצא' })
  if (!isLoggedIn(req)) return send(res, 401, { error: 'צריך להתחבר' })

  // SameSite=Strict blocks cross-site cookies; also reject cross-origin writes outright
  const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')].map((x) => x?.trim())
  if (req.method !== 'GET' && req.headers.origin && !hosts.includes(originHost(req.headers.origin))) {
    return send(res, 403, { error: 'מקור לא מורשה' })
  }

  const media = /^\/media\/(\d+)$/.exec(p)
  if (media && req.method === 'GET') return serveMedia(req, res, media[1])

  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = r.re.exec(p)
    if (!m) continue
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
    return send(res, 200, await r.handler(req, params, url))
  }
  send(res, 404, { error: 'לא נמצא' })
}

export function startWeb() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500
      if (status >= 500) logger.error({ err: err.stack || err.message, url: req.url }, 'web error')
      if (!res.headersSent) send(res, status, { error: err.message })
      else res.end()
    })
  })
  server.requestTimeout = 30 * 60_000 // big uploads on slow connections
  server.listen(config.port, () => logger.info({ port: config.port }, 'website up'))
  if (!config.adminPassword) logger.error('ADMIN_PASSWORD is not set - nobody can log in to the website')
  return server
}
