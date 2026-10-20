import http from 'node:http'
import QRCode from 'qrcode'
import { config } from './config.js'
import { logger } from './logger.js'
import * as store from './db.js'
import { wa } from './whatsapp.js'

const STATE_TEXT = {
  starting: 'מתחיל…',
  connecting: 'מתחבר…',
  qr: 'ממתין לסריקת QR',
  open: 'מחובר ✅',
  closed: 'מתחבר מחדש…',
  logged_out: 'נותק מהטלפון, ממתין ל-QR חדש',
  banned: 'WhatsApp חסם את החשבון זמנית (403)',
}

const page = (body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">
<title>WA Bot</title><style>
body{font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;text-align:center;box-shadow:0 2px 12px #0001}
img{width:100%;max-width:320px}.code{font-size:32px;letter-spacing:4px;font-weight:700}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}.card{background:#27272a}}
</style></head><body><div class="card">${body}</div></body></html>`

export function startWeb() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')

    if (url.pathname === '/health') {
      // 200 only when actually connected, so uptime monitors can alert on it
      res.writeHead(wa.connected ? 200 : 503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ state: wa.state, queue: store.queueStats() }))
    }

    if (url.pathname === '/qr' || url.pathname === '/') {
      if (url.searchParams.get('token') !== config.webToken) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('נדרש token')
      }
      let body = `<h2>${STATE_TEXT[wa.state] || wa.state}</h2>`
      if (wa.state === 'qr' && wa.qr) {
        body += `<p>וואטסאפ ← מכשירים מקושרים ← קישור מכשיר</p><img alt="QR" src="${await QRCode.toDataURL(wa.qr, { margin: 1, width: 320 })}">`
      }
      if (wa.pairingCode) body += `<p>או קוד צימוד:</p><div class="code">${wa.pairingCode}</div>`
      if (wa.connected) body += `<p>${wa.me?.id?.split(':')[0] || ''}</p>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(page(body))
    }

    res.writeHead(404).end()
  })
  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'web status page up')
    if (config.webTokenGenerated) {
      logger.warn(`WEB_TOKEN not set - generated one for this run: ${config.webToken}`)
    }
  })
  return server
}
