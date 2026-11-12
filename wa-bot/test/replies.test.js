// The owner's replies in a group the API posts to are kept and read back over the API, linked to the post.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TZ = 'Asia/Jerusalem'
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-replies-'))
process.env.ADMIN_PASSWORD = 'secret'
process.env.OWNER_PHONES = '972500000001'
process.env.SEND_DELAY_MIN = '0'
process.env.SEND_DELAY_MAX = '0'
process.env.PORT = '0'
process.env.LOG_LEVEL = 'silent'

const store = await import('../src/db.js')
const { wa } = await import('../src/whatsapp.js')
const { startQueue, stopQueue } = await import('../src/queue.js')
const { startWeb } = await import('../src/web.js')
const { handleMessage } = await import('../src/handlers.js')

const sent = []
let n = 0
wa.state = 'open'
wa.sock = {}
wa.me = { id: '972599999999:3@s.whatsapp.net' }
wa.send = async (jid, content) => {
  sent.push({ jid, content })
  return { key: { id: `OUT${++n}` } }
}
wa.phoneOf = async (jid) => (jid ? jid.split('@')[0] : null)
store.syncGroups([{ id: 'r@g.us', subject: 'Review' }, { id: 'p@g.us', subject: 'Public' }])
startQueue()

const server = startWeb()
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(() => {
  stopQueue()
  server.close()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let key = ''
const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const groupMsg = (group, participant, message, id = `IN${Math.random()}`) =>
  handleMessage({ key: { remoteJid: group, participant, id, fromMe: false }, message })

let postId
test('setup: key and an API post to the review group', async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"secret"}' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  key = (await (await fetch(base + '/api/api-key', { method: 'POST', headers: { cookie } })).json()).key
  const { status, data } = await call('POST', '/api/v1/posts', { groups: ['Review'], text: 'reel 1' })
  assert.equal(status, 201)
  postId = data.id
  for (let i = 0; i < 40 && !sent.length; i++) await sleep(50)
  assert.equal(sent.length, 1)
})

test('a reply quoting the post is kept with its post id', async () => {
  await groupMsg('r@g.us', '972500000001@s.whatsapp.net',
    { extendedTextMessage: { text: 'תוריד את הקליפ של הכותל', contextInfo: { stanzaId: 'OUT1' } } })
  const { data } = await call('GET', '/api/v1/replies')
  assert.equal(data.length, 1)
  assert.equal(data[0].text, 'תוריד את הקליפ של הכותל')
  assert.equal(data[0].postId, postId)
  assert.equal(data[0].group.name, 'Review')
})

test('a reaction is kept, a plain message has no post', async () => {
  await groupMsg('r@g.us', '972500000001@s.whatsapp.net', { reactionMessage: { text: '👍', key: { id: 'OUT1' } } })
  await groupMsg('r@g.us', '972500000001@s.whatsapp.net', { conversation: 'עוד משהו' })
  const { data } = await call('GET', '/api/v1/replies?since=1')
  assert.deepEqual(data.map((r) => [r.text, r.postId]), [['👍', postId], ['עוד משהו', null]])
})

test('ignored: other people, groups the API never posted to', async () => {
  await groupMsg('r@g.us', '972511111111@s.whatsapp.net', { conversation: 'זר' })
  await groupMsg('p@g.us', '972500000001@s.whatsapp.net', { conversation: 'קבוצה ציבורית' })
  const { data } = await call('GET', '/api/v1/replies?since=3')
  assert.deepEqual(data, [])
})

test('the replies endpoint needs the key', async () => {
  const res = await fetch(base + '/api/v1/replies')
  assert.equal(res.status, 401)
})
