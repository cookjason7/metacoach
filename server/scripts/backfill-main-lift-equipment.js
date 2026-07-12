/**
 * backfill-main-lift-equipment.js — backfills equipment_required on the 42
 * 'Main Lifts (Movement Pattern Review)' main_lift rows (seed-main-lifts-final.js),
 * which were seeded with equipment_required = '{}' (unset). An empty array
 * trivially satisfies pickMainLift()'s equipment filter, so these rows were
 * silently defeating equipmentMismatch checks for equipment-restricted
 * clients — this closes that gap.
 *
 * Also backfills 2 'Movement Pattern Review — Core' rows (Barbell Ab
 * Rollout, Kettlebell Turkish Get-Up (Lunge style)) — technically
 * category='core', not 'main_lift', but they share the identical empty-
 * equipment_required gap and were included in the source mapping, so
 * they're covered here too for consistency (filterExercises() uses
 * equipment_required the same way for every category).
 *
 * Equipment tokens match the existing lowercase/snake_case convention
 * already used across exercise_library (barbell, dumbbell, kettlebell,
 * cable, trx, bodyweight, ...). Two new tokens are introduced because
 * nothing existing covers them: 'bench' and 'pull_up_bar' (Pull-ups/assisted
 * needs a pull-up bar; no existing exercise required one). 'cable machine'
 * and 'TRX' from the source mapping map onto the ALREADY-existing 'cable'
 * and 'trx' tokens rather than inventing new ones.
 *
 * No OR-group mechanism exists in this schema (equipment_required is a flat
 * TEXT[] checked as "every item must be in the client's equipment" — pure
 * AND/subset, confirmed by inspecting every existing row, all of which have
 * exactly one item). For the 3 "either equipment satisfies it" cases in the
 * source mapping (Goblet Squat, Farmer's Walk, and the barbell/dumbbell part
 * of Lying Triceps Press), only the first-listed option is stored — a known,
 * flagged limitation: e.g. a kettlebell-only client will be (incorrectly)
 * treated as equipment-mismatched for Goblet Squat, which they could
 * actually do. Fixing this for real would require adding OR-group support
 * to the schema/query layer, out of scope here.
 *
 * "Barbell Board Press" (one of the 42 main_lift rows) was missing from the
 * source mapping entirely. Inferred ['barbell', 'bench'] by direct analogy
 * to "BB chest press" -> ['barbell', 'bench'] (Board Press is a barbell
 * bench-press variant) — flagged as inferred, not explicitly given.
 *
 * Usage:
 *   node server/scripts/backfill-main-lift-equipment.js
 *
 * Idempotent — safe to re-run (plain UPDATE by name + source_program).
 */

import 'dotenv/config'
import { pool } from '../db.js'

const MAIN_LIFT_SOURCE = 'Main Lifts (Movement Pattern Review)'
const CORE_SOURCE = 'Movement Pattern Review — Core'

