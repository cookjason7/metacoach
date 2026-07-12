/**
 * mainLifts.js — main-lift slot selection for the A/B session assembler.
 *
 * Queries exercise_library directly by movement_pattern (category='main_lift')
 * instead of a hardcoded name allowlist. This naturally merges every
 * main_lift source_program into one pool per pattern — both the original 27
 * 'Main Lifts (temp)' rows (seed-main-lifts.js) and the 42
 * 'Main Lifts (Movement Pattern Review)' rows (seed-main-lifts-final.js) are
 * eligible candidates; nothing in exercise_library was deleted or renamed to
 * make this work.
 *
 * Ordered by id (insertion order) for deterministic, stable rotation via
 * rotationIndex — replaces the previous fixed declaration order of
 * MAIN_LIFT_POOL.
 */

/**
 * Looks up one main_lift exercise_library row for the given movement
 * pattern. rotationIndex lets callers cycle through the pool (e.g. pass the
 * week number) instead of always getting the same lift for a pattern.
 *
 * If `equipment` is passed, prefers rows the client can actually do
 * (equipment_required subset of `equipment`) and rotates within that subset.
 * Some patterns may have no bodyweight-only option at all — when nothing
 * matches, falls back to the full pattern pool and sets
 * `equipmentMismatch: true` so the caller can surface a warning instead of
 * silently assigning an unusable lift.
 */
async function pickMainLift(pool, movementPattern, { rotationIndex = 0, equipment = null } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM exercise_library
     WHERE category = 'main_lift' AND movement_pattern = $1 AND active = TRUE
     ORDER BY id`,
    [movementPattern],
  )
  if (rows.length === 0) {
    throw new Error(
      `No main_lift rows found for pattern "${movementPattern}" — run seed-main-lifts.js and seed-main-lifts-final.js`,
    )
  }

  const candidates = equipment
    ? rows.filter(r => r.equipment_required.every(eq => equipment.includes(eq)))
    : rows
  const equipmentMismatch = equipment != null && candidates.length === 0
  const usable = candidates.length > 0 ? candidates : rows

  const exercise = usable[rotationIndex % usable.length]
  return { exercise, equipmentMismatch }
}

export { pickMainLift }
