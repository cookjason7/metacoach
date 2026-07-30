/**
 * server/services/workoutDayNotes.js
 *
 * Shared read helper for workout_day_notes, used by both the coach-facing builder
 * (routes/coachAdmin.js) and the client's own read-only program view
 * (routes/workouts.js) so the two can never disagree about what counts as a real
 * note.
 *
 * A "day" has no row of its own anywhere in the schema — it's just a distinct
 * workout_exercises.day value — so notes are keyed by (workout_id, day), the same
 * convention coach_assigned_workouts.day_label uses. See workout_day_notes in
 * server/db.js.
 */

import { pool } from '../db.js'

/**
 * Returns one workout's day notes as a `{ [day]: note_text }` map. Days with no
 * note are absent from the map rather than present-and-empty.
 *
 * The PUT route deletes a row instead of blanking it when a coach clears a note,
 * so blank rows shouldn't exist — but the WHERE clause filters them anyway so a
 * row written by anything else (a manual SQL fix, a future importer) can never
 * surface in the UI as an empty note block.
 *
 * @param {number} workoutId
 * @returns {Promise<Record<string, string>>}
 */
export async function getWorkoutDayNotes(workoutId) {
  const { rows } = await pool.query(
    `SELECT day, note_text FROM workout_day_notes
      WHERE workout_id = $1 AND note_text IS NOT NULL AND btrim(note_text) <> ''`,
    [workoutId],
  )
  return Object.fromEntries(rows.map(r => [r.day, r.note_text]))
}
