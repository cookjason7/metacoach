/**
 * volumeRules.js — sets/reps/slot-count lookups for the session assembler.
 *
 * INFERRED (read from tables the guide already seeded — server/db.js):
 *   - Main-lift sets/reps come from `volume_rules`, keyed by goal.
 *   - Warm-up/core slot counts (how many exercises to pick) come from
 *     `program_templates.slot_count`, keyed by session_length + block_type.
 *
 * INVENTED (no seeded source covers these — flagged, not inferred):
 *   - `bands` and `finisher` have no block_type in program_templates, so
 *     their slot counts are hardcoded guesses (INVENTED_SLOT_COUNTS below).
 *   - Rep/duration schemes for foam_roll, mobility, bands, plyo, core,
 *     finisher — volume_rules only covers main lifts by goal; nothing seeded
 *     gives a rep scheme for bodyweight/band/plyo/core work, so
 *     INVENTED_REP_SCHEMES below are reasonable placeholders, not sourced
 *     data. Replace with real programming-guide numbers when available.
 *   - For the 'mobility' goal (Flexibility/Mobility), extra mobility/core
 *     slots on top of the normal session-length baseline — program_templates
 *     has no goal column, so it can't express "give this goal more warm-up
 *     volume than usual." INVENTED_MOBILITY_SLOT_BOOST below is a first-pass
 *     guess at how much to add, not sourced data.
 */

const DEFAULT_GOAL = 'hypertrophy'

// INVENTED — no program_templates.block_type entry for these two categories.
const INVENTED_SLOT_COUNTS = {
  bands: 1,
  finisher: 1,
}

// INVENTED — additional mobility/core slots layered on top of the normal
// session-length baseline when goal === 'mobility'. Main-lift work is
// skipped entirely for this goal (see assembleSession.js's buildMainWork),
// so leaning harder into warm-up/cooldown categories that already exist
// (mobility, core) is how a mobility-focused session gets real substance
// without inventing a new block_type or touching the locked-empty
// foam_roll/activation/stretch placeholders.
const INVENTED_MOBILITY_SLOT_BOOST = {
  mobility: 2,
  core: 1,
}

// INVENTED — placeholder rep/duration schemes, not sourced from seeded data.
const INVENTED_REP_SCHEMES = {
  foam_roll: '30-60 sec each',
  mobility: '8-10 reps each',
  bands: '2 rounds x 12-15 reps',
  plyo: {
    // Scales with plyo_level (1-4), which IS a real seeded column — the
    // scaling logic is a reasonable inference, but the specific rep numbers
    // below are invented, not sourced.
    1: '2x5', 2: '2x5', 3: '3x5', 4: '3x5',
  },
  core: '2-3 sets x 30-45 sec (or 10-15 reps)',
  finisher: '1 round to completion',
}

/** Real — reads volume_rules (goal, rep_range, sets_min, sets_max). */
async function getMainLiftVolume(pool, goal = DEFAULT_GOAL, orgId) {
  if (orgId == null) {
    throw new Error('getMainLiftVolume requires orgId — volume_rules is org-scoped')
  }
  const { rows } = await pool.query('SELECT * FROM volume_rules WHERE goal = $1 AND org_id = $2', [goal, orgId])
  if (rows.length === 0) {
    throw new Error(`No volume_rules row for goal "${goal}" (org ${orgId}) — check server/db.js seed`)
  }
  const { rep_range, sets_min, sets_max } = rows[0]
  return { goal, rep_range, sets_min, sets_max, sets: sets_max }
}

/**
 * Real — reads program_templates.slot_count for a given session length.
 * goal is optional; when 'mobility', INVENTED_MOBILITY_SLOT_BOOST is layered
 * on top (see comment above the constant).
 */
async function getWarmupSlotCounts(pool, sessionLength = 60, goal = null, orgId) {
  if (orgId == null) {
    throw new Error('getWarmupSlotCounts requires orgId — program_templates is org-scoped')
  }
  const { rows } = await pool.query(
    'SELECT block_type, slot_count FROM program_templates WHERE session_length = $1 AND org_id = $2',
    [sessionLength, orgId],
  )
  if (rows.length === 0) {
    throw new Error(`No program_templates rows for session_length=${sessionLength} (org ${orgId}) — check server/db.js seed`)
  }
  const counts = rows.reduce((acc, r) => {
    acc[r.block_type] = r.slot_count
    return acc
  }, {})
  if (goal === 'mobility') {
    for (const [blockType, boost] of Object.entries(INVENTED_MOBILITY_SLOT_BOOST)) {
      counts[blockType] = (counts[blockType] ?? 0) + boost
    }
  }
  return counts
}

function getRepScheme(category, plyoLevel = null) {
  const scheme = INVENTED_REP_SCHEMES[category]
  if (category === 'plyo') return scheme[plyoLevel] ?? scheme[1]
  return scheme
}

export { getMainLiftVolume, getWarmupSlotCounts, getRepScheme, INVENTED_SLOT_COUNTS, INVENTED_REP_SCHEMES, INVENTED_MOBILITY_SLOT_BOOST, DEFAULT_GOAL }
