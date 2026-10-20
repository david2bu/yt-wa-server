// Pure helpers for reading what people typed - kept separate so they're easy to test.

const CANCEL = ['ביטול', 'בטל', 'cancel', 'stop']

export const isCancel = (text) => CANCEL.includes(text.trim().toLowerCase())

// "!סטטוס now" -> { cmd: 'סטטוס', args: ['now'], rest: 'now' }
export function parseCommand(text) {
  const m = text.trim().match(/^[!/](\S+)\s*([\s\S]*)$/)
  if (!m) return null
  return { cmd: m[1].toLowerCase(), args: m[2].trim() ? m[2].trim().split(/\s+/) : [], rest: m[2].trim() }
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
  'application/pdf': 'pdf',
}

export function extensionFor(mimetype, filename) {
  const fromName = filename?.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  if (fromName) return fromName.toLowerCase()
  const base = (mimetype || '').split(';')[0].trim()
  return MIME_EXT[base] || base.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
}

export function kindFor(mimetype) {
  const m = (mimetype || '').toLowerCase()
  if (m.startsWith('image/') && m !== 'image/gif' && m !== 'image/svg+xml') return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}
