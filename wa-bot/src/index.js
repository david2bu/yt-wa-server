import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'
import * as store from './db.js'
import { wa } from './whatsapp.js'
import { startQueue } from './queue.js'
import { handleMessage, finalizeSubmissions } from './handlers.js'
import { startWeb } from './web.js'

if (config.missingStorage) logger.error('No Railway volume attached - data and the WhatsApp login will be lost on every deploy')

wa.on('message', handleMessage)
startWeb()
startQueue()
await wa.start()

// Close posts the customer finished sending and put them in their slot
setInterval(() => {
  try {
    finalizeSubmissions()
  } catch (err) {
    logger.error({ err: err.stack }, 'finalize failed')
  }
}, 5000).unref()

// Housekeeping every 30 minutes
setInterval(() => {
  try {
    store.pruneSentMessages(3 * 86400_000)
    for (const id of store.finishedSubmissionsBefore(Date.now() - config.retentionDays * 86400_000)) {
      for (const p of store.deleteSubmission(id)) fs.rmSync(p, { force: true })
    }
    removeOrphanMedia()
  } catch (err) {
    logger.error({ err: err.message }, 'housekeeping failed')
  }
}, 30 * 60_000).unref()

// Watchdog: if we can't get back online on our own, exit and let docker/pm2 start us fresh.
// Everything is in SQLite, so nothing is lost.
setInterval(() => {
  if (wa.isStuck()) {
    logger.fatal('offline for too long - restarting process')
    process.exit(1)
  }
}, 60_000).unref()

function removeOrphanMedia() {
  if (!fs.existsSync(config.mediaDir)) return
  const hourAgo = Date.now() - 3600_000
  for (const name of fs.readdirSync(config.mediaDir)) {
    const file = path.join(config.mediaDir, name)
    if (fs.statSync(file).mtimeMs < hourAgo && !store.isPathInUse(file)) fs.rmSync(file, { force: true })
  }
}

process.on('unhandledRejection', (err) => logger.error({ err: err?.stack || String(err) }, 'unhandled rejection'))
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.stack }, 'uncaught exception - exiting for a clean restart')
  process.exit(1)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`)
    wa.teardown()
    store.db.close()
    process.exit(0)
  })
}
