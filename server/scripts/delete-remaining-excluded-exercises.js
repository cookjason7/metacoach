/**
 * delete-remaining-excluded-exercises.js — completes Jenn's second difficulty
 * review "exclude" cleanup. server/scripts/delete-difficulty-review-excluded-exercises.js
 * deleted 13 of 15 exclude-marked exercises and left 2 in place (id 614
 * "Russian Twist", id 643 "Seated Head Harness Neck Resistance") because
 * they were referenced by workout_exercises rows in an assigned workout
 * (workout_id=9). Confirmed separately that assembleSession() — the current
 * generator — sources exclusively from exercise_library, which has no rows
 * for either name, so neither could ever be freshly selected regardless of
 * this table. Decision made to delete both now; workout_exercises.exercise_id
 * has ON DELETE SET NULL, so those two rows will keep their exercise_name
 * text (unaffected — it's a separate column) and just lose the FK link.
 *
 * Usage:
 *   node server/scripts/delete-remaining-excluded-exercises.js
 */

import 'dotenv/config'
import { pool } from '../db.js'

const IDS = [477, 566, 743, 859, 393, 361, 362, 430, 443, 444, 643, 128, 541, 614, 50]
const AFFECTED_WORKOUT_EXERCISE_IDS = [141, 134] // Russian Twist (was exercise_id=614), Seated Head Harness Neck Resistance (was exercise_id=643)

async function main() {
  const before = await pool.query(
    `SELECT id, workout_id, day, exercise_name, exercise_id FROM workout_exercises WHERE id = ANY($1) ORDER BY id`,
    [AFFECTED_WORKOUT_EXERCISE_IDS],
  )
  console.log('=== workout_exercises rows before delete ===')
  console.log(JSON.stringify(before.rows, null, 2))

  const { rowCount } = await pool.query(`DELETE FROM exercises WHERE id = ANY($1)`, [IDS])

  const after = await pool.query(
    `SELECT id, workout_id, day, exercise_name, exercise_id FROM workout_exercises WHERE id = ANY($1) ORDER BY id`,
    [AFFECTED_WORKOUT_EXERCISE_IDS],
  )
  console.log('\n=== workout_exercises rows after delete ===')
  console.log(JSON.stringify(after.rows, null, 2))

  console.log('\n=== Summary ===')
  console.log(`Rows deleted from exercises: ${rowCount}`)
  for (const row of after.rows) {
    const beforeRow = before.rows.find(b => b.id === row.id)
    const nameIntact = row.exercise_name === beforeRow?.exercise_name
    const idNulled = row.exercise_id === null
    console.log(`  workout_exercises.id=${row.id} "${row.exercise_name}": exercise_id ${beforeRow?.exercise_id} -> ${row.exercise_id} (${idNulled ? 'NULLED OK' : 'UNEXPECTED'}), name intact: ${nameIntact}`)
  }

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
