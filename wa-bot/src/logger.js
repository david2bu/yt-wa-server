import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
})

// Baileys is very chatty; keep its logs quieter than ours
export const waLogger = logger.child({ module: 'baileys' }, { level: config.logLevel === 'debug' ? 'debug' : 'warn' })
