/**
 * server/services/workoutValidation.js
 *
 * Deterministic (no AI) safety net applied to a generated workout plan after
 * Katie's response is merged with the DB-selected exercises, and before the
 * plan is returned to the coach review screen. Exercise selection is already
 * constrained at the DB-query level (equipment, blocked names — see
 * pickExercise in workoutGenerator.js) and the day quota order already
 * prevents adjacent lower-body slots, so these checks should rarely fire in
 * practice. They exist as a last line of defense against regressions and
 * skipped-slot side effects (e.g. a missing push slot puts squat and hinge
 * back to back), not as the primary filtering mechanism.
 */

const LOWER_BODY_PATTERNS = new Set(['squat_bilateral', 'squat_unilateral', 'hinge_bilateral', 'hinge_unilateral'])

const PATTERN_DISPLAY = {
  squat_bilateral: 'squat', squat_unilateral: 'squat',
  hinge_bilateral: 'hinge', hinge_unilateral: 'hinge',
  upper_push: 'push', upper_pull: 'pull', core: 'core', carry: 'carry', conditioning: 'conditioning',
}

function equipmentDisplay(equipmentList) {
  return equipmentList?.length ? equipmentList.join(', ') : "the client's available equipment"
}

/**
 * Mutates and returns `plan` (the object returned by mergeResponse):
 *   1. Equipment mismatch — an exercise's equipment isn't in the client's equipmentList.
 *   2. Sequence — two lower-body pattern exercises (squat/hinge) land back to back.
 *   3. Blocked exercise names — matches the same block list used at selection time,
 *      except for an exercise carrying `block_bypass_approved` (see below).
 * Flagged exercises get their name replaced with a bracketed coach-facing note and
 * `flagged: true` / `flag_reason` set; flagged days get a `sequence_warning` string.
 *
 * @param {object} plan - { program_name, description, days: [{ day_name, focus, exercises }] }
 * @param {object} [opts]
 * @param {string[]|null} [opts.equipmentList] - resolved equipment filter used at selection time (null = no restriction)
 * @param {string|null} [opts.blockedNamePattern] - regex source string of names that must never appear
 */
export function validateWorkoutPlan(plan, { equipmentList = null, blockedNamePattern = null } = {}) {
  const blockedRe = blockedNamePattern ? new RegExp(blockedNamePattern, 'i') : null

  for (const day of plan.days ?? []) {
    let prevPattern = null
    let sequenceFlagged = false

    for (const ex of day.exercises ?? []) {
      if (!ex.movement_pattern) {
        // Warm-Up / Cool-Down rows carry no movement_pattern and don't break the lower-body-adjacency chain.
        prevPattern = null
        continue
      }

      const patternLabel = PATTERN_DISPLAY[ex.movement_pattern] ?? ex.movement_pattern
      // `block_bypass_approved` is set only by the pull-slot fallback ladder
      // (workoutGenerator.js fillPullSlot), which lifts the fitness-level name block
      // for a single slot when every equipment-matched pull is on that list. Blanking
      // the name here would leave the day with push work and no pull — the exact
      // silent failure that ladder exists to prevent — so the pick stands, already
      // carrying flagged/flag_reason/flag_note for the coach. Global-safety and
      // injury exclusions are never bypassed there, so this can't hide those.
      const isBlocked = blockedRe && !ex.block_bypass_approved ? blockedRe.test(ex.name) : false
      // 'body only' requires literally zero equipment, and 'bands' are the other
      // value the vertical-pull Day 3 preference (workoutGenerator.js) deliberately
      // widens equipment matching to include — both are always performable
      // regardless of the client's selected equipment, so neither is ever a real
      // mismatch even for clients who selected other equipment.
      const isEquipmentMismatch = !isBlocked && !!equipmentList?.length && !!ex.equipment && ex.equipment !== 'body only' && ex.equipment !== 'bands' && !equipmentList.includes(ex.equipment)

      if (isBlocked) {
        ex.flagged = true
        ex.flag_reason = 'blocked_exercise'
        ex.name = `[BLOCKED EXERCISE — Coach: substitute with an appropriate ${patternLabel} exercise]`
      } else if (isEquipmentMismatch) {
        ex.flagged = true
        ex.flag_reason = 'equipment_mismatch'
        ex.name = `[EQUIPMENT MISMATCH — Coach: replace with a ${patternLabel} exercise using ${equipmentDisplay(equipmentList)}]`
      }

      if (LOWER_BODY_PATTERNS.has(ex.movement_pattern) && LOWER_BODY_PATTERNS.has(prevPattern)) {
        sequenceFlagged = true
      }
      prevPattern = ex.movement_pattern
    }

    if (sequenceFlagged) {
      day.sequence_warning = '[SEQUENCE WARNING — lower body exercises appear back to back, consider inserting a push or pull between them]'
    }
  }

  return plan
}