// name -> { equipment, sourceProgram, note? }
const BACKFILL = [
  // -- main_lift (42) --
  ['Alternating Hang Clean', ['barbell']],
  ['Barbell Full Squat', ['barbell']],
  ['Goblet squat', ['dumbbell'], 'either dumbbell or kettlebell satisfies this — first-listed option stored, no OR-group support'],
  ['Barbell Lunge', ['barbell']],
  ['DB Lunge', ['dumbbell']],
  ['Barbell Shoulder Press', ['barbell']],
  ['DB Shoulder Press', ['dumbbell']],
  ['Bent-Arm Barbell Pullover (Vertical Pull)', ['barbell']],
  ['Bent-Arm Barbell Pullover (Vertical Push)', ['barbell']],
  ['Barbell Board Press', ['barbell', 'bench'], 'INFERRED — missing from source mapping, by analogy to BB chest press'],
  ['DB chest press', ['dumbbell', 'bench']],
  ['BB chest press', ['barbell', 'bench']],
  ['KB RDL', ['kettlebell']],
  ['BB RDL', ['barbell']],
  ['Double Kettlebell Push Press', ['kettlebell']],
  ['Double Kettlebell Windmill', ['kettlebell']],
  ['Dumbbell Lying One-Arm Rear Lateral Raise', ['dumbbell', 'bench']],
  ['Dumbbell Rear Lunge', ['dumbbell']],
  ['Elevated Back Lunge', ['dumbbell', 'bench']],
  ["Farmer's Walk", ['dumbbell'], 'either dumbbell or kettlebell satisfies this — first-listed option stored, no OR-group support'],
  ['Pull-ups/assisted', ['pull_up_bar']],
  ['High Cable Curls', ['cable']],
  ['db curls', ['dumbbell']],
  ['Incline Push-Up (Hands on Wall or Counter)', ['bodyweight']],
  ['Kettlebell Figure 8', ['kettlebell']],
  ['Lying Triceps Press', ['barbell', 'bench'], 'barbell or dumbbell either satisfies it — first-listed option stored; bench kept as a hard requirement'],
  ['Modified Glute Bridge', ['bodyweight']],
  ['One-Arm Kettlebell Clean', ['kettlebell']],
  ['One-Arm Kettlebell Floor Press', ['kettlebell']],
  ['One-Arm Kettlebell Swings', ['kettlebell']],
  ['One-Arm Open Palm Kettlebell Clean', ['kettlebell']],
  ['Power Clean from Blocks', ['barbell']],
  ['Single Leg Glute Bridge', ['bodyweight']],
  ['Standing Hip Hinge (Bodyweight Good Morning)', ['bodyweight']],
  ['Standing Modified Squat (Feet Wide, Shallow Depth)', ['bodyweight']],
  ['Sumo Deadlift', ['barbell']],
  ['Suspended Split Squat', ['trx']],
  ['Two-Arm Kettlebell Clean', ['kettlebell']],
  ['Two-Arm Kettlebell Row', ['kettlebell']],
  ['V-Bar Pulldown', ['cable']],
  ['Wall Sit', ['bodyweight']],
  ['Yoke Walk', ['yoke']],
].map(([name, equipment, note]) => ({ name, equipment, note, sourceProgram: MAIN_LIFT_SOURCE }))

const CORE_BACKFILL = [
  ['Barbell Ab Rollout', ['barbell'], 'category=core, not main_lift — included since the source mapping gave it explicitly and it has the same gap'],
  ['Kettlebell Turkish Get-Up (Lunge style)', ['kettlebell'], 'category=core, not main_lift — included since the source mapping gave it explicitly and it has the same gap'],
].map(([name, equipment, note]) => ({ name, equipment, note, sourceProgram: CORE_SOURCE }))

async function run() {
  const all = [...BACKFILL, ...CORE_BACKFILL]
  console.log(`Backfilling equipment_required on ${all.length} rows (${BACKFILL.length} main_lift + ${CORE_BACKFILL.length} core)...\n`)

  let updated = 0
  let notFound = []
  for (const e of all) {
    const { rowCount } = await pool.query(
      `UPDATE exercise_library SET equipment_required = $1
       WHERE name = $2 AND source_program = $3`,
      [e.equipment, e.name, e.sourceProgram],
    )
    if (rowCount === 0) {
      notFound.push(e.name)
      console.log(`  MISS  "${e.name}" — no row found for source_program "${e.sourceProgram}"`)
    } else {
      updated++
      console.log(`  OK    "${e.name}" -> [${e.equipment.join(', ')}]${e.note ? '  (' + e.note + ')' : ''}`)
    }
  }

  console.log(`\nDone — ${updated} updated, ${notFound.length} not found.`)
  if (notFound.length) console.log('Not found:', notFound)

  const { rows: stillEmpty } = await pool.query(
    `SELECT name, source_program FROM exercise_library
     WHERE category IN ('main_lift', 'core') AND source_program = ANY($1) AND equipment_required = '{}'`,
    [[MAIN_LIFT_SOURCE, CORE_SOURCE]],
  )
  console.log(`\nRows still with empty equipment_required in these two source_programs: ${stillEmpty.length}`)
  for (const r of stillEmpty) console.log('  ', r.name, '|', r.source_program)

  await pool.end()
}

run().catch(err => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
