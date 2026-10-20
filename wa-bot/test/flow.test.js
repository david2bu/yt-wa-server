// End-to-end flow with a fake WhatsApp connection: approve a user, they send a message, pick a group, it gets posted.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-test-'))
process.env.OWNER_PHONES = '0500000001'
process.env.SEND_DELAY_MIN = '0'
process.env.SEND_DELAY_MAX = '0'

const store = await import('../src/db.js')
const { wa } = await import('../src/whatsapp.js')
const { startQueue, stopQueue } = await import('../src/queue.js')
const { handleMessage } = await import('../src/handlers.js')

const sent = []
wa.state = 'open'
wa.sock = {}
wa.me = { id: '972599999999:3@s.whatsapp.net' }
wa.send = async (jid, content) => sent.push({ jid, content })
wa.refreshGroups = async () => {}
wa.phoneOf = async (jid) => jid.split('@')[0]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let n = 0
const textFrom = (phone, text) =>
  handleMessage({ key: { remoteJid: `${phone}@s.whatsapp.net`, id: `m${++n}` }, pushName: 'Tester', message: { conversation: text } })
const textsTo = (phone) => sent.filter((s) => s.jid === `${phone}@s.whatsapp.net`).map((s) => s.content.text)

store.syncGroups([{ id: 'b@g.us', subject: 'Beta' }, { id: 'a@g.us', subject: 'Alpha' }])
startQueue()
after(() => stopQueue())

test('stranger is turned away and owner is told', async () => {
  await textFrom('972521111111', 'hi')
  await sleep(1200)
  assert.match(textsTo('972521111111')[0], /אינך מורשה/)
  assert.match(textsTo('972500000001')[0], /972521111111/)
})

test('approved user sends text, picks a group, it is posted and reported', async () => {
  await textFrom('972500000001', '!אשר 052-111-1111 2') // #2 = Beta (sorted by name)
  assert.ok(store.isApproved('972521111111'))

  await textFrom('972521111111', 'Good morning everyone')
  await sleep(3500) // menu debounce
  const menu = textsTo('972521111111').at(-1)
  assert.match(menu, /1\.\* Beta/)
  assert.doesNotMatch(menu, /Alpha/) // only approved groups are offered

  await textFrom('972521111111', '1')
  await sleep(1500)
  const post = sent.find((s) => s.jid === 'b@g.us')
  assert.equal(post?.content.text, 'Good morning everyone')
  assert.ok(!sent.some((s) => s.jid === 'a@g.us'))
  assert.match(textsTo('972521111111').at(-1), /✅ נשלחו 1/)
})

test('selection with nothing pending, and cancel', async () => {
  await textFrom('972521111111', '1')
  await sleep(800)
  assert.match(textsTo('972521111111').at(-1), /אין קבצים/)
  await textFrom('972521111111', 'another one')
  await textFrom('972521111111', 'ביטול')
  await sleep(800)
  assert.match(textsTo('972521111111').at(-1), /בוטל/)
  assert.equal(store.getDrafts('972521111111').length, 0)
})

test('revoked user can no longer send', async () => {
  await textFrom('972500000001', '!הסר 0521111111')
  assert.ok(!store.isApproved('972521111111'))
})
