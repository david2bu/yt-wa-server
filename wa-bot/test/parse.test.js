import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSelection, parseCommand, extensionFor, isCancel } from '../src/parse.js'
import { normalizePhone } from '../src/config.js'

test('parseSelection', () => {
  assert.deepEqual(parseSelection('1', 3), { indexes: [0] })
  assert.deepEqual(parseSelection('3, 1', 3), { indexes: [0, 2] })
  assert.deepEqual(parseSelection('1 2', 3), { indexes: [0, 1] })
  assert.deepEqual(parseSelection('2-3', 3), { indexes: [1, 2] })
  assert.deepEqual(parseSelection('הכל', 2), { indexes: [0, 1] })
  assert.deepEqual(parseSelection('4', 3), { invalid: [4] })
  assert.equal(parseSelection('שלום', 3), null)
  assert.equal(parseSelection('', 3), null)
})

test('parseCommand', () => {
  assert.deepEqual(parseCommand('!אשר 0501234567 1,2'), { cmd: 'אשר', args: ['0501234567', '1,2'], rest: '0501234567 1,2' })
  assert.deepEqual(parseCommand('!עזרה'), { cmd: 'עזרה', args: [], rest: '' })
  assert.equal(parseCommand('hello'), null)
})

test('normalizePhone', () => {
  assert.equal(normalizePhone('050-123-4567'), '972501234567')
  assert.equal(normalizePhone('+972 50 123 4567'), '972501234567')
  assert.equal(normalizePhone('00972501234567'), '972501234567')
})

test('extensionFor / isCancel', () => {
  assert.equal(extensionFor('application/pdf', 'דוח.PDF'), 'pdf')
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(extensionFor(undefined), 'bin')
  assert.ok(isCancel(' ביטול '))
})
