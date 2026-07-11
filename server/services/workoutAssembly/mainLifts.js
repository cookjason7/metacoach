/**
 * mainLifts.js — main-lift slot selection for the A/B session assembler.
 *
 * // TODO: replace with main_lift tag filter once labeling is complete.
 * exercise_library.category = 'main_lift' currently only has the 20 rows
 * seeded by server/scripts/seed-main-lifts.js (a temp hand-picked list, not
 * a full transcription of the guide's main-lift section). Once a real
 * main_lift catalog is tagged, swap MAIN_LIFT_POOL + getMainLiftName() below
 * for a plain query — e.g.
 *   SELECT * FROM exercise_library
 *   WHERE category = 'main_lift' AND movement_pattern = $1 AND level_min <= $2
 * — and delete this hardcoded pool. Every other function in this module
 * (pickMainLift, its callers) stays the same; only the name lookup changes.
 */

const MAIN_LIFT_POOL = {
  squat:            ['Barbell Back Squat', 'Front Squat', 'Goblet Squat'],
  hinge:            ['Conventional Deadlift', 'Romanian Deadlift', 'Trap Bar Deadlift'],
  horizontal_push:  ['Barbell Bench Press', 'Dumbbell Bench Press', 'Push-up'],
  horizontal_pull:  ['Barbell Row', 'Dumbbell Row', 'Seated Cable Row'],
  vertical_push:    ['Overhead Press', 'Dumbbell Shoulder Press'],
  vertical_pull:    ['Pull-up', 'Lat Pulldown'],
  carry:            ["Farmer's Carry", 'Suitcase Carry'],
  lift:             ['Turkish Get-up', 'Kettlebell Clean and Press'],
}

function getMainLiftName(movementPattern, rotationIndex = 0) {
  const pool = MAIN_LIFT_POOL[movementPattern]
  if (!pool || pool.length === 0) {
    throw new Error(`No main lift names configured for movement pattern "${movementPattern}"`)
  }
  return pool[rotationIndex % pool.length]
}

/**
 * Looks up one main_lift exercise_library row for the given movement
 * pattern. rotationIndex lets callers cycle through the pool (e.g. pass the
 * week number) instead of always getting the same lift for a pattern.
 *
 * If `equipment` is passed, prefers pool entries the client can actually do
 * (equipment_required subset of `equipment`) and rotates within that subset.
 * Several patterns (e.g. hinge, vertical_push) have no bodyweight option in
 * the temp pool at all — when nothing matches, falls back to the full pool
 * and sets `equipmentMismatch: true` so the caller can surface a warning
 * instead of silently assigning an unusable lift.
 */
async function pickMainLift(pool, movementPattern, { rotationIndex = 0, equipment = null } = {}) {
  const names = MAIN_LIFT_POOL[movementPattern]
  if (!names || names.length === 0) {
    throw new Error(`No main lift names configured for movement pattern "${movementPattern}"`)
  }
  const { rows } = await pool.query(
    `SELECT * FROM exercise_library WHERE category = 'main_lift' AND name = ANY($1) AND active = TRUE`,
    [names],
  )
  if (rows.length === 0) {
    throw new Error(
      `No main_lift rows found for pattern "${movementPattern}" (expected ${names.join(', ')}) — run seed-main-lifts.js`,
    )
  }
  // Preserve MAIN_LIFT_POOL's declared order regardless of what order SQL returned rows in.
  const ordered = names.map(n => rows.find(r => r.name === n)).filter(Boolean)

  const candidates = equipment
    ? ordered.filter(r => r.equipment_required.every(eq => equipment.includes(eq)))
    : ordered
  const equipmentMismatch = equipment != null && candidates.length === 0
  const usable = candidates.length > 0 ? candidates : ordered

  const exercise = usable[rotationIndex % usable.length]
  return { exercise, equipmentMismatch }
}

export { MAIN_LIFT_POOL, getMainLiftName, pickMainLift }
