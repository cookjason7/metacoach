/**
 * server/services/workoutExerciseInsert.js
 *
 * Single INSERT INTO workout_exercises builder, shared by every route that
 * creates a row: routes/workouts.js (client self-serve save + add-exercise)
 * and routes/coachAdmin.js (coach bulk-save + add-exercise). Before this, each
 * route hand-wrote its own column list and the four drifted independently —
 * confirmed cause of a real bug where group_id/group_type/group_label were
 * missing from one bulk-save route while present in another. Routing every
 * INSERT through WORKOUT_EXERCISE_COLUMNS means a future schema addition that
 * isn't wired into a caller shows up as an explicit null, never a silently
 * dropped column.
 *
 * This module does not decide business-logic defaults (e.g. day defaulting to
 * 'Day 1', or a route's own group_type validation) — callers keep computing
 * those exactly as before and pass the final value in `fields`. The only
 * defaults applied here mirror the table's own schema DEFAULTs (sort_order,
 * group_type), so a caller that omits a field ends up with the same value the
 * database would have produced from an omitted column. Every other omitted
 * field defaults to null, matching every nullable column's implicit default.
 */

import { pool } from '../db.js'

// Mirrors the full non-serial column set in server/db.js's workout_exercises
// table (CREATE TABLE + the post-launch ALTER TABLE ADD COLUMN block).
export const WORKOUT_EXERCISE_COLUMNS = [
  'workout_id', 'day', 'exercise_name', 'exercise_id', 'day_focus', 'sets', 'reps',
  'weight', 'rest_seconds', 'notes', 'sort_order', 'image_url', 'instructions',
  'section_name', 'group_id', 'group_type', 'group_label', 'org_id',
]

// Columns with a schema-level DEFAULT in db.js (sort_order INTEGER DEFAULT 0,
// group_type TEXT NOT NULL DEFAULT 'exercise') — applied here only when the
// caller's `fields` object doesn't have the key at all, so an omitted field
// behaves identically to omitting the column from the INSERT entirely.
const SCHEMA_DEFAULTS = {
  sort_order: 0,
  group_type: 'exercise',
}

function buildValues(fields) {
  return WORKOUT_EXERCISE_COLUMNS.map(col => {
    if (Object.prototype.hasOwnProperty.call(fields, col)) return fields[col]
    return SCHEMA_DEFAULTS[col] ?? null
  })
}

// The COALESCE image_url lookup coachAdmin.js's single-exercise-add route
// already ran in its RETURNING clause, resolving image_url from the legacy
// `exercises` table (by exercise_id, falling back to a name match) when the
// inserted row itself doesn't carry one. Opt-in via resolveImageUrl so
// callers that never did this lookup (workouts.js's routes) don't start
// returning a field their response shape never had.
const PLAIN_RETURNING = 'RETURNING *'
const IMAGE_URL_RETURNING = `RETURNING *, COALESCE(
  (SELECT image_url FROM exercises WHERE id = workout_exercises.exercise_id),
  (SELECT image_url FROM exercises
     WHERE lower(trim(name)) = lower(trim(workout_exercises.exercise_name))
       AND image_url IS NOT NULL
     ORDER BY id LIMIT 1)
) AS image_url`

/**
 * Inserts one workout_exercises row. `fields` may supply any subset of
 * WORKOUT_EXERCISE_COLUMNS; anything omitted is sent as null (or the matching
 * schema default for sort_order/group_type) rather than being left out of the
 * INSERT's column list.
 *
 * @param {Object} fields
 * @param {Object} [options]
 * @param {boolean} [options.resolveImageUrl] - include the legacy-exercises
 *   image_url COALESCE lookup in RETURNING (matches coachAdmin.js's existing
 *   add-exercise response shape).
 * @returns {Promise<Object>} the inserted row
 */
export async function insertWorkoutExercise(fields, { resolveImageUrl = false } = {}) {
  const values = buildValues(fields)
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  const { rows: [row] } = await pool.query(
    `INSERT INTO workout_exercises (${WORKOUT_EXERCISE_COLUMNS.join(', ')})
     VALUES (${placeholders})
     ${resolveImageUrl ? IMAGE_URL_RETURNING : PLAIN_RETURNING}`,
    values,
  )
  return row
}
