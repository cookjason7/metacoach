/**
 * seed-main-lifts-final.js — seeds the reviewed/finalized main_lift + core
 * catalog into `exercise_library`, superseding the placeholder list from
 * seed-main-lifts.js (source_program 'Main Lifts (temp)').
 *
 * Source: movement-pattern review of the original 98 `workout_exercises`
 * names (renamed/split/added/cut). Additive only — does NOT delete the old
 * 'Main Lifts (temp)' rows. mainLifts.js's MAIN_LIFT_POOL references those
 * 27 rows by exact name and none of those names overlap with this list, so
 * leaving them in place does not conflict with these new rows; it just means
 * two main_lift catalogs coexist until mainLifts.js is migrated to query
 * exercise_library directly (see the TODO in that file) and someone decides
 * whether to retire the temp rows.
 *
 * 'core'-tagged rows in the finalized list are seeded under category='core'
 * (not 'main_lift') because exercise_library.movement_pattern's CHECK
 * constraint only allows the 8 real movement patterns (hinge, squat,
 * vertical_push, vertical_pull, horizontal_push, horizontal_pull, lift,
 * carry) — 'core' is a category, not a movement_pattern value. core_subtype
 * is left NULL: the finalized list doesn't specify anti_extension /
 * anti_rotation / anti_lateral_flexion, and guessing one isn't warranted.
 *
 * 'cut'-tagged exercises are excluded entirely — no exercise_library row is
 * written or touched for them. There is no schema value for "cut"
 * (category's CHECK constraint has no such option, and no active=false
 * convention is used anywhere in this table today) — a cut exercise's
 * status is represented purely by the absence of a main_lift/core row for
 * it under this review's source_programs. CUT_NAMES below exists only so
 * the count is auditable against the finalized list, not because anything
 * is written for it.
 *
 * 13 names originally landed in the unmatched/ambiguous flags below and
 * were resolved by Jason as cut (not in the finalized movement-pattern
 * list, i.e. cut/renamed-away) — see the follow-up to commit 1fa03a5.
 * They're folded into CUT_NAMES accordingly; run() verifies each still
 * exists in workout_exercises (untouched) and has no main_lift/core row.
 *
 * Usage:
 *   node server/scripts/seed-main-lifts-final.js
 *
 * Idempotent — safe to re-run. Upserts on (name, source_program).
 */

import 'dotenv/config'
import { migrate, pool } from '../db.js'

const MAIN_LIFT_SOURCE = 'Main Lifts (Movement Pattern Review)'
const CORE_SOURCE = 'Movement Pattern Review — Core'

const mainLift = (name, movement_pattern) => ({
  name, category: 'main_lift', movement_pattern, source_program: MAIN_LIFT_SOURCE,
})
const core = (name) => ({
  name, category: 'core', movement_pattern: null, source_program: CORE_SOURCE,
})

// ── Finalized list: main_lift rows (42) ─────────────────────────────────────
const MAIN_LIFTS = [
  mainLift('Alternating Hang Clean', 'hinge'),
  mainLift('Barbell Full Squat', 'squat'),
  mainLift('Goblet squat', 'squat'),
  mainLift('Barbell Lunge', 'squat'),
  mainLift('DB Lunge', 'squat'),
  mainLift('Barbell Shoulder Press', 'vertical_push'),
  mainLift('DB Shoulder Press', 'vertical_push'),
  // Split: one workout_exercises row ("Bent-Arm Barbell Pullover") becomes two
  // exercise_library rows per the finalized list (vertical_pull + vertical_push).
  mainLift('Bent-Arm Barbell Pullover (Vertical Pull)', 'vertical_pull'),
  mainLift('Bent-Arm Barbell Pullover (Vertical Push)', 'vertical_push'),
  mainLift('Barbell Board Press', 'horizontal_push'),
  mainLift('DB chest press', 'horizontal_push'),
  mainLift('BB chest press', 'horizontal_push'),
  mainLift('KB RDL', 'hinge'),
  mainLift('BB RDL', 'hinge'),
  mainLift('Double Kettlebell Push Press', 'vertical_push'),
  mainLift('Double Kettlebell Windmill', 'vertical_push'),
  mainLift('Dumbbell Lying One-Arm Rear Lateral Raise', 'horizontal_pull'),
  mainLift('Dumbbell Rear Lunge', 'squat'),
  mainLift('Elevated Back Lunge', 'squat'),
  mainLift("Farmer's Walk", 'carry'),
  mainLift('Pull-ups/assisted', 'vertical_pull'),
  mainLift('High Cable Curls', 'vertical_pull'),
  mainLift('db curls', 'vertical_pull'),
  mainLift('Incline Push-Up (Hands on Wall or Counter)', 'horizontal_push'),
  mainLift('Kettlebell Figure 8', 'horizontal_push'),
  mainLift('Lying Triceps Press', 'vertical_push'),
  mainLift('Modified Glute Bridge', 'hinge'),
  mainLift('One-Arm Kettlebell Clean', 'squat'),
  mainLift('One-Arm Kettlebell Floor Press', 'lift'),
  mainLift('One-Arm Kettlebell Swings', 'hinge'),
  mainLift('One-Arm Open Palm Kettlebell Clean', 'hinge'),
  mainLift('Power Clean from Blocks', 'lift'),
  mainLift('Single Leg Glute Bridge', 'hinge'),
  mainLift('Standing Hip Hinge (Bodyweight Good Morning)', 'hinge'),
  mainLift('Standing Modified Squat (Feet Wide, Shallow Depth)', 'squat'),
  mainLift('Sumo Deadlift', 'hinge'),
  mainLift('Suspended Split Squat', 'squat'),
  mainLift('Two-Arm Kettlebell Clean', 'vertical_push'),
  mainLift('Two-Arm Kettlebell Row', 'vertical_pull'),
  mainLift('V-Bar Pulldown', 'vertical_pull'),
  mainLift('Wall Sit', 'squat'),
  mainLift('Yoke Walk', 'carry'),
]

