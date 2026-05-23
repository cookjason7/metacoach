/**
 * server/services/usdaApi.js
 *
 * Thin wrapper around the USDA FoodData Central REST API.
 * Used as a fallback when local database results are sparse, and as the
 * primary source for barcode / branded-food lookups.
 *
 * Get a free API key at: https://api.nal.usda.gov/
 * Set it in server/.env as USDA_API_KEY=<your key>
 * DEMO_KEY works for development (1,000 req/hour per IP).
 */

const API_KEY  = process.env.USDA_API_KEY || 'DEMO_KEY'
const BASE_URL = 'https://api.nal.usda.gov/fdc/v1'
const TIMEOUT  = 5000   // ms — don't let a slow USDA API stall our response

// ── Nutrient ID → our response field name ─────────────────────────────────────
// Covers both the /foods/search format (nutrientId + value)
// and the /food/{id} format (nutrient.id + amount).
const NUTRIENT_FIELDS = {
  1008: 'calories',
  1003: 'protein_g',
  1004: 'fat_g',
  1005: 'carbs_g',
  1079: 'fiber_g',
  1093: 'sodium_mg',
  1092: 'potassium_mg',
  1087: 'calcium_mg',
  1089: 'iron_mg',
  1114: 'vitamin_d_mcg',
  1090: 'magnesium_mg',
}

const NUTRIENT_NUMBERS = {
  208: 'calories',
  203: 'protein_g',
  204: 'fat_g',
  205: 'carbs_g',
  291: 'fiber_g',
  307: 'sodium_mg',
  306: 'potassium_mg',
  301: 'calcium_mg',
  303: 'iron_mg',
  328: 'vitamin_d_mcg',
  304: 'magnesium_mg',
}

const NUTRIENT_NAME_FIELDS = [
  [/energy|calorie/i, 'calories'],
  [/protein/i, 'protein_g'],
  [/total lipid|total fat|fat/i, 'fat_g'],
  [/carbohydrate/i, 'carbs_g'],
  [/fiber|fibre/i, 'fiber_g'],
  [/sodium/i, 'sodium_mg'],
  [/potassium/i, 'potassium_mg'],
  [/calcium/i, 'calcium_mg'],
  [/iron/i, 'iron_mg'],
  [/vitamin d/i, 'vitamin_d_mcg'],
  [/magnesium/i, 'magnesium_mg'],
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * fetch() with an AbortController timeout so a hanging USDA request never
 * blocks our API response indefinitely.
 */
async function fetchWithTimeout(url) {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`USDA API ${res.status}: ${url}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extracts the five macros from a foodNutrients array.
 *
 * USDA /foods/search returns:
 *   { nutrientId: 1003, value: 22.5, ... }
 *
 * USDA /food/{fdcId} returns:
 *   { nutrient: { id: 1003 }, amount: 22.5, ... }
 *
 * Both formats are handled here.
 */
function nutrientField(fn) {
  const id = Number(fn.nutrientId ?? fn.nutrient?.id ?? fn.nutrient?.nutrientId)
  if (NUTRIENT_FIELDS[id]) return NUTRIENT_FIELDS[id]

  const number = Number(fn.nutrientNumber ?? fn.nutrient?.number ?? fn.nutrient?.nutrientNumber)
  if (NUTRIENT_NUMBERS[number]) return NUTRIENT_NUMBERS[number]

  const name = fn.nutrientName ?? fn.nutrient?.name
  if (!name) return null
  const found = NUTRIENT_NAME_FIELDS.find(([pattern]) => pattern.test(name))
  return found?.[1] ?? null
}

function extractMacros(foodNutrients = []) {
  const out = {}
  for (const fn of foodNutrients) {
    const amount = fn.value ?? fn.amount
    const field = nutrientField(fn)
    if (field && amount != null && !Number.isNaN(Number(amount))) {
      out[field] = Math.round(Number(amount) * 10) / 10
    }
  }
  return out
}

/**
 * Converts a raw USDA food object into the same shape our local DB returns,
 * so the client receives a consistent response regardless of source.
 */
function formatFood(raw) {
  const macros = extractMacros(raw.foodNutrients)
  return {
    id:         null,               // no local UUID — USDA-only result
    fdc_id:     raw.fdcId,
    name:       raw.description,
    brand:      raw.brandOwner || raw.brandName || null,
    data_type:  raw.dataType ?? 'Branded',
    calories:   macros.calories  ?? null,
    protein_g:  macros.protein_g ?? null,
    fat_g:      macros.fat_g     ?? null,
    carbs_g:    macros.carbs_g   ?? null,
    fiber_g:    macros.fiber_g   ?? null,
    sodium_mg:  macros.sodium_mg ?? null,
    potassium_mg: macros.potassium_mg ?? null,
    calcium_mg: macros.calcium_mg ?? null,
    iron_mg: macros.iron_mg ?? null,
    vitamin_d_mcg: macros.vitamin_d_mcg ?? null,
    magnesium_mg: macros.magnesium_mg ?? null,
    _source:    'usda',
    is_verified: true,
    verification_source: 'USDA',
    source_label: 'Verified USDA',
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Text search against USDA FoodData Central.
 *
 * @param {string} query       - The search term
 * @param {object} options
 * @param {number} options.pageSize  - Max results (default 10)
 * @param {string} options.dataType  - e.g. 'Branded', 'SR Legacy' (omit for all)
 * @returns {Array} Array of food objects in our local schema shape
 */
export async function searchUSDA(query, { pageSize = 20, dataType } = {}) {
  const params = new URLSearchParams({
    query,
    api_key:  API_KEY,
    pageSize: String(pageSize),
  })
  if (dataType) params.set('dataType', dataType)

  const data = await fetchWithTimeout(`${BASE_URL}/foods/search?${params}`)
  return (data.foods ?? []).map(formatFood)
}

/**
 * Fetches a single food by its USDA FDC ID (e.g. from a barcode scan).
 *
 * @param {number|string} fdcId
 * @returns {object} A single food object in our local schema shape
 */
export async function lookupFdcId(fdcId) {
  const data = await fetchWithTimeout(
    `${BASE_URL}/food/${fdcId}?api_key=${API_KEY}`,
  )
  return formatFood(data)
}

/**
 * Returns true if the query string looks like a retail barcode.
 * Supports UPC-A (12 digits), EAN-13 (13 digits), and EAN-8 (8 digits).
 */
export function isBarcode(q) {
  return /^\d{8,14}$/.test(q)
}
