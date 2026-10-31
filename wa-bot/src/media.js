import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from './logger.js'

const run = promisify(execFile)

/**
 * Preview data WhatsApp needs to show media as a picture instead of a blank box
 * with a download button: a small JPEG thumbnail, the dimensions and (for video) the duration.
 * Used when the post didn't come with WhatsApp's own thumbnail (e.g. uploads from the website).
 * Uses ffmpeg/ffprobe; if they fail the file is still sent, just without a preview.
 */

async function probe(file) {
  const out = {}
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
    ])
    const info = JSON.parse(stdout)
    const s = info.streams?.[0]
    if (s?.width && s?.height) Object.assign(out, { width: s.width, height: s.height })
    const seconds = Math.round(Number(info.format?.duration))
    if (seconds > 0) out.seconds = seconds
  } catch (err) {
    logger.warn({ file, err: err.message }, 'ffprobe failed')
  }
  return out
}

// One frame, scaled to a small JPEG, base64. yuvj420p keeps older ffmpeg's mjpeg encoder happy.
async function thumbnail(file, seekSeconds) {
  try {
    const { stdout } = await run('ffmpeg', [
      '-v', 'error', ...(seekSeconds ? ['-ss', String(seekSeconds)] : []), '-i', file, '-frames:v', '1',
      '-vf', 'scale=160:-2:flags=bilinear,format=yuvj420p', '-q:v', '8', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024 })
    if (stdout.length) return stdout.toString('base64')
  } catch (err) {
    logger.warn({ file, err: err.message }, 'thumbnail failed')
  }
  return undefined
}

export async function videoPreview(file) {
  const out = await probe(file)
  // a frame from 1s in (the very first frame is often black)
  out.jpegThumbnail = await thumbnail(file, out.seconds > 2 ? 1 : 0)
  if (!out.jpegThumbnail) delete out.jpegThumbnail
  return out
}

export async function imagePreview(file) {
  const { width, height } = await probe(file)
  const out = width && height ? { width, height } : {}
  const thumb = await thumbnail(file, 0)
  if (thumb) out.jpegThumbnail = thumb
  return out
}
