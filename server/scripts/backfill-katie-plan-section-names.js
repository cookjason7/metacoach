/**
 * backfill-katie-plan-section-names.js — backfills section_name on
 * workout_exercises rows saved through the "Generate with Katie" bulk-save
 * route (POST /api/coach-admin/clients/:id/workouts), which built its
 * insertWorkoutExercise() call without a section_name field — every column
 * insertWorkoutExercise() isn't explicitly given defaults to NULL (see
 * server/services/workoutExerciseInsert.js), so every exercise saved through
 * that route got section_name = NULL. The manual builder's section grouping
 * (client/src/utils/workoutGrouping.js sectionOrderFor/buildSections)
 * silently defaults a NULL section_name to 'Strength' — harmless for the
 * actual strength/quota exercises (that's where they belong anyway) but
 * wrong for the Warm-Up and Cool-Down entries, which land inside the
 * Strength section instead of their own (empty-looking) sections. Fixed
 * alongside this script in server/routes/coachAdmin.js (added
 * `section_name: ex.section_name ?? null` to that insertWorkoutExercise()
 * call) — this script only backfills rows saved before that fix.
 *
 * Bug window: the sections feature (section_name column + this bulk-save
 * route) shipped together in commit 9570769 ("feat: workout builder
 * sections, supersets, and circuits", 2026-07-21); the omission has been
 * present since that commit, i.e. every Katie-generated plan saved from
 * 2026-07-21 up to this fix is affected.
 *
 * DISCRIMINATOR — why day_focus is required, not just exercise_id:
 * The originally proposed predicate (section_name IS NULL AND exercise_id
 * IS NULL) is not on its own a safe way to isolate "came from the buggy
 * bulk-save route". A coach can manually add a freeform exercise with no
 * exercise-library match through the *correct* single-exercise-add route
 * (POST .../workouts/:wid/exercises), which also leaves exercise_id NULL —
 * but that route always supplies a real section_name from the UI's
 * `addTarget.section`, so those rows don't collide with this predicate
 * today. The real risk is legacy rows that predate the sections feature
 * entirely (pre-2026-07-21), which could have section_name NULL and
 * exercise_id NULL simultaneously for reasons unrelated to this bug.
 *
 * Added guard: day_focus IS NOT NULL. workoutGenerator.js's mergeResponse()
 * sets day_focus (skeleton.day_focus, a non-empty string built by joining
 * every slot's movement-pattern label — see workoutGenerator.js:801) on
 * every exercise in a generated day, warm-up/cool-down included
 * (workoutGenerator.js:1276-1291 pass `day.focus` through unconditionally).
 * Neither the manual single-add route nor the edit-exercise route (its
 * `allowed` column whitelist at coachAdmin.js:4171-4174 excludes day_focus)
 * ever writes day_focus — so a manually-created row has day_focus NULL
 * forever, immutably. Requiring day_focus IS NOT NULL therefore reliably
 * isolates Katie-bulk-saved rows and excludes every legacy/manual row.
 *
 * The script prints the raw-predicate vs. guarded-predicate counts (and a
 * sample of what the guard excludes) before touching anything, so a
 * mismatch between them is visible up front rather than silently assumed.
 *
 * Usage:
 *   node server/scripts/backfill-katie-plan-section-names.js
 *
 * Idempotent — candidates are re-selected fresh on every run (section_name
 * IS NULL is part of the scope), so a re-run after a successful application
 * finds zero candidates and every UPDATE is a no-op (rowCount 0).
 */

import 'dotenv/config'
import { pool } from '../db.js'

const RAW_SCOPE_SQL     = `section_name IS NULL AND exercise_id IS NULL`
const GUARDED_SCOPE_SQL = `${RAW_SCOPE_SQL} AND day_focus IS NOT NULL`

