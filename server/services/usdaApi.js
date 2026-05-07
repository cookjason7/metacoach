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
}

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
function extractMacros(foodNutrients = []) {
  const out = {}
  for (const fn of foodNutrients) {
    const id     = fn.nutrientId ?? fn.nutrient?.id
    const amount = fn.value      ?? fn.amount
    const field  = NUTRIENT_FIELDS[id]
    if (field && amount != null) out[field] = Math.round(amount * 10) / 10
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
    data_type:  raw.dataType ?? 'Branded',
    calories:   macros.calories  ?? null,
    protein_g:  macros.protein_g ?? null,
    fat_g:      macros.fat_g     ?? null,
    carbs_g:    macros.carbs_g   ?? null,
    fiber_g:    macros.fiber_g   ?? null,
    _source:    'usda',
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
export async function searchUSDA(query, { pageSize = 10, dataType } = {}) {
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
