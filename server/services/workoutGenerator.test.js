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

// ── Pull-slot fallback ladder & bench-dependency filter ─────────────────────
// These run the real buildDaySkeletons() against the real exercise library, because
// both bugs they cover are entirely about what the library does and doesn't contain —
// a mocked pool would just re-encode today's assumptions. Skipped automatically when
// no database is reachable (e.g. CI without DATABASE_URL), so `npm test` still
// passes offline; the pure-function tests above always run.

import path from 'node:path'
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
  'Benches': [],
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

function resolveHasBench(list) {
  return list.includes('Benches') || list.includes('Full Gym')
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
  const hasBench = resolveHasBench(equipment)
  const difficulty = FITNESS_LEVEL_MAP[level]
  const isBeginner = difficulty === 'beginner'
  const injuryFlags = getInjuryFlags(null, null)
  return buildDaySkeletons(p, {
    daysPerWeek,
    sessionLength: '45 minutes',
    equipmentList,
    hasBench,
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

// The equipment/difficulty pairs that previously risked losing the pull slot
// entirely (buildDaySkeletons logged a console.error and `continue`d with no
// fallback, because the old fallback only fired for equipment === exactly
// ['body only']), plus control cases that must keep working unchanged. Every case
// here must never drop its pull slot regardless of what the live library currently
// contains for that equipment/difficulty — that's the actual regression fillPullSlot
// exists to prevent. Whether a given case still needs the fallback ladder depends on
// what's in the library right now (e.g. a single equipment-matched row can make
// normal selection succeed on its own), so this suite doesn't hardcode which cases
// must be flagged — only that a slot is never silently skipped, and that IF a
// fallback did run, it correctly reports itself to the coach.
const PULL_FALLBACK_CASES = [
  { equipment: ['Resistance Bands'], level: 'Beginner' },
  { equipment: ['Resistance Bands'], level: 'Intermediate' },
  { equipment: ['Resistance Bands'], level: 'Advanced' },
  { equipment: ['Resistance bands'], level: 'Beginner' },
  { equipment: ['Resistance bands'], level: 'Intermediate' },
  { equipment: ['Resistance bands', 'Body Weight'], level: 'Beginner' },
  { equipment: ['Resistance bands', 'Body Weight'], level: 'Intermediate' },
  { equipment: ['Kettlebell'], level: 'Beginner' },
  { equipment: ['Kettlebell', 'Body Weight'], level: 'Beginner' },
  { equipment: ['Dumbbells'], level: 'Intermediate' },
  { equipment: ['Full Gym'], level: 'Intermediate' },
  { equipment: ['Body Weight'], level: 'Beginner' },
]

for (const { equipment, level } of PULL_FALLBACK_CASES) {
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
      // Paired invariant, regardless of whether this particular case happened to
      // need the ladder: a fallback reason always carries a coach-facing note
      // (except the deliberately-unflagged bodyweight-only tier-3 case), and never
      // the other way around.
      if (pullSlot.pullFallbackReason) {
        assert.ok(pullSlot.pullVarietyFlag, `day ${day.day_index + 1} set pullFallbackReason but no coach-facing note text`)
      }
    }
    assert.ok(pull >= push, `push/pull ratio violated: ${push} push vs ${pull} pull`)
  })
}

// Confirmed (via the live library, see the console.warn trail when this suite runs)
// to actually walk the fallback ladder's tier 1: Kettlebell/Beginner has no
// beginner-difficulty kettlebell pull row, so pickExercise's normal attempts are
// exhausted and fillPullSlot relaxes difficulty. Asserted explicitly (not just as
// part of the "never dropped" sweep above) because this is the exact bug scenario
// from the original report — a client whose only equipment-matched pull needed a
// relaxed constraint must come back flagged, not silently substituted.
const KETTLEBELL_BEGINNER_FALLBACK_CASES = [
  ['Kettlebell'],
  ['Kettlebell', 'Body Weight'],
]

for (const equipment of KETTLEBELL_BEGINNER_FALLBACK_CASES) {
  test(`buildDaySkeletons flags the tier-1 difficulty-relaxed pull fallback for ${equipment.join(' + ')} / Beginner`, async (t) => {
    const p = await getPool()
    if (!p) return t.skip('no reachable database')
    const days = await buildSkeletonsFor(p, equipment, 'Beginner')
    for (const day of days) {
      const pull = day.slots.find(s => s.quotaSlot === 'upper_pull')
      assert.equal(pull.pullFallbackReason, 'pull_fallback_difficulty_relaxed', `day ${day.day_index + 1}: expected a difficulty-relaxed fallback, got ${pull.pullFallbackReason}`)
      assert.ok(pull.pullVarietyFlag, `day ${day.day_index + 1} set no coach-facing note text`)
    }
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

// ── Bench-dependency filter ──────────────────────────────────────────────────

test('buildDaySkeletons never selects a requires_bench exercise without bench access', async (t) => {
  const p = await getPool()
  if (!p) return t.skip('no reachable database')
  const days = await buildSkeletonsFor(p, ['Dumbbells'], 'Intermediate')
  const usedIds = days.flatMap(d => d.slots.map(s => s.exercise_id)).filter(id => id != null)
  if (!usedIds.length) return
  const { rows } = await p.query(`SELECT id, name FROM exercises WHERE id = ANY($1) AND requires_bench = TRUE`, [usedIds])
  assert.deepEqual(rows, [], `client with no bench was handed requires_bench exercise(s): ${rows.map(r => r.name).join(', ')}`)
})

test('buildDaySkeletons can select a requires_bench exercise once the client has one', async (t) => {
  const p = await getPool()
  if (!p) return t.skip('no reachable database')
  // Run several times — selection is random within the matching pool, so a single
  // run could land on a non-bench row by chance even when bench rows are available.
  let sawBenchExercise = false
  for (let i = 0; i < 10 && !sawBenchExercise; i++) {
    const days = await buildSkeletonsFor(p, ['Dumbbells', 'Benches'], 'Intermediate')
    const usedIds = days.flatMap(d => d.slots.map(s => s.exercise_id)).filter(id => id != null)
    if (!usedIds.length) continue
    const { rows } = await p.query(`SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND requires_bench = TRUE`, [usedIds])
    if (rows[0].c > 0) sawBenchExercise = true
  }
  assert.ok(sawBenchExercise, 'client with a bench never once selected a requires_bench exercise across 10 runs')
})

test.after(async () => {
  if (pool) await pool.end()
})
