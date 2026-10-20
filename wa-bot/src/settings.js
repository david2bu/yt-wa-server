import crypto from 'node:crypto'
import { config, normalizePhone } from './config.js'
import * as store from './db.js'

/**
 * Settings the owner manages from the website. Environment variables still work and win,
 * but nothing has to be configured on the server: the first visit to the site sets the password.
 */

export function ownerPhones() {
  const fromEnv = config.ownerPhones
  const fromSite = (store.getSetting('owner_phones') || '').split(',').map(normalizePhone).filter(Boolean)
  return [...new Set([...fromEnv, ...fromSite])]
}

export function setOwnerPhones(list) {
  store.setSetting('owner_phones', list.map(normalizePhone).filter(Boolean).join(','))
}

export const hasPassword = () => !!(process.env.ADMIN_PASSWORD || store.getSetting('password_hash'))

export function checkPassword(given) {
  given = String(given || '')
  if (process.env.ADMIN_PASSWORD) {
    const a = crypto.createHash('sha256').update(given).digest()
    const b = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest()
    return crypto.timingSafeEqual(a, b)
  }
  const stored = store.getSetting('password_hash')
  if (!stored) return false
  const [salt, hash] = stored.split(':')
  const test = crypto.scryptSync(given, salt, 32)
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'))
}

export function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  store.setSetting('password_hash', `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`)
  store.setSetting('session_secret', crypto.randomBytes(32).toString('hex')) // logs out other sessions
}

export function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  let s = store.getSetting('session_secret')
  if (!s) {
    s = crypto.randomBytes(32).toString('hex')
    store.setSetting('session_secret', s)
  }
  return s
}
