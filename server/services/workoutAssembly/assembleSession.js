/**
 * assembleSession.js — orchestrates a single A or B day session:
 *   warm-up (foam_roll, mobility, activation, bands, plyo)
 *     -> main lift + accessory/movement-pattern work (program_day_patterns)
 *     -> cooldown (core, finisher)
 *
 * foam_roll, activation, and finisher are intentionally coach-editable
 * placeholders — they appear in the output shape (always `[]`) but are NOT
 * auto-picked by this module. This is deliberate, not a bug: a coach fills
 * these in manually later. Everything else (mobility, bands, plyo, main/
 * circuit work, core) is real rule-based selection. See git history for
 * why: foam_roll had real picking logic that intermittently returned zero
 * picks on certain equipment profiles (a pre-existing data-tagging gap, not
 * fixed here — simplified to a placeholder instead of chasing it); activation
 * never had a picker at all (no program_templates.block_type mapping was
 * ever wired up); finisher was auto-picked but was never meant to be
 * (should always be coach-assigned).
 *
 * `stretch` (also named in program_templates.block_type) has never been
 * implemented here at all — no key, no picker, not a placeholder. Flagging
 * so it isn't mistaken for a regression; out of scope for this change.
 *
 * Purely rule-based selection against exercise_library/program_day_patterns/
 * volume_rules/program_templates — Katie (the AI coach) is not called here
 * and has no role in exercise selection, volume, or assembly. If Katie-authored
 * notes are ever attached to a session, they must be layered on separately,
 * after assembly, without altering the exercises/sets/reps this module picks.
 */

import { pickMainLift } from './mainLifts.js'
import { pickMobility, pickBands, pickPlyo, pickCore } from './categoryFilters.js'
import { getMainLiftVolume, getWarmupSlotCounts, getRepScheme, INVENTED_SLOT_COUNTS } from './volumeRules.js'

const CORE_SUBTYPES = ['anti_extension', 'anti_rotation', 'anti_lateral_flexion']

async function getDayPattern(pool, dayLabel) {
  const { rows } = await pool.query(
    'SELECT movement_pattern, sequence FROM program_day_patterns WHERE day_label = $1 ORDER BY sequence',
    [dayLabel],
  )
  if (rows.length === 0) {
    throw new Error(`No program_day_patterns rows for day_label "${dayLabel}" — check server/db.js seed`)
  }
  return rows.map(r => r.movement_pattern)
}

async function buildWarmup(pool, { equipment, level, slotCounts }) {
  const [mobility, bands, plyo] = await Promise.all([
    pickMobility(pool, { equipment, level, count: slotCounts.mobility }),
    pickBands(pool, { equipment, count: INVENTED_SLOT_COUNTS.bands }),
    pickPlyo(pool, { equipment, level, count: slotCounts.plyo }),
  ])
  // foam_roll and activation are intentionally left empty — coach-filled
  // slots, not auto-assigned (see module header). Keys stay present so
  // callers/UI have a stable shape to render as editable, empty slots.
  return {
    foam_roll: [],
    mobility: mobility.map(e => ({ exercise: e, prescription: getRepScheme('mobility') })),
    activation: [],
    bands: bands.map(e => ({ exercise: e, prescription: getRepScheme('bands') })),
    plyo: plyo.map(e => ({ exercise: e, prescription: getRepScheme('plyo', e.plyo_level) })),
  }
}

async function buildMainWork(pool, { dayLabel, rotationIndex, volume, equipment }) {
  const patterns = await getDayPattern(pool, dayLabel)
  const slots = []
  const warnings = []
  for (const movementPattern of patterns) {
    const { exercise, equipmentMismatch } = await pickMainLift(pool, movementPattern, { rotationIndex, equipment })
    slots.push({ movementPattern, exercise, prescription: { sets: volume.sets, repRange: volume.rep_range } })
    if (equipmentMismatch) {
      warnings.push(`No main_lift option for "${movementPattern}" fits available equipment — defaulted to "${exercise.name}" (needs ${exercise.equipment_required.join(', ')}).`)
    }
  }
  return { slots, warnings }
}

async function buildCooldown(pool, { equipment, slotCounts }) {
  const excludeNames = []
  const core = []
  for (let i = 0; i < slotCounts.core; i++) {
    const coreSubtype = CORE_SUBTYPES[i % CORE_SUBTYPES.length]
    const [picked] = await pickCore(pool, { equipment, coreSubtype, count: 1, excludeNames })
    if (picked) {
      core.push({ exercise: picked, prescription: getRepScheme('core') })
      excludeNames.push(picked.name)
    }
  }
  // Finisher is intentionally left empty here — it's a coach-filled slot, not
  // auto-assigned by the rules engine. The key stays present so callers/UI
  // have a stable shape to render as an editable, empty "Finisher" slot.
  return {
    core,
    finisher: [],
  }
}

/**
 * @param {string} dayLabel - 'A' | 'B'
 * @param {number} [sessionLength] - 20|30|45|60|90, matches program_templates.session_length
 * @param {string} [goal] - strength|power|hypertrophy|endurance, matches volume_rules.goal
 * @param {string} [level] - beginner|intermediate|advanced, filters level_min + plyo_level
 * @param {string[]} [equipment] - available equipment; 'bodyweight' is assumed always available
 * @param {number} [rotationIndex] - cycles main-lift pool selection (e.g. pass week number)
 */
async function assembleSession(pool, {
  dayLabel,
  sessionLength = 60,
  goal = 'hypertrophy',
  level = 'advanced',
  equipment = ['bodyweight'],
  rotationIndex = 0,
} = {}) {
  if (dayLabel !== 'A' && dayLabel !== 'B') {
    throw new Error(`dayLabel must be "A" or "B", got "${dayLabel}"`)
  }
  const equipmentWithBodyweight = equipment.includes('bodyweight') ? equipment : [...equipment, 'bodyweight']

  const [slotCounts, volume] = await Promise.all([
    getWarmupSlotCounts(pool, sessionLength),
    getMainLiftVolume(pool, goal),
  ])

  const [warmup, mainResult, cooldown] = await Promise.all([
    buildWarmup(pool, { equipment: equipmentWithBodyweight, level, slotCounts }),
    buildMainWork(pool, { dayLabel, rotationIndex, volume, equipment: equipmentWithBodyweight }),
    buildCooldown(pool, { equipment: equipmentWithBodyweight, slotCounts }),
  ])

  return {
    dayLabel, sessionLength, goal, level, warmup, cooldown,
    main: mainResult.slots,
    warnings: mainResult.warnings,
  }
}

/** Convenience wrapper for a simple A/B rotation across N sessions. */
function getDayLabelForSession(sessionIndex) {
  return sessionIndex % 2 === 0 ? 'A' : 'B'
}

export { assembleSession, getDayLabelForSession, getDayPattern }
