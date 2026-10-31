// Videos and images must be posted with a thumbnail, or WhatsApp shows a blank box with a download button.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bot-media-'))
process.env.DATA_DIR = dir
process.env.LOG_LEVEL = 'silent'
const { contentFor } = await import('../src/queue.js')

const video = path.join(dir, 'v.mp4')
const image = path.join(dir, 'i.png')
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-t', '4', '-pix_fmt', 'yuv420p', video])
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', image])
const isJpeg = (b64) => Buffer.from(b64, 'base64').subarray(0, 2).toString('hex') === 'ffd8'

test('video from the website gets a generated thumbnail, size and duration', async () => {
  const c = await contentFor({ kind: 'video', path: video, mimetype: 'video/mp4' })
  assert.ok(isJpeg(c.jpegThumbnail))
  assert.ok(Buffer.from(c.jpegThumbnail, 'base64').length < 20_000)
  assert.equal(c.width, 1280)
  assert.equal(c.height, 720)
  assert.equal(c.seconds, 4)
})

test('image from the website gets a generated thumbnail', async () => {
  const c = await contentFor({ kind: 'image', path: image, mimetype: 'image/png' })
  assert.ok(isJpeg(c.jpegThumbnail))
  assert.equal(c.width, 800)
  assert.equal(c.seconds, undefined)
})

test("video from a customer keeps the phone's own thumbnail", async () => {
  const phoneThumb = Buffer.from([0xff, 0xd8, 1, 2, 3]).toString('base64')
  const c = await contentFor({ kind: 'video', path: video, thumb: phoneThumb, width: 720, height: 1280, seconds: 136 })
  assert.equal(c.jpegThumbnail, phoneThumb)
  assert.deepEqual([c.width, c.height, c.seconds], [720, 1280, 136])
})
