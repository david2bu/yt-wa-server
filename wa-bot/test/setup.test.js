// First visit with nothing configured on the server: the site asks for a password and the owner's number.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-setup-'))
delete process.env.ADMIN_PASSWORD
delete process.env.OWNER_PHONES
process.env.PORT = '0'
process.env.LOG_LEVEL = 'silent'
process.env.RAILWAY_ENVIRONMENT_ID = 'x' // pretend we're on Railway without a volume

const { startWeb } = await import('../src/web.js')
const { ownerPhones } = await import('../src/settings.js')
const server = startWeb()
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
after(() => server.close())

const post = (url, body, cookie = '') =>
  fetch(base + url, { method: url === '/api/settings' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

test('first visit sets the password, then setup is closed', async () => {
  assert.deepEqual(await (await fetch(base + '/api/setup')).json(), { needsSetup: true })
  assert.equal((await post('/api/login', { password: '' })).status, 401)
  assert.equal((await post('/api/setup', { password: '123' })).status, 400)

  const res = await post('/api/setup', { password: 'goodpass', phone: '050-9998887' })
  assert.equal(res.status, 200)
  const cookie = res.headers.get('set-cookie').split(';')[0]
  assert.deepEqual(ownerPhones(), ['972509998887'])

  const status = await (await fetch(base + '/api/status', { headers: { cookie } })).json()
  assert.equal(status.missingStorage, true)

  assert.deepEqual(await (await fetch(base + '/api/setup')).json(), { needsSetup: false })
  assert.equal((await post('/api/setup', { password: 'hijack123' })).status, 403)
  assert.equal((await post('/api/login', { password: 'wrong' })).status, 401)
  assert.equal((await post('/api/login', { password: 'goodpass' })).status, 200)

  // change password from the settings
  assert.equal((await post('/api/settings', { currentPassword: 'nope', newPassword: 'another1' }, cookie)).status, 400)
  assert.equal((await post('/api/settings', { currentPassword: 'goodpass', newPassword: 'another1' }, cookie)).status, 200)
  assert.equal((await post('/api/login', { password: 'goodpass' })).status, 401)
  assert.equal((await post('/api/login', { password: 'another1' })).status, 200)
  // old session no longer valid after a password change
  assert.equal((await fetch(base + '/api/status', { headers: { cookie } })).status, 401)
})
