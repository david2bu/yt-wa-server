import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, extensionFor, isCancel, kindFor } from '../src/parse.js'
import { normalizePhone } from '../src/config.js'

test('parseCommand', () => {
  assert.deepEqual(parseCommand('!סטטוס now'), { cmd: 'סטטוס', args: ['now'], rest: 'now' })
  assert.deepEqual(parseCommand('!עזרה'), { cmd: 'עזרה', args: [], rest: '' })
  assert.equal(parseCommand('hello'), null)
})

test('normalizePhone', () => {
  assert.equal(normalizePhone('050-123-4567'), '972501234567')
  assert.equal(normalizePhone('+972 50 123 4567'), '972501234567')
  assert.equal(normalizePhone('00972501234567'), '972501234567')
})

test('extensionFor / kindFor / isCancel', () => {
  assert.equal(extensionFor('application/pdf', 'דוח.PDF'), 'pdf')
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(extensionFor(undefined), 'bin')
  assert.equal(kindFor('image/jpeg'), 'image')
  assert.equal(kindFor('video/mp4'), 'video')
  assert.equal(kindFor('application/zip'), 'document')
  assert.ok(isCancel(' ביטול '))
})
