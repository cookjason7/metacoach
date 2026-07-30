/**
 * backfill-requires-bench.js — sets requires_bench = TRUE for the 176 exercises
 * confirmed to need a flat/incline/decline bench, from a read-only audit that
 * checked every row matching name/instructions ~* 'bench' (186 total) and
 * excluded:
 *
 *   - 6 false positives where "bench" appears but no furniture is required:
 *     Bench Jump (72), Bench Sprint (76), Depth Jump Leap (207), Linear Depth
 *     Jump (424) — all use "box or bench" as an interchangeable plyo platform,
 *     not a specific piece of furniture; Barbell Rear Delt Row (56) and One Arm
 *     Floor Press (510) mention "bench press" only as a descriptive comparison
 *     ("resembles a bench press in reverse" / "similar to a bench press") while
 *     the actual exercise is standing or floor-based.
 *   - 4 ambiguous rows left at the FALSE default because a bench is optional or
 *     substitutable, not the exercise's basis: Barbell Squat To A Bench (65,
 *     "flat bench or a box"), Cable Internal Rotation (118, "can use a flat
 *     bench... instead"), Decline Push-Up (203, "box or bench"), One-Arm Side
 *     Laterals (504, bench used only as an optional balance aid).
 *
 * Idempotent — the UPDATE only touches rows currently FALSE, so a re-run after
 * the first successful application is a no-op (rowCount 0).
 *
 * Usage:
 *   node server/scripts/backfill-requires-bench.js
 */

import 'dotenv/config'
import { pool } from '../db.js'

const REQUIRES_BENCH_IDS = [
  12, 24, 26, 27, 41, 44, 46, 52, 53, 54, 57, 58, 59, 66, 71, 73, 74, 75, 77, 78,
  81, 90, 106, 116, 117, 121, 123, 129, 130, 133, 147, 148, 171, 172, 174, 181,
  189, 195, 196, 197, 198, 199, 200, 201, 202, 204, 205, 222, 223, 227, 228, 229,
  231, 232, 233, 234, 235, 236, 238, 242, 243, 244, 248, 250, 254, 264, 271, 272,
  273, 274, 278, 286, 291, 294, 298, 310, 331, 332, 336, 337, 339, 340, 341, 342,
  343, 344, 345, 346, 347, 364, 390, 394, 429, 437, 438, 439, 440, 442, 447, 448,
  450, 452, 453, 455, 456, 464, 475, 481, 483, 484, 486, 508, 509, 512, 513, 517,
  528, 529, 530, 531, 537, 554, 555, 556, 563, 580, 586, 589, 590, 596, 619, 620,
  621, 622, 623, 624, 630, 631, 632, 633, 634, 635, 636, 645, 646, 647, 652, 653,
  654, 697, 699, 702, 703, 705, 706, 709, 715, 722, 727, 760, 775, 778, 788, 794,
  796, 797, 813, 830, 848, 849, 853, 854, 855, 856, 857, 873,
]

async function main() {
  if (REQUIRES_BENCH_IDS.length !== 176) {
    throw new Error(`Expected 176 ids, got ${REQUIRES_BENCH_IDS.length} — refusing to run against a stale list`)
  }

  const before = await pool.query(
    `SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND requires_bench = TRUE`,
    [REQUIRES_BENCH_IDS],
  )
  console.log(`Already TRUE before this run: ${before.rows[0].c} / ${REQUIRES_BENCH_IDS.length}`)

  const { rowCount } = await pool.query(
    `UPDATE exercises SET requires_bench = TRUE WHERE id = ANY($1) AND requires_bench = FALSE`,
    [REQUIRES_BENCH_IDS],
  )

  const after = await pool.query(
    `SELECT count(*)::int AS c FROM exercises WHERE id = ANY($1) AND requires_bench = TRUE`,
    [REQUIRES_BENCH_IDS],
  )
  const missing = await pool.query(
    `SELECT id, name FROM exercises WHERE id = ANY($1)`,
    [REQUIRES_BENCH_IDS],
  )

  console.log(`\n=== Summary ===`)
  console.log(`Rows updated this run: ${rowCount} (0 on a re-run — idempotent)`)
  console.log(`Now TRUE: ${after.rows[0].c} / ${REQUIRES_BENCH_IDS.length}`)
  console.log(`Ids found in exercises table: ${missing.rows.length} / ${REQUIRES_BENCH_IDS.length}`)
  if (missing.rows.length !== REQUIRES_BENCH_IDS.length) {
    const foundIds = new Set(missing.rows.map(r => r.id))
    const notFound = REQUIRES_BENCH_IDS.filter(id => !foundIds.has(id))
    console.warn(`WARNING — ids not found in exercises table (deleted since the audit?): ${notFound.join(', ')}`)
  }

  await pool.end()
}

main().catch(err => { console.error('ERROR:', err); process.exit(1) })