// ── Finalized list: core rows (5) ───────────────────────────────────────────
const CORE_ROWS = [
  core('Barbell Ab Rollout'),
  core('Dead Bug (Modified, No Lower Back Arch)'),
  core('Dead Bug (Modified — One Limb at a Time)'),
  core('Kettlebell Turkish Get-Up (Lunge style)'),
  core('Suspended Fallout'),
]

// ── cut-tagged names (58) — listed only so the "cut" count in the summary is
// verifiable against the finalized list; never written to exercise_library. ──
const CUT_NAMES = [
  'Bird Dog (Hands and Knees)', 'Cat-Cow + Neck Rolls Warm-Up', 'Cat-Cow Stretch',
  "Child's Pose", "Child's Pose Hold", 'Cool-Down',
  'Cool-Down: Cat-Cow Stretch + Child\'s Pose Hold',
  'Cool-Down: Gentle Standing Stretches + Deep Breathing', 'Donkey Calf Raises',
  'Doorway Chest Stretch', 'Doorway-Free Chest Stretch (clasp hands behind back)',
  'Figure Four Glute Stretch (each side)', 'Full Body Relaxation Cool-Down',
  'Gentle March in Place + Arm Circles Warm-Up', 'Kettlebell Sumo High Pull',
  'Legs Up the Wall or Reclined Deep Breathing Cool-Down',
  'Low-Impact Step Touch with Arm Raise', 'Low Lunge Hip Flexor Stretch (each side)',
  'Lunge Pass Through', 'Lying Hip Flexor Stretch (Figure Four)',
  'Neck Rolls + Shoulder Shrugs Warm-Up', 'Seated Butterfly Stretch',
  'Seated Cross-Body Shoulder Stretch', 'Seated Forward Fold (Floor)',
  'Seated Hamstring Stretch (each side)', 'Seated or Standing Torso Rotation (Gentle Twist)',
  'Side To Side Chins', 'Sphinx Pose Hold', 'Standing Calf Raise',
  'Standing Calf Stretch Against Wall (each side)', 'Standing Forward Fold',
  'Standing Marching with High Knees (Low Impact)', 'Standing Quad Stretch (each side)',
  'Standing Quad Stretch (Wall Support)', 'Standing Side Leg Raise',
  'Supine Knee-to-Chest Stretch', 'Supine Knee-to-Chest Stretch (each side)',
  'Supine Spinal Twist Cool-Down', 'Thread the Needle Chest Opener (each side)',
  'Thread the Needle Stretch', 'Wall Angel Slide',
  'Warm-Up: Gentle March in Place + Arm Circles',
  'Warm-Up: Step Touch Side to Side + Shoulder Rolls', 'Weighted Sit-Ups - With Bands',
  'Wide-Legged Seated Straddle Stretch',
  // Resolved cut, follow-up to commit 1fa03a5 (previously UNMATCHED_HARD —
  // no reasonable match in the finalized list at all):
  'Ab Crunch Machine', 'Clock Push-Up', 'Olympic Squat', 'Plate Pinch', 'Ring Dips',
  'Rope Climb', 'Russian Twist', 'Seated Head Harness Neck Resistance',
  // Resolved cut, follow-up to commit 1fa03a5 (previously UNMATCHED_AMBIGUOUS —
  // near-duplicates of a finalized name; Jason confirmed these are cut, not
  // consolidations into that name):
  'Barbell Rollout from Bench', 'Clean from Blocks',
  'Double Kettlebell Alternating Hang Clean', 'Gentle Spinal Twist Cool-Down',
  'Warm-Up',
]

