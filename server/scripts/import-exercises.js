/**
 * import-exercises.js — seeds the `exercises` table from free-exercise-db
 * (https://github.com/yuhonas/free-exercise-db, MIT-style license, public domain data).
 *
 * Usage:
 *   node server/scripts/import-exercises.js
 *
 * Idempotent — safe to re-run. Upserts on (name, source='seed'), so re-running
 * after a dataset update refreshes existing rows instead of duplicating them.
 */

import 'dotenv/config'
import { migrate, pool } from '../db.js'

const SOURCE_JSON_URL = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json'
const IMAGE_BASE_URL  = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/'

// ── Movement-pattern classification ─────────────────────────────────────────
// Judgment-based heuristics over force / mechanic / category / primaryMuscles /
// name. Every exercise lands in exactly one of the ten patterns; nothing is
// skipped — anything that doesn't clearly fit lower/upper/core/carry/mobility
// falls into 'conditioning' as a catch-all (cardio, plyometrics, olympic lifts,
// strongman, odd full-body/neck movements).

const LOWER_MUSCLES       = ['quadriceps', 'hamstrings', 'glutes', 'calves', 'abductors', 'adductors']
const UPPER_PUSH_MUSCLES  = ['chest', 'shoulders', 'triceps']
const UPPER_PULL_MUSCLES  = ['lats', 'middle back', 'lower back', 'traps', 'biceps', 'forearms']

const UNILATERAL_RE = /\b(single[- ]?(leg|arm|limb)|one[- ]?(leg|arm)|alternating|split[- ]?squat|bulgarian|step[- ]?up|pistol|lunge|walking lunge)\b/i
const CARRY_RE       = /\b(carry|farmer'?s?|suitcase|yoke walk|waiter'?s? walk)\b/i
const HINGE_RE       = /\b(deadlift|rdl|romanian|good[- ]?morning|hip thrust|glute bridge|kettlebell swing|\bswing\b|hyperextension|back extension|pull[- ]?through)\b/i
const SQUAT_RE       = /\b(squat|lunge|step[- ]?up|leg press|pistol|split squat)\b/i
const UPPER_PUSH_RE  = /\b(press|push[- ]?up|dip|push[- ]?down|fly|flye)\b/i
const UPPER_PULL_RE  = /\b(row|pull[- ]?up|pull[- ]?down|chin[- ]?up|curl|shrug|face pull|lat pulldown)\b/i
const CORE_RE        = /\b(sit[- ]?up|crunch|plank|russian twist|leg raise|ab wheel|hollow|v[- ]?up|mountain climber|dead ?bug|bird ?dog)\b/i

function classify(ex) {
  const name    = ex.name.toLowerCase()
  const primary = (ex.primaryMuscles || []).map(m => m.toLowerCase())
  const category = (ex.category || '').toLowerCase()
  const force     = (ex.force || '').toLowerCase()

  const isUnilateral = UNILATERAL_RE.test(name)

  // 1. Mobility — stretches
  if (category === 'stretching') {
    return { movement_pattern: 'mobility', is_unilateral: isUnilateral }
  }

  // 2. Carries
  if (CARRY_RE.test(name)) {
    return { movement_pattern: 'carry', is_unilateral: isUnilateral }
  }

  // 3. Core
  if (primary.includes('abdominals') || CORE_RE.test(name)) {
    return { movement_pattern: 'core', is_unilateral: isUnilateral }
  }

  // 4. Lower body — squat vs hinge
  const lowerHit = primary.some(m => LOWER_MUSCLES.includes(m))
  if (lowerHit || SQUAT_RE.test(name) || HINGE_RE.test(name)) {
    const hinge = HINGE_RE.test(name) || (!SQUAT_RE.test(name) && ['hamstrings', 'glutes'].includes(primary[0]))
    const base  = hinge ? 'hinge' : 'squat'
    return { movement_pattern: `${base}_${isUnilateral ? 'unilateral' : 'bilateral'}`, is_unilateral: isUnilateral }
  }

  // 5. Upper body — push vs pull
  const pushHit = primary.some(m => UPPER_PUSH_MUSCLES.includes(m))
  const pullHit = primary.some(m => UPPER_PULL_MUSCLES.includes(m))
  if (pushHit || pullHit || UPPER_PUSH_RE.test(name) || UPPER_PULL_RE.test(name)) {
    let pattern
    if (pushHit && !pullHit) pattern = 'upper_push'
    else if (pullHit && !pushHit) pattern = 'upper_pull'
    else if (force === 'push') pattern = 'upper_push'
    else if (force === 'pull') pattern = 'upper_pull'
    else if (UPPER_PUSH_RE.test(name)) pattern = 'upper_push'
    else pattern = 'upper_pull'
    return { movement_pattern: pattern, is_unilateral: isUnilateral }
  }

  // 6. Conditioning fallback — cardio, plyometrics, olympic lifts, strongman,
  //    and anything else that didn't match a body-region signal (e.g. neck).
  return { movement_pattern: 'conditioning', is_unilateral: isUnilateral }
}

