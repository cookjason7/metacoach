/**
 * backfill-requires-bench.js — sets requires_bench = TRUE for exercises that need
 * a flat/incline/decline bench (lying/incline presses, incline curls, bench-supported
 * rows, etc.).
 *
 * Candidates are derived live from the database (name/instructions ~* 'bench'), not
 * from a hardcoded id list — ids are not stable across environments (a re-seeded or
 * re-imported library can renumber rows), so a fixed list would silently stop
 * matching the exercises it was meant for. The candidate set is narrowed by two
 * name-based exclusion rules, re-applied to whatever rows currently match:
 *
 *   - False positives — "bench" appears but no furniture is required: Bench Jump,
 *     Bench Sprint, Depth Jump Leap, Linear Depth Jump all use "box or bench" as an
 *     interchangeable plyo platform, not a specific piece of furniture; Barbell Rear
 *     Delt Row and One Arm Floor Press mention "bench press" only as a descriptive
 *     comparison ("resembles a bench press in reverse" / "similar to a bench press")
 *     while the actual exercise is standing or floor-based.
 *   - Ambiguous — a bench is optional/substitutable rather than the exercise's
 *     basis: Barbell Squat To A Bench ("flat bench or a box"), Cable Internal
 *     Rotation ("can use a flat bench... instead"), Decline Push-Up ("box or
 *     bench"), One-Arm Side Laterals (bench used only as an optional balance aid).
 *     Left at the FALSE default.
 *
 * Idempotent — the UPDATE only touches rows currently FALSE, so a re-run after the
 * first successful application is a no-op (rowCount 0).
 *
 * Usage:
 *   node server/scripts/backfill-requires-bench.js
 */

import 'dotenv/config'
import { pool } from '../db.js'

// Name-exact exclusions from the candidate set — see the audit reasoning above.
// Matched by name (stable across a re-seed), not by id.
const FALSE_POSITIVE_NAMES = [
  'Bench Jump', 'Bench Sprint', 'Depth Jump Leap', 'Linear Depth Jump',
  'Barbell Rear Delt Row', 'One Arm Floor Press',
]
const AMBIGUOUS_NAMES = [
  'Barbell Squat To A Bench', 'Cable Internal Rotation', 'Decline Push-Up', 'One-Arm Side Laterals',
]
const EXCLUDED_NAMES = [...FALSE_POSITIVE_NAMES, ...AMBIGUOUS_NAMES]

async function main() {
  const { rows: candidates } = await pool.query(
    `SELECT id, name FROM exercises WHERE name ~* 'bench' OR instructions ~* 'bench' ORDER BY id`,
  )
  console.log(`Candidates (name/instructions match 'bench'): ${candidates.length}`)

  const toSet = candidates.filter(c => !EXCLUDED_NAMES.includes(c.name))
  const excludedFound = candidates.filter(c => EXCLUDED_NAMES.includes(c.name)).map(c => c.name)
  const missingExclusions = EXCLUDED_NAMES.filter(n => !excludedFound.includes(n))
  if (missingExclusions.length) {
    console.warn(`WARNING — expected exclusion(s) not found among candidates (renamed or removed since the audit?): ${missingExclusions.join(', ')}`)
  }
  console.log(`Excluded as false-positive/ambiguous: ${excludedFound.length} / ${EXCLUDED_NAMES.length} expected`)
  console.log(`Rows to set requires_bench = TRUE: ${toSet.length}`)

  const ids = toSet.map(c => c.id)
  const before = await pool.query(
    `SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND requires_bench = TRUE`,
    [ids],
  )
  console.log(`Already TRUE before this run: ${before.rows[0].c} / ${ids.length}`)

  const { rowCount } = await pool.query(
    `UPDATE exercises SET requires_bench = TRUE WHERE id = ANY($1) AND requires_bench = FALSE`,
    [ids],
  )

  const after = await pool.query(
    `SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND requires_bench = TRUE`,
    [ids],
  )

  console.log(`\n=== Summary ===`)
  console.log(`Rows updated this run: ${rowCount} (0 on a re-run — idempotent)`)
  console.log(`Now TRUE: ${after.rows[0].c} / ${ids.length}`)

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
