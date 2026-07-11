/**
 * seed-main-lifts.js — seeds a temporary, hand-picked main_lift catalog into
 * `exercise_library`. Companion to seed-exercise-library.js, which explicitly
 * skipped main_lift because the Programming Guide names the 8 movement
 * patterns but gives no actual lift names to seed (see that script's
 * checkMainLifts()).
 *
 * This list stands in for a fuller main_lift catalog until the guide's real
 * main-lift section is transcribed. Each row is tagged with a real
 * movement_pattern value so it lines up with program_day_patterns, but the
 * assembly-side lookup (server/services/workoutAssembly/mainLifts.js) still
 * matches by name against a hardcoded temp list rather than querying by
 * movement_pattern directly — see the TODO there for why.
 *
 * Usage:
 *   node server/scripts/seed-main-lifts.js
 *
 * Idempotent — safe to re-run. Upserts on (name, source_program).
 */

import 'dotenv/config'
import { migrate, pool } from '../db.js'

const SOURCE = 'Main Lifts (temp)'

const lift = (name, movement_pattern, equipment, opts = {}) => ({
  name, category: 'main_lift', movement_pattern,
  equipment_required: equipment, source_program: SOURCE,
  level_min: 'beginner', unilateral: false, ...opts,
})

const MAIN_LIFTS = [
  // squat
  lift('Barbell Back Squat', 'squat', ['barbell']),
  lift('Front Squat', 'squat', ['barbell']),
  lift('Goblet Squat', 'squat', ['dumbbell']),
  lift('Bodyweight Squat', 'squat', ['bodyweight']),
  lift('Split Squat', 'squat', ['bodyweight'], { unilateral: true }),
  lift('Pistol Squat Progression', 'squat', ['bodyweight'], { unilateral: true, level_min: 'intermediate' }),

  // hinge
  lift('Conventional Deadlift', 'hinge', ['barbell']),
  lift('Romanian Deadlift', 'hinge', ['barbell']),
  lift('Trap Bar Deadlift', 'hinge', ['trap_bar']),
  lift('Single-Leg RDL', 'hinge', ['bodyweight'], { unilateral: true }),
  lift('Glute Bridge', 'hinge', ['bodyweight']),
  lift('Nordic Curl Regression', 'hinge', ['bodyweight'], { level_min: 'intermediate' }),

  // horizontal_push
  lift('Barbell Bench Press', 'horizontal_push', ['barbell']),
  lift('Dumbbell Bench Press', 'horizontal_push', ['dumbbell']),
  lift('Push-up', 'horizontal_push', ['bodyweight']),

  // horizontal_pull
  lift('Barbell Row', 'horizontal_pull', ['barbell']),
  lift('Dumbbell Row', 'horizontal_pull', ['dumbbell'], { unilateral: true }),
  lift('Seated Cable Row', 'horizontal_pull', ['cable']),
  lift('Inverted Row', 'horizontal_pull', ['bodyweight']),

  // vertical_push
  lift('Overhead Press', 'vertical_push', ['barbell']),
  lift('Dumbbell Shoulder Press', 'vertical_push', ['dumbbell']),

  // vertical_pull
  lift('Pull-up', 'vertical_pull', ['bodyweight']),
  lift('Lat Pulldown', 'vertical_pull', ['cable']),

  // carry
  lift("Farmer's Carry", 'carry', ['dumbbell']),
  lift('Suitcase Carry', 'carry', ['dumbbell'], { unilateral: true }),

  // lift (Turkish get-up style)
  lift('Turkish Get-up', 'lift', ['kettlebell'], { unilateral: true, level_min: 'intermediate' }),
  lift('Kettlebell Clean and Press', 'lift', ['kettlebell'], { unilateral: true, level_min: 'intermediate' }),
]

async function run() {
  await migrate()

  const byPattern = MAIN_LIFTS.reduce((acc, e) => {
    acc[e.movement_pattern] = (acc[e.movement_pattern] ?? 0) + 1
    return acc
  }, {})
  console.log('Main lift movement_pattern distribution:', JSON.stringify(byPattern, null, 2))
  console.log('Total rows to seed:', MAIN_LIFTS.length)

  let inserted = 0
  let updated = 0
  for (const e of MAIN_LIFTS) {
    const { rows } = await pool.query(
      `INSERT INTO exercise_library
         (name, category, movement_pattern, equipment_required, level_min, unilateral, source_program)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (name, source_program) DO UPDATE SET
         category           = EXCLUDED.category,
         movement_pattern    = EXCLUDED.movement_pattern,
         equipment_required  = EXCLUDED.equipment_required,
         level_min           = EXCLUDED.level_min,
         unilateral          = EXCLUDED.unilateral
       RETURNING (xmax = 0) AS inserted`,
      [e.name, e.category, e.movement_pattern, e.equipment_required, e.level_min, e.unilateral, e.source_program],
    )
    if (rows[0].inserted) inserted++
    else updated++
  }

  console.log(`\nDone — ${inserted} inserted, ${updated} updated, ${MAIN_LIFTS.length} total.`)

  const byCat = await pool.query(
    `SELECT movement_pattern, COUNT(*) FROM exercise_library WHERE category = 'main_lift' GROUP BY movement_pattern ORDER BY movement_pattern`,
  )
  console.log('main_lift row counts by movement_pattern:', JSON.stringify(byCat.rows))

  await pool.end()
}

run().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
