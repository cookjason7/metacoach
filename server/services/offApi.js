/**
 * server/services/offApi.js
 *
 * Thin wrapper around the Open Food Facts text-search API.
 *
 * Used as a supplement for branded packaged food searches when USDA
 * FoodData Central lacks a product — e.g. Quest protein bars, Optimum
 * Nutrition Gold Standard, Premier Protein shakes, Orgain, Fairlife.
 *
 * No API key required. Open Food Facts is a public crowdsourced database.
 * Rate-limit: generous; no key needed for search queries.
 *
 * Endpoint:
 *   GET https://world.openfoodfacts.org/cgi/search.pl?...
 */

const OFF_BASE    = 'https://world.openfoodfacts.org'
const OFF_TIMEOUT = 6000   // ms — independent timeout from USDA

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchOFF(url) {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), OFF_TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`OFO API ${res.status}: ${url}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Map a raw Open Food Facts product to our internal food schema.
 * Returns null when the product is too incomplete to be useful.
 */
function formatOFFFood(p) {
  // Require a non-empty product name
  const name = (p.product_name || p.product_name_en || '').trim()
  if (!name) return null

  const n    = p.nutriments || {}
  const cal  = n['energy-kcal_100g']
  const prot = n['proteins_100g']

  // Need at least one macro to be useful in a food log
  if (cal == null && prot == null) return null

  // Some OFO products have clearly bogus values; skip anything over 950 kcal/100g
  if (cal != null && parseFloat(cal) > 950) return null

  // Take first brand from the comma-separated list and clean it up
  const brand = p.brands
    ? (p.brands.split(',')[0].trim() || null)
    : null

  const n1 = (v, digits = 1) => v != null ? +parseFloat(v).toFixed(digits)           : null
  const mg  = (v)             => v != null ? Math.round(parseFloat(v) * 1000)         : null

  return {
    id:           null,
    fdc_id:       null,
    off_id:       p.code || p._id || null,
    name,
    brand,
    data_type:    'Branded',
    calories:     cal  != null ? Math.round(parseFloat(cal))  : null,
    protein_g:    n1(prot),
    fat_g:        n1(n['fat_100g']),
    carbs_g:      n1(n['carbohydrates_100g']),
    fiber_g:      n1(n['fiber_100g']),
    sodium_mg:    mg(n['sodium_100g']),
    potassium_mg: mg(n['potassium_100g']),
    calcium_mg:   mg(n['calcium_100g']),
    iron_mg:      n['iron_100g'] != null
                    ? +((parseFloat(n['iron_100g']) * 1000).toFixed(1))
                    : null,
    vitamin_d_mcg: n1(n['vitamin-d_100g']),
    magnesium_mg:  mg(n['magnesium_100g']),
    _source:              'off',
    is_verified:          false,
    verification_source:  'Open Food Facts',
    source_label:         'Open Food Facts',
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Text search against Open Food Facts.
 *
 * @param {string} query             — Search term (e.g. "quest bar")
 * @param {object} opts
 * @param {number} opts.pageSize     — Max results (default 10)
 * @returns {Array}  Array of food objects in our schema shape (nulls removed)
 */
export async function searchOFF(query, { pageSize = 10 } = {}) {
  const params = new URLSearchParams({
    search_terms:  query,
    search_simple: '1',
    action:        'process',
    json:          '1',
    page_size:     String(pageSize),
    fields:        'code,product_name,product_name_en,brands,nutriments',
  })

  const data = await fetchOFF(`${OFF_BASE}/cgi/search.pl?${params}`)
  return (data.products ?? []).map(formatOFFFood).filter(Boolean)
}
