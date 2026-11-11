import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { config } from './config.js'
import * as store from './db.js'
import { kick } from './queue.js'
import { newMediaPath } from './handlers.js'
import { extensionFor } from './parse.js'
import { checkApiKey } from './settings.js'

/**
 * External API so other systems can post to groups automatically.
 *
 *   Authorization: Bearer <key>      (the key is created in the website: חיבור > הגדרות)
 *
 *   GET    /api/v1/groups            -> [{ id, name }]
 *   POST   /api/v1/posts             -> create a post (JSON or multipart), sent now or at sendAt
 *   GET    /api/v1/posts/:id         -> status of a post
 *   DELETE /api/v1/posts/:id         -> cancel what hasn't been sent yet
 *
 * Errors are JSON: { "error": "..." } with a 4xx/5xx status.
 */

const API_CUSTOMER = 'api'

export async function handleApi(req, res, url, { send, readJson, parseMultipart, createPost, HttpError }) {
  const auth = String(req.headers.authorization || '')
  const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : req.headers['x-api-key']
  if (!checkApiKey(key)) return send(res, 401, { error: 'invalid or missing API key' })

  const p = url.pathname.replace(/\/+$/, '')
  const postId = /^\/api\/v1\/posts\/(\d+)$/.exec(p)?.[1]

  if (req.method === 'GET' && p === '/api/v1/groups') {
    return send(res, 200, store.listGroups().map((g) => ({ id: g.jid, name: g.subject })))
  }

  if (req.method === 'POST' && p === '/api/v1/posts') {
    const isMultipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data')
    let body
    let files = []
    if (isMultipart) {
      const form = await parseMultipart(req)
      files = form.files
      body = { ...form.fields, groups: [].concat(form.fields.groups ?? form.fields.group ?? []).flatMap((g) => String(g).split(',')) }
    } else {
      body = await readJson(req)
    }

    try {
      const groups = resolveGroups(body.groups, HttpError)
      const sendAt = parseSendAt(body.sendAt, HttpError)
      for (const m of [].concat(body.media || [])) files.push(await downloadMedia(m, HttpError))

      if (!store.getCustomer(API_CUSTOMER)) store.saveCustomer(API_CUSTOMER, { name: 'API' })
      const sub = createPost(API_CUSTOMER, 'api', files, String(body.text || '').trim())
      store.tx(() => { for (const g of groups) store.addDelivery(sub.id, g.jid, sendAt) })
      kick()
      return send(res, 201, postView(sub.id))
    } catch (err) {
      for (const f of files) if (!store.isPathInUse(f.file)) fs.rmSync(f.file, { force: true })
      throw err
    }
  }

  if (postId && req.method === 'GET') {
    const sub = store.getSubmission(Number(postId))
    if (!sub || sub.source !== 'api') throw new HttpError(404, 'post not found')
    return send(res, 200, postView(sub.id))
  }

  if (postId && req.method === 'DELETE') {
    const sub = store.getSubmission(Number(postId))
    if (!sub || sub.source !== 'api') throw new HttpError(404, 'post not found')
    store.cancelPendingDeliveries(sub.id)
    return send(res, 200, postView(sub.id))
  }

  throw new HttpError(404, 'unknown endpoint. See GET /api/v1/groups and POST /api/v1/posts')
}

function postView(id) {
  const v = store.submissionView(store.getSubmission(id))
  const iso = (ts) => (ts ? new Date(ts).toISOString() : null)
  return {
    id: v.id,
    // scheduled | sent | failed | cancelled
    status: v.status === 'unscheduled' && v.deliveries.length ? 'cancelled' : v.status,
    createdAt: iso(v.created_at),
    items: v.items.map((i) => ({ type: i.kind, filename: i.filename || undefined, caption: i.caption || undefined })),
    deliveries: v.deliveries.map((d) => ({
      id: d.id,
      group: { id: d.group_jid, name: d.group_name || null },
      status: d.status, // pending | sent | failed | cancelled
      sendAt: iso(d.send_at),
      sentAt: iso(d.sent_at),
      error: d.error || undefined,
    })),
  }
}

// groups by id ("...@g.us") or by exact name (case-insensitive)
function resolveGroups(input, HttpError) {
  const wanted = [].concat(input || []).map((g) => String(g).trim()).filter(Boolean)
  if (!wanted.length) throw new HttpError(400, 'groups is required: group ids or names, see GET /api/v1/groups')
  const all = store.listGroups()
  const found = []
  const missing = []
  for (const w of wanted) {
    const g = all.find((x) => x.jid === w) || all.find((x) => x.subject.toLowerCase() === w.toLowerCase())
    if (g) found.push(g)
    else missing.push(w)
  }
  if (missing.length) throw new HttpError(400, `unknown group(s): ${missing.join(', ')}`)
  return [...new Map(found.map((g) => [g.jid, g])).values()]
}

// ISO date ("2026-11-12T10:00:00+02:00"), epoch milliseconds, or nothing / "now"
function parseSendAt(v, HttpError) {
  if (v === undefined || v === null || v === '' || v === 'now') return Date.now()
  const ts = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v))
  if (!Number.isFinite(ts)) throw new HttpError(400, 'sendAt must be an ISO date (with time zone) or epoch milliseconds')
  if (ts < Date.now() - 5 * 60_000) throw new HttpError(400, 'sendAt is in the past')
  return Math.max(ts, Date.now())
}

// media: "https://..." or { url, filename? }
async function downloadMedia(m, HttpError) {
  const src = typeof m === 'string' ? m : m?.url
  let u
  try {
    u = new URL(String(src))
  } catch {
    throw new HttpError(400, `bad media url: ${src}`)
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, `media url must be http(s): ${src}`)

  let r
  try {
    r = await fetch(u, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
  } catch (err) {
    throw new HttpError(400, `could not download ${src}: ${err.message}`)
  }
  if (!r.ok || !r.body) throw new HttpError(400, `could not download ${src}: HTTP ${r.status}`)
  if (Number(r.headers.get('content-length')) > config.maxFileBytes) {
    throw new HttpError(413, `media larger than ${config.maxFileBytes / 1048576}MB: ${src}`)
  }
  const mimetype = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
  const filename = (typeof m === 'object' && m.filename) || decodeURIComponent(path.basename(u.pathname)) || 'file'
  const file = newMediaPath(extensionFor(mimetype, filename))
  let size = 0
  const limited = Readable.fromWeb(r.body).on('data', (c) => {
    size += c.length
    if (size > config.maxFileBytes) limited.destroy(new Error('too big'))
  })
  try {
    await pipeline(limited, fs.createWriteStream(file))
  } catch (err) {
    fs.rmSync(file, { force: true })
    if (size > config.maxFileBytes) throw new HttpError(413, `media larger than ${config.maxFileBytes / 1048576}MB: ${src}`)
    throw new HttpError(400, `could not download ${src}: ${err.message}`)
  }
  return { file, mimetype, filename }
}
