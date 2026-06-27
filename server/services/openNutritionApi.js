/**
 * server/services/openNutritionApi.js
 *
 * Thin wrapper around the OpenNutrition food search API.
 * Used as a third fallback when both USDA FoodData Central and Open Food Facts
 * return zero results for a query.
 *
 * No API key required for basic search.
 *
 * Endpoint:
 *   GET https://api.opennutrition.com/api/v1/foods/search?q={query}
 *
 * Response shape (per item):
 *   { name, calories_g, protein_g, fat_g, carbs_g }
 */

const ON_BASE    = 'https://api.opennutrition.com/api/v1'
const ON_TIMEOUT = 6000   // ms

async function fetchON(url) {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), ON_TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`OpenNutrition ${res.status}: ${url}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

function formatONFood(item) {
  const name = (item.name || '').trim()
  if (!name) return null

  const cal  = item.calories_g != null ? parseFloat(item.calories_g) : null
  const prot = item.protein_g  != null ? parseFloat(item.protein_g)  : null

  if (cal == null && prot == null) return null
  if (cal != null && cal > 950)    return null

  const n1 = v => v != null ? +parseFloat(v).toFixed(1) : null

  return {
    id:                  null,
    fdc_id:              null,
    name,
    brand:               null,
    data_type:           'Branded',
    calories:            cal != null ? Math.round(cal) : null,
    protein_g:           n1(item.protein_g),
    fat_g:               n1(item.fat_g),
    carbs_g:             n1(item.carbs_g),
    fiber_g:             null,
    sodium_mg:           null,
    potassium_mg:        null,
    calcium_mg:          null,
    iron_mg:             null,
    vitamin_d_mcg:       null,
    magnesium_mg:        null,
    _source:             'opennutrition',
    is_verified:         false,
    verification_source: 'OpenNutrition',
    source_label:        'OpenNutrition',
  }
}

/**
 * Text search against OpenNutrition.
 *
 * @param {string} query
 * @param {object} opts
 * @param {number} opts.pageSize  — Max results (default 10)
 * @returns {Array} Array of food objects in our schema shape (nulls removed)
 */
export async function searchOpenNutrition(query, { pageSize = 10 } = {}) {
  const params = new URLSearchParams({ q: query })
  const data   = await fetchON(`${ON_BASE}/foods/search?${params}`)

  // API may return { results: [...] } or a top-level array
  const items  = Array.isArray(data) ? data : (data.results ?? data.foods ?? [])
  return items.slice(0, pageSize).map(formatONFood).filter(Boolean)
}
