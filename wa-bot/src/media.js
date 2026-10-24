import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from './logger.js'

const run = promisify(execFile)

/**
 * Preview data WhatsApp needs to show a video as a playable picture instead of a blank box
 * with a download button: a small JPEG thumbnail, the dimensions and the duration.
 * Uses ffmpeg/ffprobe; if they fail the video is still sent, just without a preview.
 */
export async function videoPreview(file) {
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
  try {
    // a frame from 1s in (the very first frame is often black), scaled down, as JPEG on stdout
    const at = out.seconds > 2 ? '1' : '0'
    const { stdout } = await run('ffmpeg', [
      '-v', 'error', '-ss', at, '-i', file, '-frames:v', '1',
      '-vf', 'scale=240:-2', '-q:v', '6', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024 })
    if (stdout.length) out.jpegThumbnail = stdout.toString('base64')
  } catch (err) {
    logger.warn({ file, err: err.message }, 'video thumbnail failed')
  }
  return out
}
