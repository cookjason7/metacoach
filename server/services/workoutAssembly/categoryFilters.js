/**
 * categoryFilters.js — attribute-based selection for the categories that are
 * fully tagged in exercise_library: foam_roll, mobility, bands (mini_band +
 * big_band), plyo, core, finisher.
 *
 * None of these categories use the `movement_pattern` column (that's
 * main_lift-only — see mainLifts.js) — each has its own real attributes to
 * filter on instead: equipment_required, level_min, plane, unilateral,
 * plyo_level/plyo_type, core_subtype.
 */

const LEVEL_RANK = { beginner: 1, intermediate: 2, advanced: 3 }

/** Generic query builder shared by every category-specific picker below. */
async function filterExercises(pool, {
  categories,
  orgId,
  equipment = ['bodyweight'],
  level = 'advanced',
  plane = null,
  unilateral = null,
  coreSubtype = null,
  maxPlyoLevel = null,
  excludeNames = [],
  limit = 1,
}) {
  if (orgId == null) {
    throw new Error('filterExercises requires orgId — exercise_library is org-scoped')
  }
  const clauses = ['category = ANY($1)', 'active = TRUE', 'equipment_required <@ $2::text[]', 'org_id = $3']
  const params = [categories, equipment, orgId]

  const levelRank = LEVEL_RANK[level] ?? LEVEL_RANK.advanced
  clauses.push(`CASE level_min WHEN 'beginner' THEN 1 WHEN 'intermediate' THEN 2 ELSE 3 END <= $${params.length + 1}`)
  params.push(levelRank)

  if (plane) {
    clauses.push(`plane = $${params.length + 1}`)
    params.push(plane)
  }
  if (unilateral !== null) {
    clauses.push(`unilateral = $${params.length + 1}`)
    params.push(unilateral)
  }
  if (coreSubtype) {
    // core_subtype IS NULL rows are general-purpose — eligible for any of the
    // three subtype slots, in addition to exercises tagged with this exact
    // subtype (e.g. the 5 Movement Pattern Review core rows, which don't
    // specify one).
    clauses.push(`(core_subtype = $${params.length + 1} OR core_subtype IS NULL)`)
    params.push(coreSubtype)
  }
  if (maxPlyoLevel !== null) {
    clauses.push(`plyo_level <= $${params.length + 1}`)
    params.push(maxPlyoLevel)
  }
  if (excludeNames.length > 0) {
    clauses.push(`name != ALL($${params.length + 1}::text[])`)
    params.push(excludeNames)
  }

  params.push(limit)
  const { rows } = await pool.query(
    `SELECT * FROM exercise_library WHERE ${clauses.join(' AND ')} ORDER BY RANDOM() LIMIT $${params.length}`,
    params,
  )
  return rows
}

const pickFoamRoll = (pool, { orgId, equipment, count = 1, excludeNames = [] } = {}) =>
  filterExercises(pool, { categories: ['foam_roll'], orgId, equipment, limit: count, excludeNames })

const pickMobility = (pool, { orgId, equipment, level, count = 1, excludeNames = [] } = {}) =>
  filterExercises(pool, { categories: ['mobility'], orgId, equipment, level, limit: count, excludeNames })

const pickBands = (pool, { orgId, equipment, count = 1, excludeNames = [] } = {}) =>
  filterExercises(pool, { categories: ['mini_band', 'big_band'], orgId, equipment, limit: count, excludeNames })

// Beginner clients cap at plyo_level 2; intermediate/advanced can see all 4.
const pickPlyo = (pool, { orgId, equipment, level, plane = null, count = 1, excludeNames = [] } = {}) =>
  filterExercises(pool, {
    categories: ['plyo'], orgId, equipment, level, plane, excludeNames,
    maxPlyoLevel: level === 'beginner' ? 2 : 4,
    limit: count,
  })

const pickCore = (pool, { orgId, equipment, coreSubtype = null, count = 1, excludeNames = [] } = {}) =>
  filterExercises(pool, { categories: ['core'], orgId, equipment, coreSubtype, limit: count, excludeNames })

const pickFinisher = (pool, { orgId, equipment, count = 1, excludeNames = [] } = {}) =>
  filterExercises(pool, { categories: ['finisher'], orgId, equipment, limit: count, excludeNames })

export { filterExercises, pickFoamRoll, pickMobility, pickBands, pickPlyo, pickCore, pickFinisher, LEVEL_RANK }
