import path from 'node:path'
import crypto from 'node:crypto'

try {
  process.loadEnvFile()
} catch {
  // no .env file - rely on real environment variables
}

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
  webToken: process.env.WEB_TOKEN || crypto.randomBytes(12).toString('hex'),
  webTokenGenerated: !process.env.WEB_TOKEN,
  sendDelayMin: num(process.env.SEND_DELAY_MIN, 3),
  sendDelayMax: num(process.env.SEND_DELAY_MAX, 7),
  maxFileBytes: num(process.env.MAX_FILE_MB, 100) * 1024 * 1024,
  maxAttempts: 6,
  draftTtlMs: 30 * 60 * 1000,
  // if WhatsApp stays disconnected this long, exit and let the supervisor restart us cleanly
  watchdogMs: 10 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir,
  authDir: path.join(dataDir, 'auth'),
  mediaDir: path.join(dataDir, 'media'),
  dbFile: path.join(dataDir, 'bot.db'),
}
