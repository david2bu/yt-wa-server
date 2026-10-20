// Pure helpers for reading what the user typed - kept separate so they're easy to test.

const ALL = ['הכל', 'הכול', 'כולם', 'all', '*']
const CANCEL = ['ביטול', 'בטל', 'cancel', 'stop']

export const isCancel = (text) => CANCEL.includes(text.trim().toLowerCase())

/**
 * "1" | "1,3" | "1 3 5" | "2-4" | "הכל" -> array of 0-based indexes, or null if it isn't a selection.
 * Out-of-range numbers make the whole selection invalid (returns { invalid: [...] }).
 */
export function parseSelection(text, count) {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (ALL.includes(t)) return { indexes: [...Array(count).keys()] }
  if (!/^[\d\s,\-–]+$/.test(t)) return null

  const picked = new Set()
  const invalid = []
  for (const part of t.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)[-–](\d+)$/)
    const [from, to] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)]
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null
    for (let n = Math.min(from, to); n <= Math.max(from, to); n++) {
      if (n < 1 || n > count) invalid.push(n)
      else picked.add(n - 1)
    }
  }
  if (invalid.length) return { invalid }
  return picked.size ? { indexes: [...picked].sort((a, b) => a - b) } : null
}

export const looksLikeSelection = (text) => /^[\d\s,\-–]+$/.test(text.trim()) || ALL.includes(text.trim().toLowerCase())

// "!אשר 0501234567 1,2" -> { cmd: 'אשר', args: ['0501234567', '1,2'] }
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
