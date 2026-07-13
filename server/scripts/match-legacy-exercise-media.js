/**
 * match-legacy-exercise-media.js — one-time-ish population of
 * exercise_library.legacy_exercise_id, so the coach-facing UI can reuse
 * image_url from the legacy free-exercise-db `exercises` table (873 rows).
 * exercise_library was never seeded with its own media.
 *
 * Matching: exact match on a normalized name (lowercase, strip parenthetical
 * asides, collapse non-alphanumerics to single spaces) — the same logic used
 * to investigate the match rate. Only ~20% of exercise_library rows match;
 * the rest are Programming-Guide-specific drills (foam roll body parts, band
 * circuit exercises, plyo progressions, etc.) that never existed in the
 * legacy import at all — not a matching-algorithm gap. A bigram-similarity
 * check on the unmatched set found only ~19/199 candidates at >=0.6
 * similarity, and several of those are confidently WRONG (e.g. "Barbell
 * Back Squat" nearest-matches "Barbell Hack Squat" — a different exercise),
 * so fuzzy matching is intentionally NOT used here — false media on the
 * wrong exercise is worse than no media.
 *
 * Idempotent — safe to re-run (plain UPDATE by id, no INSERT).
 *
 * Usage:
 *   node server/scripts/match-legacy-exercise-media.js
 */

import 'dotenv/config'
import { migrate, pool } from '../db.js'

const norm = (s) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

async function run() {
  await migrate()

  const lib = await pool.query(`SELECT id, name, category, legacy_exercise_id FROM exercise_library ORDER BY id`)
  const legacy = await pool.query(`SELECT id, name FROM exercises`)

  const legacyMap = new Map()
  for (const row of legacy.rows) {
    const n = norm(row.name)
    // First seed source_program wins on a collision — legacy names aren't
    // unique after normalization (e.g. duplicate "Squat" variants); this is
    // a reasonable-not-perfect choice, consistent with everything else in
    // this matching pass being best-effort.
    if (!legacyMap.has(n)) legacyMap.set(n, row)
  }

  let matched = 0
  let unchanged = 0
  const unmatchedNames = []

  for (const row of lib.rows) {
    const legacyRow = legacyMap.get(norm(row.name))
    if (!legacyRow) {
      unmatchedNames.push(row.name)
      continue
    }
    if (row.legacy_exercise_id === legacyRow.id) {
      unchanged++
      continue
    }
    await pool.query(`UPDATE exercise_library SET legacy_exercise_id = $1 WHERE id = $2`, [legacyRow.id, row.id])
    matched++
  }

  console.log(`exercise_library rows: ${lib.rows.length}`)
  console.log(`Newly matched this run: ${matched}`)
  console.log(`Already matched (unchanged): ${unchanged}`)
  console.log(`Unmatched (no legacy counterpart): ${unmatchedNames.length}`)

  const { rows: totalLinked } = await pool.query(`SELECT COUNT(*) FROM exercise_library WHERE legacy_exercise_id IS NOT NULL`)
  console.log(`Total exercise_library rows now linked: ${totalLinked[0].count} / ${lib.rows.length}`)

  await pool.end()
}

run().catch(err => {
  console.error('Match failed:', err)
  process.exit(1)
})
