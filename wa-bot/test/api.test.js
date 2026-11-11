// External API: other systems post to groups with an API key.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

process.env.TZ = 'Asia/Jerusalem'
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-api-'))
process.env.ADMIN_PASSWORD = 'secret'
process.env.SEND_DELAY_MIN = '0'
process.env.SEND_DELAY_MAX = '0'
process.env.PORT = '0'
process.env.LOG_LEVEL = 'silent'

const store = await import('../src/db.js')
const { wa } = await import('../src/whatsapp.js')
const { startQueue, stopQueue } = await import('../src/queue.js')
const { startWeb } = await import('../src/web.js')

const sent = []
wa.state = 'open'
wa.sock = {}
wa.me = { id: '972599999999:3@s.whatsapp.net' }
wa.send = async (jid, content) => sent.push({ jid, content })
store.syncGroups([{ id: 'b@g.us', subject: 'Beta' }, { id: 'a@g.us', subject: 'Alpha' }])
startQueue()

const server = startWeb()
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

// a tiny file server standing in for "a link to the video"
const files = http.createServer((req, res) => {
  if (req.url === '/clip.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    return res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
  }
  res.writeHead(404).end()
}).listen(0)
await new Promise((r) => files.once('listening', r))
const fileBase = `http://127.0.0.1:${files.address().port}`

after(() => {
  stopQueue()
  server.close()
  files.close()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('timed out waiting')
}

let cookie = ''
let key = ''
const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const withKey = (k = key) => ({ authorization: `Bearer ${k}` })

test('owner creates an API key on the website', async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"secret"}' })
  cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await call('GET', '/api/api-key', null, { cookie })).data.key, null)
  key = (await call('POST', '/api/api-key', null, { cookie })).data.key
  assert.match(key, /^wab_/)
})

test('requests without the right key are refused', async () => {
  assert.equal((await call('GET', '/api/v1/groups')).status, 401)
  assert.equal((await call('GET', '/api/v1/groups', null, withKey('wab_wrong'))).status, 401)
  // the website's cookie is not an API key
  assert.equal((await call('GET', '/api/v1/groups', null, { cookie })).status, 401)
})

test('lists groups', async () => {
  const { status, data } = await call('GET', '/api/v1/groups', null, withKey())
  assert.equal(status, 200)
  assert.deepEqual(data, [{ id: 'a@g.us', name: 'Alpha' }, { id: 'b@g.us', name: 'Beta' }])
  assert.equal((await call('GET', '/api/v1/groups', null, { 'x-api-key': key })).status, 200)
})

test('JSON post with a media link, by group name, sent now', async () => {
  const { status, data } = await call('POST', '/api/v1/posts', {
    groups: ['beta', 'a@g.us'], text: 'Hello from the API', media: [`${fileBase}/clip.png`],
  }, withKey())
  assert.equal(status, 201)
  assert.equal(data.status, 'scheduled')
  assert.equal(data.deliveries.length, 2)
  assert.deepEqual(data.items, [{ type: 'image', filename: 'clip.png', caption: 'Hello from the API' }])

  await waitFor(() => sent.some((s) => s.jid === 'a@g.us') && sent.some((s) => s.jid === 'b@g.us'))
  assert.equal(sent.find((s) => s.jid === 'b@g.us').content.caption, 'Hello from the API')
  let status2
  for (let i = 0; i < 40 && status2?.data.status !== 'sent'; i++) {
    await sleep(100)
    status2 = await call('GET', `/api/v1/posts/${data.id}`, null, withKey())
  }
  assert.equal(status2.data.status, 'sent')
  assert.ok(status2.data.deliveries.every((d) => d.sentAt))
})

test('multipart upload, scheduled for later, then cancelled', async () => {
  const fd = new FormData()
  fd.append('groups', 'Alpha')
  fd.append('text', 'Later')
  fd.append('sendAt', new Date(Date.now() + 86400_000).toISOString())
  fd.append('files', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'flyer.pdf')
  const { status, data } = await call('POST', '/api/v1/posts', fd, withKey())
  assert.equal(status, 201)
  assert.equal(data.items[0].type, 'document')
  assert.equal(data.items[0].filename, 'flyer.pdf')
  assert.ok(Date.parse(data.deliveries[0].sendAt) > Date.now() + 86000_000)

  // shows up on the website like any other post
  const site = (await call('GET', '/api/submissions?status=scheduled', null, { cookie })).data
  assert.ok(site.some((s) => s.id === data.id && s.customer_name === 'API'))

  const cancelled = await call('DELETE', `/api/v1/posts/${data.id}`, null, withKey())
  assert.equal(cancelled.data.status, 'cancelled')
  assert.equal(cancelled.data.deliveries[0].status, 'cancelled')
})

test('clear errors for bad input', async () => {
  const bad = async (body) => (await call('POST', '/api/v1/posts', body, withKey()))
  assert.match((await bad({ text: 'x' })).data.error, /groups is required/)
  assert.match((await bad({ groups: ['Nope'], text: 'x' })).data.error, /unknown group/)
  assert.match((await bad({ groups: ['Alpha'] })).data.error, /אין תוכן/)
  assert.match((await bad({ groups: ['Alpha'], text: 'x', sendAt: 'tomorrow' })).data.error, /sendAt/)
  assert.match((await bad({ groups: ['Alpha'], text: 'x', sendAt: '2020-01-01T00:00:00Z' })).data.error, /past/)
  assert.match((await bad({ groups: ['Alpha'], media: [`${fileBase}/missing.mp4`] })).data.error, /HTTP 404/)
  assert.equal((await call('GET', '/api/v1/posts/99999', null, withKey())).status, 404)
})

test('a new key replaces the old one', async () => {
  const old = key
  key = (await call('POST', '/api/api-key', null, { cookie })).data.key
  assert.notEqual(key, old)
  assert.equal((await call('GET', '/api/v1/groups', null, withKey(old))).status, 401)
  assert.equal((await call('GET', '/api/v1/groups', null, withKey())).status, 200)
})
