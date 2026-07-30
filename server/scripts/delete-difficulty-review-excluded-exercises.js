/**
 * delete-difficulty-review-excluded-exercises.js — removes the 15 exercises
 * from Jenn's second difficulty review that were marked target_difficulty
 * "exclude" (see server/data/difficulty-review/exercises_175_difficulty_updates.csv
 * and server/scripts/apply-difficulty-review-batch2.js, which deliberately
 * left these 15 rows untouched).
 *
 * Before deleting, re-checks for references in workout_exercises (by
 * exercise_id or exact exercise_name) and exercise_library (by
 * legacy_exercise_id or exact name). Any id with a live reference is
 * skipped, not deleted — deleting it would either orphan a coach's assigned
 * workout (exercise_id has ON DELETE SET NULL, so the row wouldn't break,
 * but the workout would silently lose its link to the exercise library) or
 * require a separate decision about the workout itself.
 *
 * Usage:
 *   node server/scripts/delete-difficulty-review-excluded-exercises.js
 */

import 'dotenv/config'
import { pool } from '../db.js'

const CANDIDATE_IDS = [477, 566, 743, 859, 393, 361, 362, 430, 443, 444, 643, 128, 541, 614, 50]

async function main() {
  const { rows: targets } = await pool.query(
    `SELECT id, name FROM exercises WHERE id = ANY($1) ORDER BY id`,
    [CANDIDATE_IDS],
  )
  const names = targets.map(r => r.name)
  const nameToId = new Map(targets.map(r => [r.name, r.id]))

  const { rows: byExerciseId } = await pool.query(
    `SELECT DISTINCT exercise_id AS id FROM workout_exercises WHERE exercise_id = ANY($1)`,
    [CANDIDATE_IDS],
  )
  const { rows: byExerciseName } = await pool.query(
    `SELECT DISTINCT exercise_name AS name FROM workout_exercises WHERE exercise_name = ANY($1)`,
    [names],
  )
  const { rows: byLegacyId } = await pool.query(
    `SELECT DISTINCT legacy_exercise_id AS id FROM exercise_library WHERE legacy_exercise_id = ANY($1)`,
    [CANDIDATE_IDS],
  )
  const { rows: byLibraryName } = await pool.query(
    `SELECT DISTINCT name FROM exercise_library WHERE name = ANY($1)`,
    [names],
  )

  const referenced = new Set([
    ...byExerciseId.map(r => r.id),
    ...byLegacyId.map(r => r.id),
    ...byExerciseName.filter(r => nameToId.has(r.name)).map(r => nameToId.get(r.name)),
    ...byLibraryName.filter(r => nameToId.has(r.name)).map(r => nameToId.get(r.name)),
  ])

  const toDelete = CANDIDATE_IDS.filter(id => !referenced.has(id))
  const blocked = CANDIDATE_IDS.filter(id => referenced.has(id))

  let deletedCount = 0
  if (toDelete.length > 0) {
    const { rowCount } = await pool.query(`DELETE FROM exercises WHERE id = ANY($1)`, [toDelete])
    deletedCount = rowCount
  }

  console.log('=== Delete excluded exercises — summary ===')
  console.log(`Deleted (${deletedCount}): ${toDelete.join(', ') || 'none'}`)
  console.log(`Blocked — referenced, left untouched (${blocked.length}):`)
  for (const id of blocked) {
    const name = targets.find(t => t.id === id)?.name
    console.log(`  id=${id} "${name}"`)
  }

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
