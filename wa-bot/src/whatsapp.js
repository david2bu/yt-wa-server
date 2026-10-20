import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from 'baileys'
import { config } from './config.js'
import { logger, waLogger } from './logger.js'
import * as store from './db.js'

/**
 * Owns the single WhatsApp connection and keeps it alive:
 *  - reconnects with exponential backoff on every kind of drop
 *  - wipes the session and goes back to QR when logged out
 *  - backs off for longer when another instance took over the session (440)
 *  - lets the process die (supervisor restarts it) if it cannot recover for too long
 */
class WhatsApp extends EventEmitter {
  sock = null
  state = 'starting' // starting | qr | connecting | open | closed | logged_out | banned
  qr = null
  pairingCode = null
  me = null
  attempt = 0
  disconnectedSince = Date.now()
  openedAt = null
  reconnectTimer = null
  groupCache = new Map()
  retryCounter = new Map()

  get connected() {
    return this.state === 'open' && !!this.sock
  }

  async start() {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.teardown()

    fs.mkdirSync(config.authDir, { recursive: true })
    const { state: auth, saveCreds } = await useMultiFileAuthState(config.authDir)

    let version
    try {
      ;({ version } = await fetchLatestBaileysVersion())
    } catch (err) {
      logger.warn({ err: err.message }, 'could not fetch latest WA version, using bundled one')
    }

    this.state = 'connecting'
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, waLogger) },
      logger: waLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, // keep phone notifications working
      syncFullHistory: false,
      emitOwnEvents: true,
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 500,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid),
      getMessage: async (key) => this.lookupSent(key.id),
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
      msgRetryCounterCache: this.retryCounterStore(),
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u) => this.onConnectionUpdate(sock, u))
    sock.ev.on('messages.upsert', (u) => {
      if (u.type !== 'notify') return
      for (const msg of u.messages) this.emit('message', msg)
    })
    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) {
        this.groupCache.set(g.id, g)
        store.upsertGroup(g.id, g.subject, true)
      }
    })
    sock.ev.on('groups.update', async (updates) => {
      for (const u of updates) {
        if (u.subject) store.upsertGroup(u.id, u.subject, true)
        this.groupCache.delete(u.id) // refetched on next send
      }
    })
    sock.ev.on('group-participants.update', ({ id, participants, action }) => {
      this.groupCache.delete(id)
      const meIds = [this.me?.id, this.me?.lid].filter(Boolean).map(bareJid)
      const ids = participants
        .flatMap((p) => (typeof p === 'string' ? [p] : [p.id, p.lid, p.phoneNumber]))
        .filter(Boolean)
        .map(bareJid)
      if (action === 'remove' && ids.some((p) => meIds.includes(p))) {
        logger.info({ group: id }, 'bot was removed from group')
        store.setGroupActive(id, false)
      }
    })
  }

  async onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return // stale socket

    if (qr) {
      this.state = 'qr'
      this.qr = qr
      logger.info(`scan the QR at http://<server>:${config.port}/qr?token=${config.webToken}`)
      if (config.pairingPhone && !this.pairingCode && !sock.authState.creds.registered) {
        try {
          this.pairingCode = await sock.requestPairingCode(config.pairingPhone)
          logger.info({ code: this.pairingCode }, 'pairing code (WhatsApp > Linked devices > Link with phone number)')
        } catch (err) {
          logger.error({ err: err.message }, 'pairing code request failed')
        }
      }
    }

    if (connection === 'open') {
      this.state = 'open'
      this.qr = null
      this.pairingCode = null
      this.attempt = 0
      this.openedAt = Date.now()
      this.me = sock.user
      logger.info({ me: sock.user?.id }, 'WhatsApp connected')
      this.refreshGroups().catch((err) => logger.warn({ err: err.message }, 'group sync failed'))
      this.emit('open')
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.message
      if (this.state === 'open') this.disconnectedSince = Date.now()
      this.state = 'closed'
      this.emit('close')

      if (code === DisconnectReason.loggedOut) {
        logger.error('logged out from the phone - clearing session, a new QR will be shown')
        this.state = 'logged_out'
        fs.rmSync(config.authDir, { recursive: true, force: true })
        this.scheduleReconnect(2_000)
        return
      }
      if (code === DisconnectReason.forbidden) {
        logger.fatal('WhatsApp returned 403 (account restricted). Not reconnecting automatically for 30 minutes.')
        this.state = 'banned'
        this.scheduleReconnect(30 * 60_000)
        return
      }
      if (code === DisconnectReason.connectionReplaced) {
        logger.error('session opened somewhere else (another copy of the bot running?) - waiting 2 minutes')
        this.scheduleReconnect(2 * 60_000)
        return
      }
      if (code === DisconnectReason.restartRequired) {
        logger.info('restart required by WhatsApp (normal after pairing)')
        this.scheduleReconnect(0)
        return
      }

      const delay = Math.min(1000 * 2 ** this.attempt, 60_000) + Math.floor(Math.random() * 1000)
      this.attempt++
      logger.warn({ code, reason, retryInMs: delay }, 'connection closed, reconnecting')
      this.scheduleReconnect(delay)
    }
  }

  scheduleReconnect(ms) {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.start().catch((err) => {
        logger.error({ err: err.message }, 'reconnect failed')
        this.scheduleReconnect(Math.min(1000 * 2 ** ++this.attempt, 60_000))
      })
    }, ms)
  }

  teardown() {
    if (!this.sock) return
    try {
      this.sock.ev.removeAllListeners()
      this.sock.end(undefined)
    } catch {
      // already closed
    }
    this.sock = null
  }

  // Called by the watchdog: true if we've been stuck offline for too long (but not waiting on a human)
  isStuck() {
    if (this.connected || this.state === 'qr' || this.state === 'banned') return false
    return Date.now() - this.disconnectedSince > config.watchdogMs
  }

  async refreshGroups() {
    const groups = await this.sock.groupFetchAllParticipating()
    const list = Object.values(groups)
    for (const g of list) this.groupCache.set(g.id, g)
    store.syncGroups(list)
    logger.info({ count: list.length }, 'groups synced')
    return list
  }

  async send(jid, content) {
    if (!this.connected) throw new Error('not connected')
    if (isJidGroup(jid) && !this.groupCache.has(jid)) {
      this.groupCache.set(jid, await this.sock.groupMetadata(jid))
    }
    const sent = await this.sock.sendMessage(jid, content)
    if (sent?.key?.id && sent.message) {
      store.saveSentMessage(sent.key.id, Buffer.from(proto.Message.encode(sent.message).finish()))
      this.emit('sent', sent.key.id)
    }
    return sent
  }

  lookupSent(id) {
    const buf = id && store.getSentMessage(id)
    return buf ? proto.Message.decode(buf) : undefined
  }

  // Resolves the real phone number of a chat/participant even when WhatsApp gives us a @lid
  async phoneOf(jid, altJid) {
    for (const j of [altJid, jid]) {
      if (j && /@s\.whatsapp\.net$/.test(j)) return bareJid(j).split('@')[0]
    }
    if (jid?.endsWith('@lid')) {
      try {
        const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID(jid)
        if (pn) return bareJid(pn).split('@')[0]
      } catch (err) {
        logger.debug({ err: err.message, jid }, 'lid lookup failed')
      }
    }
    return null
  }

  retryCounterStore() {
    const map = this.retryCounter
    return {
      get: (k) => map.get(k),
      set: (k, v) => map.set(k, v),
      del: (k) => map.delete(k),
      flushAll: () => map.clear(),
    }
  }
}

// "972501234567:12@s.whatsapp.net" -> "972501234567@s.whatsapp.net"
export function bareJid(jid) {
  if (!jid) return jid
  const [user, server] = jid.split('@')
  return `${user.split(':')[0]}@${server}`
}

export const wa = new WhatsApp()