async function main() {
  // ── Step 1: validate the discriminator before trusting it ─────────────────
  const { rows: [{ c: rawCount }] } = await pool.query(
    `SELECT count(*)::int AS c FROM workout_exercises WHERE ${RAW_SCOPE_SQL}`,
  )
  const { rows: [{ c: guardedCount }] } = await pool.query(
    `SELECT count(*)::int AS c FROM workout_exercises WHERE ${GUARDED_SCOPE_SQL}`,
  )
  const excludedCount = rawCount - guardedCount
  console.log(`Raw predicate (section_name IS NULL AND exercise_id IS NULL): ${rawCount} row(s)`)
  console.log(`+ day_focus IS NOT NULL guard applied: ${guardedCount} row(s) in final scope`)
  console.log(`Excluded by the guard as ambiguous/legacy (left untouched): ${excludedCount} row(s)`)

  if (excludedCount > 0) {
    const { rows: sample } = await pool.query(
      `SELECT id, workout_id, day, exercise_name, sort_order FROM workout_exercises
       WHERE ${RAW_SCOPE_SQL} AND day_focus IS NULL
       ORDER BY id LIMIT 20`,
    )
    console.log(`\nSample of excluded rows — spot-check these are pre-sections-feature/manual rows, not Katie output:`)
    sample.forEach(r => console.log(
      `  id=${r.id} workout_id=${r.workout_id} day="${r.day}" exercise_name="${r.exercise_name}" sort_order=${r.sort_order}`,
    ))
    console.log(`  (${excludedCount - sample.length > 0 ? `+${excludedCount - sample.length} more not shown` : 'all shown above'})`)
  }

  // ── Step 2: candidates in the final (guarded) scope ────────────────────────
  const { rows: candidates } = await pool.query(
    `SELECT id, exercise_name FROM workout_exercises WHERE ${GUARDED_SCOPE_SQL}`,
  )
  console.log(`\nCandidates to backfill: ${candidates.length}`)

  const warmupIds   = candidates.filter(r => r.exercise_name === 'Warm-Up').map(r => r.id)
  const cooldownIds = candidates.filter(r => r.exercise_name === 'Cool-Down').map(r => r.id)
  const strengthIds = candidates
    .filter(r => r.exercise_name !== 'Warm-Up' && r.exercise_name !== 'Cool-Down')
    .map(r => r.id)
  console.log(`  -> section_name = 'Warm-Up':  ${warmupIds.length}`)
  console.log(`  -> section_name = 'Cool Down': ${cooldownIds.length}`)
  console.log(`  -> section_name = 'Strength'  (remaining, exercise_name not Warm-Up/Cool-Down): ${strengthIds.length}`)

  // ── Step 3: apply, transactionally ─────────────────────────────────────────
  const client = await pool.connect()
  let warmupUpdated = 0, cooldownUpdated = 0, strengthUpdated = 0
  try {
    await client.query('BEGIN')
    ;({ rowCount: warmupUpdated } = await client.query(
      `UPDATE workout_exercises SET section_name = 'Warm-Up' WHERE id = ANY($1)`, [warmupIds],
    ))
    ;({ rowCount: cooldownUpdated } = await client.query(
      `UPDATE workout_exercises SET section_name = 'Cool Down' WHERE id = ANY($1)`, [cooldownIds],
    ))
    ;({ rowCount: strengthUpdated } = await client.query(
      `UPDATE workout_exercises SET section_name = 'Strength' WHERE id = ANY($1)`, [strengthIds],
    ))
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // ── Step 4: verify ──────────────────────────────────────────────────────────
  const allTouchedIds = [...warmupIds, ...cooldownIds, ...strengthIds]
  const { rows: [{ c: stillNullAmongTouched }] } = await pool.query(
    `SELECT count(*)::int AS c FROM workout_exercises WHERE id = ANY($1) AND section_name IS NULL`,
    [allTouchedIds],
  )
  const totals = await pool.query(
    `SELECT section_name, count(*)::int AS c FROM workout_exercises
     WHERE section_name IN ('Warm-Up', 'Cool Down', 'Strength')
     GROUP BY section_name ORDER BY section_name`,
  )

  console.log(`\n=== Summary ===`)
  console.log(`Set to 'Warm-Up':  ${warmupUpdated}`)
  console.log(`Set to 'Cool Down': ${cooldownUpdated}`)
  console.log(`Set to 'Strength': ${strengthUpdated}`)
  console.log(`Still NULL among touched candidates after update (should be 0): ${stillNullAmongTouched}`)
  console.log(`\nsection_name totals across entire workout_exercises table after update:`)
  totals.rows.forEach(r => console.log(`  ${r.section_name}: ${r.c}`))

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
