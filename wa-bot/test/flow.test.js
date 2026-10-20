// End-to-end with a fake WhatsApp connection and the real website API:
// customer sends -> auto slot -> sent to group; manual scheduling; web upload; auth.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TZ = 'Asia/Jerusalem'
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-test-'))
process.env.OWNER_PHONES = '0500000001'
process.env.ADMIN_PASSWORD = 'secret'
process.env.SEND_DELAY_MIN = '0'
process.env.SEND_DELAY_MAX = '0'
process.env.GROUP_WINDOW_SECONDS = '0'
process.env.PORT = '0'
process.env.LOG_LEVEL = 'silent'

const store = await import('../src/db.js')
const { wa } = await import('../src/whatsapp.js')
const { startQueue, stopQueue } = await import('../src/queue.js')
const { handleMessage, finalizeSubmissions } = await import('../src/handlers.js')
const { startWeb } = await import('../src/web.js')

const sent = []
wa.state = 'open'
wa.sock = {}
wa.me = { id: '972599999999:3@s.whatsapp.net' }
wa.send = async (jid, content) => sent.push({ jid, content })
wa.refreshGroups = async () => store.listGroups()
wa.phoneOf = async (jid) => jid.split('@')[0]

store.syncGroups([{ id: 'b@g.us', subject: 'Beta' }, { id: 'a@g.us', subject: 'Alpha' }])
startQueue()
const server = startWeb()
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(() => {
  stopQueue()
  server.close()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let n = 0
const textFrom = (phone, text) =>
  handleMessage({ key: { remoteJid: `${phone}@s.whatsapp.net`, id: `m${++n}` }, pushName: 'Tester', message: { conversation: text } })
const textsTo = (phone) => sent.filter((s) => s.jid === `${phone}@s.whatsapp.net`).map((s) => s.content.text)
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
async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { cookie, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data, res }
}

const CUSTOMER = '972521111111'

test('website requires login', async () => {
  assert.equal((await api('GET', '/api/customers')).status, 401)
  assert.equal((await api('POST', '/api/login', { password: 'nope' })).status, 401)
  const ok = await api('POST', '/api/login', { password: 'secret' })
  assert.equal(ok.status, 200)
  cookie = ok.res.headers.get('set-cookie').split(';')[0]
  assert.equal((await api('GET', '/api/customers')).status, 200)
})

test('unknown number is turned away, owner notified, listed on the site', async () => {
  await textFrom(CUSTOMER, 'hi')
  await waitFor(() => textsTo(CUSTOMER).length && textsTo('972500000001').length)
  assert.match(textsTo(CUSTOMER)[0], /לא רשום/)
  assert.match(textsTo('972500000001')[0], /972521111111/)
  const { data } = await api('GET', '/api/strangers')
  assert.equal(data[0].phone, CUSTOMER)
})

test('customer with slots: post goes into the next slot and is delivered', async () => {
  assert.equal((await api('POST', '/api/customers', { phone: '052-111-1111', name: 'דני' })).status, 200)
  assert.equal((await api('GET', '/api/strangers')).data.length, 0)
  const slots = await api('PUT', `/api/customers/${CUSTOMER}/slots`, [{ weekday: 3, time: '18:30', groups: ['b@g.us', 'a@g.us'] }])
  assert.equal(slots.status, 200)

  // two messages in a row become one post
  await textFrom(CUSTOMER, 'Sale today')
  await textFrom(CUSTOMER, 'Call 050-0000000')
  finalizeSubmissions()
  const confirmation = await waitFor(() => textsTo(CUSTOMER).find((t) => t.includes('יפורסם')))
  assert.match(confirmation, /יום רביעי .* בשעה 18:30/)

  const [sub] = (await api('GET', '/api/submissions?status=scheduled')).data
  assert.equal(sub.items.length, 2)
  assert.equal(sub.deliveries.length, 2)
  assert.equal(new Date(sub.deliveries[0].send_at).getDay(), 3)

  // the next post takes the following week's occurrence
  await textFrom(CUSTOMER, 'Second post')
  finalizeSubmissions()
  const subs = (await api('GET', '/api/submissions?status=scheduled')).data
  const times = subs.map((s) => s.deliveries[0].send_at).sort()
  const [a, b] = times.map((t) => new Date(t))
  assert.equal(Math.round((b - a) / 86400_000), 7) // a week later (clock may shift for DST)
  assert.equal(`${b.getDay()} ${b.getHours()}:${b.getMinutes()}`, '3 18:30')

  // move the first one to "now" and let the queue deliver it
  for (const d of sub.deliveries) assert.equal((await api('PATCH', `/api/deliveries/${d.id}`, { sendAt: Date.now() })).status, 200)
  await waitFor(() => sent.filter((s) => s.jid === 'a@g.us').length === 2 && sent.filter((s) => s.jid === 'b@g.us').length === 2)
  assert.deepEqual(sent.filter((s) => s.jid === 'b@g.us').map((s) => s.content.text), ['Sale today', 'Call 050-0000000'])
  await waitFor(() => textsTo(CUSTOMER).some((t) => t.includes('📢')))
  const after = (await api('GET', `/api/submissions?phone=${CUSTOMER}&status=sent`)).data
  assert.equal(after.length, 1)
})

test('customer without slots: waits for manual scheduling, gets notified', async () => {
  await api('POST', '/api/customers', { phone: '0522222222', name: 'רותי' })
  await textFrom('972522222222', 'Please post this')
  finalizeSubmissions()
  await waitFor(() => textsTo('972522222222').some((t) => t.includes('המנהל יקבע')))

  const [sub] = (await api('GET', '/api/submissions?status=unscheduled&phone=972522222222')).data
  assert.ok(sub)
  assert.equal((await api('POST', `/api/submissions/${sub.id}/auto`, {})).status, 400) // no slots
  assert.equal((await api('POST', `/api/submissions/${sub.id}/schedule`, { sendAt: Date.now() - 3600_000, groups: ['a@g.us'] })).status, 400)
  const when = Date.now() + 86400_000
  const r = await api('POST', `/api/submissions/${sub.id}/schedule`, { sendAt: when, groups: ['a@g.us'] })
  assert.equal(r.data.status, 'scheduled')
  await waitFor(() => textsTo('972522222222').some((t) => t.includes('נקבע')))

  const cal = (await api('GET', `/api/calendar?from=${Date.now()}&to=${when + 1000}`)).data
  assert.ok(cal.some((d) => d.submission_id === sub.id && d.customer_name === 'רותי'))
})

test('customer can cancel their latest post', async () => {
  await textFrom(CUSTOMER, 'cancel me')
  finalizeSubmissions()
  await waitFor(() => textsTo(CUSTOMER).filter((t) => t.includes('יפורסם')).length === 3)
  await textFrom(CUSTOMER, 'ביטול')
  await waitFor(() => textsTo(CUSTOMER).some((t) => t.includes('בוטל')))
})

test('upload from the website, preview the file, send now', async () => {
  const fd = new FormData()
  fd.append('phone', '')
  fd.append('text', 'From the site')
  fd.append('files', new Blob([Buffer.from('fakejpegdata')], { type: 'image/jpeg' }), 'pic.jpg')
  const up = await api('POST', '/api/submissions', fd)
  assert.equal(up.status, 200)
  assert.equal(up.data.items[0].kind, 'image')
  assert.equal(up.data.items[0].caption, 'From the site')

  const media = await fetch(`${base}/media/${up.data.items[0].id}`, { headers: { cookie, range: 'bytes=0-3' } })
  assert.equal(media.status, 206)
  assert.equal(await media.text(), 'fake')
  assert.equal((await fetch(`${base}/media/${up.data.items[0].id}`)).status, 401)

  const before = sent.length
  await api('POST', `/api/submissions/${up.data.id}/send-now`, { groups: ['b@g.us'] })
  const post = await waitFor(() => sent.slice(before).find((s) => s.jid === 'b@g.us' && s.content.image))
  assert.equal(post.content.caption, 'From the site')
})

test('customer that is deactivated is treated as unknown', async () => {
  await api('PUT', `/api/customers/972522222222`, { active: false })
  const subsBefore = (await api('GET', '/api/submissions?phone=972522222222')).data.length
  await textFrom('972522222222', 'still here?')
  finalizeSubmissions()
  assert.equal((await api('GET', '/api/submissions?phone=972522222222')).data.length, subsBefore)
})
