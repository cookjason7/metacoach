/**
 * retag-mistagged-upper-pull-exercises.js — corrects 14 `exercises` rows that
 * were tagged movement_pattern='upper_pull' but are not upper-pull movements
 * (surfaced by a read-only audit that checked name + primary_muscles against
 * every upper_pull row):
 *
 *   - Hinge / posterior-chain-loaded lifts (primary_muscles: lower back), not
 *     a back pull -> 'hinge_bilateral':
 *       640 Seated Good Mornings, 576 Rack Pulls, 575 Rack Pull with Bands,
 *       331 Hyperextensions (Back Extensions)
 *   - Loaded-carry / strongman movements (primary_muscles: lower back) -> 'carry':
 *       29 Atlas Stones, 28 Atlas Stone Trainer, 371 Keg Load
 *   - Forearm/grip isolation (primary_muscles: forearms) and one advanced
 *     kettlebell grip drill, none of which involves a back-pulling motion
 *     -> 'arms' (an existing, already-valid movement_pattern enum value that
 *     buildDaySkeletons never queries for a day-template slot, so this
 *     effectively removes them from selection without deleting the rows):
 *       232 Dumbbell Lying Pronation, 234 Dumbbell Lying Supination,
 *       540 Plate Pinch, 773 Standing Olympic Plate Hand Squeeze,
 *       868 Wrist Roller, 869 Wrist Rotations with Straight Bar,
 *       98 Bottoms-Up Clean From The Hang Position
 *
 * Deliberately NOT touched — power/throwing movements (Catch and Overhead
 * Throw id=146, Overhead Slam id=522) and Kettlebell Sumo High Pull (id=382,
 * already excluded from beginner/intermediate selection by name block) are
 * left tagged upper_pull pending a coach decision on where they belong.
 *
 * Only the movement_pattern column is touched. No FK integrity is at risk:
 * workout_exercises references exercises only by id (exercise_id, ON DELETE
 * SET NULL) and stores no movement_pattern of its own; exercise_library links
 * back the same way via legacy_exercise_id. Neither table is affected by a
 * movement_pattern value change on an existing, undeleted row.
 *
 * Idempotent: each UPDATE also filters on the current movement_pattern, so a
 * re-run after the first successful application is a no-op (rowCount 0).
 *
 * Usage:
 *   node server/scripts/retag-mistagged-upper-pull-exercises.js
 */

import 'dotenv/config'
import { pool } from '../db.js'

const ARMS_IDS = [232, 234, 540, 773, 868, 869, 98]
const HINGE_BILATERAL_IDS = [640, 576, 575, 331]
const CARRY_IDS = [29, 28, 371]

async function main() {
  const before = await pool.query(
    `SELECT id, name, movement_pattern FROM exercises WHERE id = ANY($1) ORDER BY id`,
    [[...ARMS_IDS, ...HINGE_BILATERAL_IDS, ...CARRY_IDS]],
  )
  console.log('=== Before ===')
  for (const r of before.rows) console.log(`  ${r.id} ${r.name} -> ${r.movement_pattern}`)

  const arms = await pool.query(
    `UPDATE exercises SET movement_pattern = 'arms' WHERE id = ANY($1) AND movement_pattern = 'upper_pull'`,
    [ARMS_IDS],
  )
  const hinge = await pool.query(
    `UPDATE exercises SET movement_pattern = 'hinge_bilateral' WHERE id = ANY($1) AND movement_pattern = 'upper_pull'`,
    [HINGE_BILATERAL_IDS],
  )
  const carry = await pool.query(
    `UPDATE exercises SET movement_pattern = 'carry' WHERE id = ANY($1) AND movement_pattern = 'upper_pull'`,
    [CARRY_IDS],
  )

  const after = await pool.query(
    `SELECT id, name, movement_pattern FROM exercises WHERE id = ANY($1) ORDER BY id`,
    [[...ARMS_IDS, ...HINGE_BILATERAL_IDS, ...CARRY_IDS, 146, 522, 382]],
  )
  console.log('\n=== After ===')
  for (const r of after.rows) console.log(`  ${r.id} ${r.name} -> ${r.movement_pattern}`)

  const stillUpperPull = await pool.query(
    `SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND movement_pattern = 'upper_pull'`,
    [[...ARMS_IDS, ...HINGE_BILATERAL_IDS, ...CARRY_IDS]],
  )

  console.log('\n=== Summary ===')
  console.log(`  arms: ${arms.rowCount} updated (expect 7, or 0 on a re-run)`)
  console.log(`  hinge_bilateral: ${hinge.rowCount} updated (expect 4, or 0 on a re-run)`)
  console.log(`  carry: ${carry.rowCount} updated (expect 3, or 0 on a re-run)`)
  console.log(`  Touched ids still tagged upper_pull (must be 0): ${stillUpperPull.rows[0].c}`)
  console.log(`  Left untouched pending coach decision: 146 (Catch and Overhead Throw), 522 (Overhead Slam), 382 (Kettlebell Sumo High Pull)`)

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
