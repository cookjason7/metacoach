/**
 * retag-throw-slam-sumo-high-pull.js — applies the 3 coach decisions left
 * pending by retag-mistagged-upper-pull-exercises.js:
 *
 *   - Catch and Overhead Throw (146), Overhead Slam (522): medicine-ball
 *     power/throw movements, not a back pull. movement_pattern='upper_pull'
 *     is the ONLY column pickExercise/buildDaySkeletons filter a strength
 *     slot on (see server/services/workoutGenerator.js pickExercise — its
 *     WHERE clause has no `category` condition at all), so category alone
 *     is cosmetic for selection purposes; both category AND movement_pattern
 *     are set to 'conditioning' here so they're fully unreachable from any
 *     strength slot and instead surface only in the optional bonus
 *     carry/conditioning slot (BONUS_SLOTS), which is exactly what these
 *     movements are. Notably both rows carry difficulty='beginner' today —
 *     before this fix a beginner's pull slot could resolve to an explosive
 *     medicine-ball throw.
 *   - Kettlebell Sumo High Pull (382): retagged movement_pattern='upper_pull'
 *     -> 'hinge_bilateral' (it's a ballistic hip-hinge movement, not a back
 *     pull — traps is a secondary driver, not the primary mover). category
 *     is left at 'strength' (correct, unchanged). Its existing name block —
 *     the 'high pull' substring in both BEGINNER_BLOCKED_EXERCISES and
 *     INTERMEDIATE_BLOCKED_EXERCISES (server/services/workoutGenerator.js)
 *     — is untouched and applies independently of movement_pattern, so it
 *     stays excluded from beginner AND intermediate selection exactly as
 *     before; only the queried pattern changes from upper_pull to
 *     hinge_bilateral.
 *
 * Idempotent: each UPDATE also filters on the current movement_pattern, so a
 * re-run after the first successful application is a no-op (rowCount 0).
 *
 * Usage:
 *   node server/scripts/retag-throw-slam-sumo-high-pull.js
 */

import 'dotenv/config'
import { pool } from '../db.js'

const CONDITIONING_IDS = [146, 522]
const SUMO_HIGH_PULL_ID = 382

async function main() {
  const before = await pool.query(
    `SELECT id, name, category, movement_pattern, difficulty FROM exercises WHERE id = ANY($1) ORDER BY id`,
    [[...CONDITIONING_IDS, SUMO_HIGH_PULL_ID]],
  )
  console.log('=== Before ===')
  for (const r of before.rows) console.log(`  ${r.id} ${r.name} -> category=${r.category} movement_pattern=${r.movement_pattern} difficulty=${r.difficulty}`)

  const conditioning = await pool.query(
    `UPDATE exercises SET category = 'conditioning', movement_pattern = 'conditioning'
     WHERE id = ANY($1) AND movement_pattern = 'upper_pull'`,
    [CONDITIONING_IDS],
  )
  const sumoHighPull = await pool.query(
    `UPDATE exercises SET movement_pattern = 'hinge_bilateral'
     WHERE id = $1 AND movement_pattern = 'upper_pull'`,
    [SUMO_HIGH_PULL_ID],
  )

  const after = await pool.query(
    `SELECT id, name, category, movement_pattern, difficulty FROM exercises WHERE id = ANY($1) ORDER BY id`,
    [[...CONDITIONING_IDS, SUMO_HIGH_PULL_ID]],
  )
  console.log('\n=== After ===')
  for (const r of after.rows) console.log(`  ${r.id} ${r.name} -> category=${r.category} movement_pattern=${r.movement_pattern} difficulty=${r.difficulty}`)

  const stillUpperPull = await pool.query(
    `SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND movement_pattern = 'upper_pull'`,
    [[...CONDITIONING_IDS, SUMO_HIGH_PULL_ID]],
  )

  console.log('\n=== Summary ===')
  console.log(`  conditioning (146, 522): ${conditioning.rowCount} updated (expect 2, or 0 on a re-run)`)
  console.log(`  hinge_bilateral (382): ${sumoHighPull.rowCount} updated (expect 1, or 0 on a re-run)`)
  console.log(`  Touched ids still tagged upper_pull (must be 0): ${stillUpperPull.rows[0].c}`)

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