// The 13 names resolved as cut in this follow-up — used below only to print
// a focused confirmation (still in workout_exercises, no main_lift/core row).
const RESOLVED_CUT_NAMES = [
  'Ab Crunch Machine', 'Clock Push-Up', 'Olympic Squat', 'Plate Pinch', 'Ring Dips',
  'Rope Climb', 'Russian Twist', 'Seated Head Harness Neck Resistance',
  'Barbell Rollout from Bench', 'Clean from Blocks',
  'Double Kettlebell Alternating Hang Clean', 'Gentle Spinal Twist Cool-Down',
  'Warm-Up',
]

async function run() {
  await migrate()

  const { rows: weRows } = await pool.query('SELECT DISTINCT exercise_name FROM workout_exercises ORDER BY 1')
  const weNames = new Set(weRows.map(r => r.exercise_name))
  console.log(`workout_exercises has ${weNames.size} distinct names.`)

  console.log(`\nMain lift rows to seed: ${MAIN_LIFTS.length}`)
  console.log(`Core rows to seed: ${CORE_ROWS.length}`)
  console.log(`Cut (excluded) names accounted for: ${CUT_NAMES.length}`)
  console.log(`Unmatched/ambiguous still open for review: 0 (all resolved as cut)`)

  const all = [...MAIN_LIFTS, ...CORE_ROWS]
  let inserted = 0
  let updated = 0
  for (const e of all) {
    const { rows } = await pool.query(
      `INSERT INTO exercise_library (name, category, movement_pattern, source_program)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name, source_program) DO UPDATE SET
         category         = EXCLUDED.category,
         movement_pattern = EXCLUDED.movement_pattern
       RETURNING (xmax = 0) AS inserted`,
      [e.name, e.category, e.movement_pattern, e.source_program],
    )
    if (rows[0].inserted) inserted++
    else updated++
  }

  console.log(`\nDone — ${inserted} inserted, ${updated} updated, ${all.length} total.`)

  const byPattern = await pool.query(
    `SELECT movement_pattern, COUNT(*) FROM exercise_library WHERE category = 'main_lift' AND source_program = $1 GROUP BY movement_pattern ORDER BY movement_pattern`,
    [MAIN_LIFT_SOURCE],
  )
  console.log('\nNew main_lift row counts by movement_pattern:', JSON.stringify(byPattern.rows))

  const totalMainLift = await pool.query(`SELECT COUNT(*) FROM exercise_library WHERE category = 'main_lift'`)
  console.log(`Total main_lift rows in exercise_library now (old temp + new finalized): ${totalMainLift.rows[0].count}`)

  // ── Confirm the 13 resolved-cut names: still present in workout_exercises
  // (nothing deleted), and no main_lift/core row exists for them under this
  // review's source_programs (i.e. they're excluded, matching cut convention).
  console.log(`\n--- Confirming ${RESOLVED_CUT_NAMES.length} resolved-cut names ---`)
  const { rows: stillHasRow } = await pool.query(
    `SELECT name, category, source_program FROM exercise_library
     WHERE name = ANY($1) AND source_program = ANY($2)`,
    [RESOLVED_CUT_NAMES, [MAIN_LIFT_SOURCE, CORE_SOURCE]],
  )
  let allGood = true
  for (const name of RESOLVED_CUT_NAMES) {
    const inWE = weNames.has(name)
    const hasRow = stillHasRow.some(r => r.name === name)
    const ok = inWE && !hasRow
    if (!ok) allGood = false
    console.log(`  ${ok ? 'OK ' : 'FAIL'} — "${name}": in workout_exercises=${inWE}, has main_lift/core row=${hasRow}`)
  }
  console.log(allGood
    ? '\nAll 13 confirmed: still in workout_exercises, no main_lift/core row (cut).'
    : '\nWARNING — one or more of the 13 failed confirmation, see FAIL lines above.')

  await pool.end()
}

run().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
