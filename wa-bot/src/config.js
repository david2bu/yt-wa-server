import path from 'node:path'
import crypto from 'node:crypto'

try {
  process.loadEnvFile()
} catch {
  // no .env file - rely on real environment variables
}

// Slots like "Sunday 10:00" are Israel time unless TZ says otherwise (Node picks this up at runtime)
process.env.TZ ||= 'Asia/Jerusalem'

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v))

// "0501234567" / "+972-50-123-4567" / "972501234567" -> "972501234567"
export function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 10 && digits.startsWith('0')) digits = '972' + digits.slice(1)
  return digits
}

const dataDir = path.resolve(process.env.DATA_DIR || './data')

export const config = {
  ownerPhones: (process.env.OWNER_PHONES || '').split(',').map(normalizePhone).filter(Boolean),
  pairingPhone: normalizePhone(process.env.PAIRING_PHONE),
  port: num(process.env.PORT, 3000),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // signs the login cookie; changing it logs everyone out
  sessionSecret: process.env.SESSION_SECRET || crypto.createHash('sha256').update('wa-bot:' + (process.env.ADMIN_PASSWORD || '')).digest('hex'),
  sendDelayMin: num(process.env.SEND_DELAY_MIN, 3),
  sendDelayMax: num(process.env.SEND_DELAY_MAX, 7),
  maxFileBytes: num(process.env.MAX_FILE_MB, 100) * 1024 * 1024,
  // a slot must be at least this far in the future to be picked automatically
  leadMinutes: num(process.env.LEAD_MINUTES, 2),
  // messages a customer sends within this window are one post (e.g. picture + text)
  groupWindowMs: num(process.env.GROUP_WINDOW_SECONDS, 20) * 1000,
  // finished posts (and their files) are deleted after this many days
  retentionDays: num(process.env.RETENTION_DAYS, 60),
  maxAttempts: 6,
  watchdogMs: 10 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir,
  authDir: path.join(dataDir, 'auth'),
  mediaDir: path.join(dataDir, 'media'),
  dbFile: path.join(dataDir, 'bot.db'),
}