// ── Field mapping ────────────────────────────────────────────────────────────

const LEVEL_TO_DIFFICULTY = { beginner: 'beginner', intermediate: 'intermediate', expert: 'advanced' }

function mapExercise(ex) {
  const { movement_pattern, is_unilateral } = classify(ex)
  return {
    name:              ex.name,
    movement_pattern,
    is_unilateral,
    primary_muscles:   ex.primaryMuscles ?? [],
    secondary_muscles: ex.secondaryMuscles ?? [],
    equipment:         ex.equipment ?? null,
    difficulty:        LEVEL_TO_DIFFICULTY[ex.level] ?? ex.level ?? null,
    image_url:         ex.images?.[0] ? `${IMAGE_BASE_URL}${ex.images[0]}` : null,
    instructions:      (ex.instructions ?? []).join('\n'),
  }
}

// ── Import ───────────────────────────────────────────────────────────────────

async function run() {
  await migrate()

  console.log(`Fetching ${SOURCE_JSON_URL} ...`)
  const res = await fetch(SOURCE_JSON_URL)
  if (!res.ok) throw new Error(`Failed to fetch exercises.json: ${res.status} ${res.statusText}`)
  const raw = await res.json()
  console.log(`Fetched ${raw.length} exercises`)

  const mapped = raw.map(mapExercise)

  const distribution = mapped.reduce((acc, e) => {
    acc[e.movement_pattern] = (acc[e.movement_pattern] ?? 0) + 1
    return acc
  }, {})
  console.log('Movement pattern distribution:', distribution)
  console.log('Unilateral count:', mapped.filter(e => e.is_unilateral).length, '/', mapped.length)

  let inserted = 0
  let updated  = 0
  for (const e of mapped) {
    const { rows } = await pool.query(
      `INSERT INTO exercises
         (name, movement_pattern, is_unilateral, primary_muscles, secondary_muscles,
          equipment, difficulty, image_url, instructions, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')
       ON CONFLICT (name, source) DO UPDATE SET
         movement_pattern  = EXCLUDED.movement_pattern,
         is_unilateral     = EXCLUDED.is_unilateral,
         primary_muscles   = EXCLUDED.primary_muscles,
         secondary_muscles = EXCLUDED.secondary_muscles,
         equipment         = EXCLUDED.equipment,
         difficulty        = EXCLUDED.difficulty,
         image_url         = EXCLUDED.image_url,
         instructions      = EXCLUDED.instructions
       RETURNING (xmax = 0) AS inserted`,
      [e.name, e.movement_pattern, e.is_unilateral, e.primary_muscles, e.secondary_muscles,
       e.equipment, e.difficulty, e.image_url, e.instructions],
    )
    if (rows[0].inserted) inserted++
    else updated++
  }

  console.log(`Done — ${inserted} inserted, ${updated} updated, ${mapped.length} total (source='seed')`)
  await pool.end()
}

run().catch(err => {
  console.error('Import failed:', err)
  process.exit(1)
})
