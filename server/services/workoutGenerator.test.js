import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeJsonText } from './workoutGenerator.js'

test('sanitizeJsonText replaces a fullwidth comma between JSON array elements', () => {
  const broken = '{"days":[{"day_name":"Day 1"}，{"day_name":"Day 2"}]}'
  const sanitized = sanitizeJsonText(broken)
  assert.doesNotThrow(() => JSON.parse(sanitized))
  const parsed = JSON.parse(sanitized)
  assert.equal(parsed.days.length, 2)
  assert.equal(parsed.days[1].day_name, 'Day 2')
})

test('sanitizeJsonText replaces a fullwidth colon', () => {
  const broken = '{"name"："Katie"}'
  const sanitized = sanitizeJsonText(broken)
  assert.doesNotThrow(() => JSON.parse(sanitized))
  assert.equal(JSON.parse(sanitized).name, 'Katie')
})

test('sanitizeJsonText replaces a fullwidth quotation mark', () => {
  const broken = '{＂name＂:"Katie"}'
  const sanitized = sanitizeJsonText(broken)
  assert.doesNotThrow(() => JSON.parse(sanitized))
  assert.equal(JSON.parse(sanitized).name, 'Katie')
})

test('sanitizeJsonText leaves well-formed JSON completely unchanged', () => {
  const wellFormed = '{"name":"Katie","days":[{"day_name":"Day 1"},{"day_name":"Day 2"}],"notes":"reps: 8-10, rest: 90s"}'
  assert.equal(sanitizeJsonText(wellFormed), wellFormed)
  assert.doesNotThrow(() => JSON.parse(sanitizeJsonText(wellFormed)))
})

test('sanitizeJsonText handles multiple substitutions of the same character', () => {
  const broken = '{"a":1，"b":2，"c":3}'
  const sanitized = sanitizeJsonText(broken)
  const parsed = JSON.parse(sanitized)
  assert.deepEqual(parsed, { a: 1, b: 2, c: 3 })
})
