const VALID_SLOTS = new Set([
  'Breakfast', 'Lunch', 'Dinner', 'Snack',
  'AM Snack', 'PM Snack', 'Late Snack',
])

const VALID_UNITS_LOWER = new Set([
  'item', 'items',
  'g', 'gram', 'grams',
  'oz', 'ounce', 'ounces',
  'cup', 'cups',
  'tbsp', 'tablespoon', 'tablespoons',
  'tsp', 'teaspoon', 'teaspoons',
  'slice', 'slices',
  'scoop', 'scoops',
  'serving', 'servings',
  'ml', 'milliliter', 'milliliters',
  'fl oz',
])

const MACRO_CAP = 10000
const CAL_CAP   = 100000
const MICRO_KEY_LIMIT = 100

function numericField(val, cap, label) {
  if (val === undefined || val === null || val === '') return { ok: true, value: null }
  const n = Number(val)
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number` }
  if (n < 0)               return { ok: false, error: `${label} must not be negative` }
  if (n > cap)             return { ok: false, error: `${label} exceeds maximum allowed value (${cap})` }
  return { ok: true, value: n }
}

function normalizeMicronutrients(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  let obj = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch {
      return { ok: false, error: 'micronutrients must be a valid JSON object' }
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
    return { ok: false, error: 'micronutrients must be a plain object' }
  }
  if (Object.keys(obj).length > MICRO_KEY_LIMIT) {
    return { ok: false, error: `micronutrients must not exceed ${MICRO_KEY_LIMIT} keys` }
  }
  const cleaned = {}
  for (const k of Object.keys(obj)) {
    const n = Number(obj[k])
    if (Number.isFinite(n) && n >= 0) cleaned[k] = n
  }
  return { ok: true, value: Object.keys(cleaned).length ? cleaned : null }
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

/**
 * Validate and normalize a raw meal payload from req.body.
 *
 * partial=false (creation): meal_name required; all macro/slot/date fields set to null if absent.
 * partial=true  (update):   all fields optional; only provided fields appear in data.
 *
 * Canonical output keys: meal_name, calories, protein, carbs, fat, fiber, sugar,
 *   meal_slot, log_date, serving_size, serving_unit, source_type, source_label,
 *   is_verified, micronutrients.
 *
 * @param {object} body - raw request body
 * @param {{ partial?: boolean }} opts
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function normalizeMealPayload(body, { partial = false } = {}) {
  const data = {}

  // ── meal_name ────────────────────────────────────────────────────────────────
  if (has(body, 'meal_name')) {
    if (typeof body.meal_name !== 'string') return { ok: false, error: 'meal_name must be a string' }
    const trimmed = body.meal_name.trim()
    if (!trimmed) return { ok: false, error: 'Meal name cannot be empty' }
    data.meal_name = trimmed
  } else if (!partial) {
    return { ok: false, error: 'Meal name required' }
  }

  // ── numeric macros ───────────────────────────────────────────────────────────
  // [canonical, aliases, cap]
  const MACROS = [
    ['calories', ['calories'],             CAL_CAP],
    ['protein',  ['protein', 'protein_g'], MACRO_CAP],
    ['carbs',    ['carbs',   'carbs_g'],   MACRO_CAP],
    ['fat',      ['fat',     'fat_g'],     MACRO_CAP],
    ['fiber',    ['fiber',   'fiber_g'],   MACRO_CAP],
    ['sugar',    ['sugar',   'sugar_g'],   MACRO_CAP],
  ]
  for (const [canonical, aliases, cap] of MACROS) {
    const key = aliases.find(a => has(body, a))
    if (key !== undefined) {
      const r = numericField(body[key], cap, canonical)
      if (!r.ok) return { ok: false, error: r.error }
      data[canonical] = r.value
    } else if (!partial) {
      data[canonical] = null
    }
  }

  // ── meal_slot ────────────────────────────────────────────────────────────────
  if (has(body, 'meal_slot')) {
    const slot = body.meal_slot
    if (slot !== null && slot !== undefined && slot !== '') {
      if (!VALID_SLOTS.has(slot)) {
        return { ok: false, error: `Invalid meal_slot "${slot}". Allowed: ${[...VALID_SLOTS].join(', ')}` }
      }
      data.meal_slot = slot
    } else {
      data.meal_slot = null
    }
  } else if (!partial) {
    data.meal_slot = null
  }

  // ── log_date ─────────────────────────────────────────────────────────────────
  if (has(body, 'log_date')) {
    const raw = body.log_date
    if (raw !== null && raw !== undefined && raw !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
        return { ok: false, error: 'log_date must be in YYYY-MM-DD format' }
      }
      const d = new Date(raw + 'T00:00:00Z')
      if (isNaN(d.getTime())) return { ok: false, error: 'log_date is not a valid date' }
      const maxFuture = new Date()
      maxFuture.setUTCDate(maxFuture.getUTCDate() + 7)
      if (d > maxFuture) return { ok: false, error: 'log_date cannot be more than 7 days in the future' }
      data.log_date = raw
    } else {
      data.log_date = null
    }
  } else if (!partial) {
    data.log_date = null
  }

  // ── serving_size ─────────────────────────────────────────────────────────────
  if (has(body, 'serving_size')) {
    const raw = body.serving_size
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'serving_size must be a positive number' }
      data.serving_size = n
    } else {
      data.serving_size = null
    }
  }

  // ── serving_unit ─────────────────────────────────────────────────────────────
  if (has(body, 'serving_unit')) {
    const unit = body.serving_unit
    if (unit !== null && unit !== undefined && unit !== '') {
      if (typeof unit !== 'string') return { ok: false, error: 'serving_unit must be a string' }
      if (!VALID_UNITS_LOWER.has(unit.trim().toLowerCase())) {
        return { ok: false, error: `Invalid serving_unit "${unit}"` }
      }
      data.serving_unit = unit.trim()
    } else {
      data.serving_unit = null
    }
  }

  // ── source_type (accepts _source alias) ──────────────────────────────────────
  const rawSourceType = has(body, 'source_type') ? body.source_type
    : has(body, '_source')    ? body._source
    : undefined
  if (rawSourceType !== undefined) {
    if (rawSourceType !== null && rawSourceType !== '') {
      if (typeof rawSourceType !== 'string') return { ok: false, error: 'source_type must be a string' }
      data.source_type = rawSourceType.trim().slice(0, 255)
    } else {
      data.source_type = null
    }
  }

  // ── source_label ─────────────────────────────────────────────────────────────
  if (has(body, 'source_label')) {
    const v = body.source_label
    if (v !== null && v !== undefined && v !== '') {
      if (typeof v !== 'string') return { ok: false, error: 'source_label must be a string' }
      data.source_label = v.trim().slice(0, 255)
    } else {
      data.source_label = null
    }
  }

  // ── is_verified ───────────────────────────────────────────────────────────────
  if (has(body, 'is_verified')) {
    data.is_verified = body.is_verified === true || body.is_verified === 'true' || body.is_verified === 1
  }

  // ── micronutrients ────────────────────────────────────────────────────────────
  if (has(body, 'micronutrients')) {
    const r = normalizeMicronutrients(body.micronutrients)
    if (!r.ok) return { ok: false, error: r.error }
    data.micronutrients = r.value
  }

  return { ok: true, data }
}
