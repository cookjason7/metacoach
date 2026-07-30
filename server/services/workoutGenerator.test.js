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

// ── Pull-slot fallback ladder ────────────────────────────────────────────────
// These run the real buildDaySkeletons() against the real exercise library, because
// the bug they cover is entirely about what the library does and doesn't contain —
// a mocked pool would just re-encode today's assumptions. Skipped automatically when
// no database is reachable (e.g. CI without DATABASE_URL), so `npm test` still
// passes offline; the pure-function tests above always run.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildDaySkeletons,
  buildBlockedNamePattern,
  shouldPreferBilateral,
  getInjuryFlags,
} from './workoutGenerator.js'

const EQUIPMENT_MAP = {
  'Kettlebell': ['kettlebells'],
  'Dumbbells': ['dumbbell'],
  'Body Weight': ['body only'],
  'Resistance Bands': ['bands'],
  'Resistance bands': ['bands', 'body only'],
  'Full Gym': null,
}
const FITNESS_LEVEL_MAP = { Beginner: 'beginner', Intermediate: 'intermediate', Advanced: 'advanced' }

function resolveEquipmentList(list) {
  if (!list.length || list.includes('Full Gym')) return null
  const set = new Set()
  for (const eq of list) for (const m of EQUIPMENT_MAP[eq] ?? []) set.add(m)
  return set.size ? [...set] : null
}

let pool = null
async function getPool() {
  if (pool !== null) return pool
  try {
    const dotenv = (await import('dotenv')).default
    dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') })
    if (!process.env.DATABASE_URL) return (pool = false)
    const pg = (await import('pg')).default
    const p = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    })
    await p.query('SELECT 1 FROM exercises LIMIT 1')
    return (pool = p)
  } catch {
    return (pool = false)
  }
}

/** Runs the real skeleton builder exactly as generateWorkoutPlan would. */
async function buildSkeletonsFor(p, equipment, level, daysPerWeek = 3) {
  const equipmentList = resolveEquipmentList(equipment)
  const difficulty = FITNESS_LEVEL_MAP[level]
  const isBeginner = difficulty === 'beginner'
  const injuryFlags = getInjuryFlags(null, null)
  return buildDaySkeletons(p, {
    daysPerWeek,
    sessionLength: '45 minutes',
    equipmentList,
    difficulty,
    preferBilateral: shouldPreferBilateral({ fitnessLevel: level }),
    excludeNamePattern: buildBlockedNamePattern({ isBeginner, injuryFlags, equipmentList, fitnessLevel: level }),
    levelRelaxedExcludeNamePattern: buildBlockedNamePattern({ isBeginner, injuryFlags, equipmentList, fitnessLevel: level, omitFitnessLevelBlocks: true }),
    strictDifficulty: isBeginner,
    isBeginner,
    injuryFlags,
    includeSuperset: false,
    fitnessLevel: level,
  })
}

// The 9 equipment/difficulty pairs that previously lost the pull slot entirely
// (buildDaySkeletons logged a console.error and `continue`d with no fallback,
// because the old fallback only fired for equipment === exactly ['body only']),
// plus control cases that must keep working unchanged.
const PULL_FALLBACK_CASES = [
  { equipment: ['Resistance Bands'], level: 'Beginner', expectFlag: true },
  { equipment: ['Resistance Bands'], level: 'Intermediate', expectFlag: true },
  { equipment: ['Resistance Bands'], level: 'Advanced', expectFlag: true },
  { equipment: ['Resistance bands'], level: 'Beginner', expectFlag: true },
  { equipment: ['Resistance bands'], level: 'Intermediate', expectFlag: true },
  { equipment: ['Resistance bands', 'Body Weight'], level: 'Beginner', expectFlag: true },
  { equipment: ['Resistance bands', 'Body Weight'], level: 'Intermediate', expectFlag: true },
  { equipment: ['Kettlebell'], level: 'Beginner', expectFlag: true },
  { equipment: ['Kettlebell', 'Body Weight'], level: 'Beginner', expectFlag: true },
  // Controls — these always worked and must not regress. Bodyweight-only in
  // particular must stay UNflagged: a no-equipment substitute is the right answer
  // for that client, not a mismatch worth a coach's attention.
  { equipment: ['Dumbbells'], level: 'Intermediate', expectFlag: false },
  { equipment: ['Full Gym'], level: 'Intermediate', expectFlag: false },
  { equipment: ['Body Weight'], level: 'Beginner', expectFlag: false },
]

for (const { equipment, level, expectFlag } of PULL_FALLBACK_CASES) {
  const label = `${equipment.join(' + ')} / ${level}`
  test(`buildDaySkeletons fills a real pull exercise every day for ${label}`, async (t) => {
    const p = await getPool()
    if (!p) return t.skip('no reachable database')

    const days = await buildSkeletonsFor(p, equipment, level)
    let push = 0
    let pull = 0
    for (const day of days) {
      const pullSlot = day.slots.find(s => s.quotaSlot === 'upper_pull')
      const pushSlot = day.slots.find(s => s.quotaSlot === 'upper_push')
      if (pushSlot) push++
      assert.ok(pullSlot, `day ${day.day_index + 1} dropped its pull slot`)
      assert.equal(typeof pullSlot.name, 'string')
      assert.ok(pullSlot.name.trim().length > 0, `day ${day.day_index + 1} pull slot has no exercise name`)
      pull++
      if (expectFlag) {
        assert.ok(
          pullSlot.pullFallbackReason,
          `day ${day.day_index + 1} used a fallback pull but set no coach-facing flag_reason`,
        )
        assert.ok(pullSlot.pullVarietyFlag, `day ${day.day_index + 1} set no coach-facing note text`)
      }
    }
    assert.ok(pull >= push, `push/pull ratio violated: ${push} push vs ${pull} pull`)
  })
}

test('buildDaySkeletons never hands a beginner a ballistic high pull', async (t) => {
  const p = await getPool()
  if (!p) return t.skip('no reachable database')
  // Kettlebell + beginner is the case that reaches fallback tier 1 (difficulty
  // relaxed, name blocks intact) — the relaxation must not open the door to
  // 'Kettlebell Sumo High Pull', which the beginner block list now names.
  for (const equipment of [['Kettlebell'], ['Kettlebell', 'Body Weight']]) {
    const days = await buildSkeletonsFor(p, equipment, 'Beginner')
    for (const day of days) {
      const pull = day.slots.find(s => s.quotaSlot === 'upper_pull')
      assert.doesNotMatch(pull.name, /high pull|swing|clean/i, `beginner got "${pull.name}"`)
    }
  }
})

test('buildDaySkeletons leaves a bodyweight-only client unflagged', async (t) => {
  const p = await getPool()
  if (!p) return t.skip('no reachable database')
  const days = await buildSkeletonsFor(p, ['Body Weight'], 'Beginner')
  for (const day of days) {
    const pull = day.slots.find(s => s.quotaSlot === 'upper_pull')
    assert.equal(pull.pullFallbackReason, null, `bodyweight-only client flagged with ${pull.pullFallbackReason}`)
  }
})

test.after(async () => {
  if (pool) await pool.end()
})
