import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'
import * as store from './db.js'
import { wa } from './whatsapp.js'
import { startQueue } from './queue.js'
import { handleMessage, expireDrafts } from './handlers.js'
import { startWeb } from './web.js'

if (!config.ownerPhones.length) logger.warn('OWNER_PHONES is empty - only the bot number itself (message-yourself chat) can run admin commands')

wa.on('message', handleMessage)
startWeb()
startQueue()
await wa.start()

// Housekeeping every 5 minutes
setInterval(() => {
  try {
    expireDrafts()
    store.pruneSentMessages(3 * 24 * 60 * 60 * 1000)
    store.pruneOldJobs(14 * 24 * 60 * 60 * 1000)
    removeOrphanMedia()
  } catch (err) {
    logger.error({ err: err.message }, 'housekeeping failed')
  }
}, 5 * 60 * 1000).unref()

// Watchdog: if we can't get back online on our own, exit and let docker/pm2/systemd start us fresh.
// The queue is in SQLite, so nothing is lost.
setInterval(() => {
  if (wa.isStuck()) {
    logger.fatal('offline for too long - restarting process')
    process.exit(1)
  }
}, 60 * 1000).unref()

function removeOrphanMedia() {
  if (!fs.existsSync(config.mediaDir)) return
  const hourAgo = Date.now() - 60 * 60 * 1000
  for (const name of fs.readdirSync(config.mediaDir)) {
    const file = path.join(config.mediaDir, name)
    if (fs.statSync(file).mtimeMs < hourAgo && !store.isPathInUse(file)) fs.rmSync(file, { force: true })
  }
}

// Never die silently on a stray error inside Baileys; log it and keep going
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
