import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { searchUSDA, lookupFdcId, isBarcode } from '../services/usdaApi.js'

const router = Router()

// Minimum local results before we call out to the USDA API for supplements
const LOCAL_THRESHOLD = 5
const USDA_DATA_TYPES = new Set(['SR Legacy', 'Foundation', 'Branded'])

function isVerifiedFood(food) {
  return !!food.fdc_id && USDA_DATA_TYPES.has(food.data_type)
}

function withFoodSource(food, fallbackSource = 'local') {
  const verified = isVerifiedFood(food)
  return {
    ...food,
    _source: fallbackSource,
    is_verified: verified,
    verification_source: verified ? 'USDA' : null,
    source_label: verified ? 'Verified USDA' : 'Food database',
  }
}

function parseNutrientNumbers(food) {
  return {
    ...food,
    calories: food.calories != null ? parseFloat(food.calories) : null,
    protein_g: food.protein_g != null ? parseFloat(food.protein_g) : null,
    fat_g: food.fat_g != null ? parseFloat(food.fat_g) : null,
    carbs_g: food.carbs_g != null ? parseFloat(food.carbs_g) : null,
    fiber_g: food.fiber_g != null ? parseFloat(food.fiber_g) : null,
    sodium_mg: food.sodium_mg != null ? parseFloat(food.sodium_mg) : null,
    potassium_mg: food.potassium_mg != null ? parseFloat(food.potassium_mg) : null,
    calcium_mg: food.calcium_mg != null ? parseFloat(food.calcium_mg) : null,
    iron_mg: food.iron_mg != null ? parseFloat(food.iron_mg) : null,
    vitamin_d_mcg: food.vitamin_d_mcg != null ? parseFloat(food.vitamin_d_mcg) : null,
    magnesium_mg: food.magnesium_mg != null ? parseFloat(food.magnesium_mg) : null,
  }
}

// ── Local search ──────────────────────────────────────────────────────────────

/**
 * Runs the three-tier ranked search against the local foods table.
 * Extracted as a function so the /search route and tests can share it.
 *
 *   Rank 0 — exact match (case-insensitive)
 *   Rank 1 — prefix / starts-with
 *   Rank 2 — full-text (tsvector)
 *   Rank 3 — fuzzy trigram
 */
async function localSearch(q, limit, offset) {
  const ftClause   = q.length >= 2 ? `OR f.search_vector @@ websearch_to_tsquery('english', $1)` : ''
  const trgmClause = q.length >= 3 ? `OR f.name % $1` : ''
  const ftRank     = q.length >= 2 ? `WHEN f.search_vector @@ websearch_to_tsquery('english', $1) THEN 2` : ''

  const { rows } = await pool.query(`
    SELECT
      f.id,
      f.fdc_id,
      f.name,
      f.data_type,
      ROUND(f.calories::numeric, 1)                                                  AS calories,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1003 THEN fn.amount END)::numeric, 1) AS protein_g,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1004 THEN fn.amount END)::numeric, 1) AS fat_g,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1005 THEN fn.amount END)::numeric, 1) AS carbs_g,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1079 THEN fn.amount END)::numeric, 1) AS fiber_g,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1093 THEN fn.amount END)::numeric, 0) AS sodium_mg,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1092 THEN fn.amount END)::numeric, 0) AS potassium_mg,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1087 THEN fn.amount END)::numeric, 0) AS calcium_mg,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1089 THEN fn.amount END)::numeric, 1) AS iron_mg,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1114 THEN fn.amount END)::numeric, 1) AS vitamin_d_mcg,
      ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1090 THEN fn.amount END)::numeric, 0) AS magnesium_mg,
      CASE
        WHEN f.name ILIKE $1            THEN 0
        WHEN f.name ILIKE ($1 || '%')   THEN 1
        ${ftRank}
        ELSE                                 3
      END AS _rank
    FROM foods f
    LEFT JOIN food_nutrients fn ON fn.food_id = f.id
    LEFT JOIN nutrients n
      ON  n.id = fn.nutrient_id
      AND n.fdc_nutrient_id IN (1003, 1004, 1005, 1079, 1093, 1092, 1087, 1089, 1114, 1090)
    WHERE
      f.name ILIKE $1
      OR f.name ILIKE ($1 || '%')
      ${ftClause}
      ${trgmClause}
    GROUP BY f.id, f.fdc_id, f.name, f.data_type, f.calories
    ORDER BY
      _rank,
      CASE f.data_type WHEN 'SR Legacy' THEN 0 WHEN 'Foundation' THEN 1 ELSE 2 END,
      LENGTH(f.name),
      f.name
    LIMIT  $2
    OFFSET $3
  `, [q, limit, offset])

  return rows.map(({ _rank, ...food }) => withFoodSource(parseNutrientNumbers(food)))
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/foods/search?q=chicken&limit=20&offset=0
 *
 * Decision tree:
 *  1. Barcode query (8-14 digits) → USDA branded food lookup, skip local DB
 *  2. Local DB returns ≥ 5 results → return local only (fast path)
 *  3. Local DB returns < 5 results → append USDA results to fill the gap
 *
 * All macros are per 100g. The client scales them by portion size.
 * Results tagged with _source: 'local' | 'usda' so the client can
 * display a "From USDA" badge on supplemented results if desired.
 */
router.get('/search', requireAuth(), async (req, res, next) => {
  try {
    const q      = (req.query.q ?? '').trim()
    const limit  = Math.min(Math.max(parseInt(req.query.limit  ?? '20', 10), 1), 50)
    const offset = Math.max(parseInt(req.query.offset ?? '0',  10), 0)

    if (!q) return res.json([])

    // ── Barcode path ────────────────────────────────────────────────────────
    if (isBarcode(q)) {
      try {
        const results = await searchUSDA(q, { dataType: 'Branded', pageSize: limit })
        return res.json(results)
      } catch {
        return res.json([])
      }
    }

    // ── Custom foods ─────────────────────────────────────────────────────────
    // Look up user so we can include their custom foods in results.
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { rows: customRows } = await pool.query(
      `SELECT
         cf.id::text AS id,
         NULL::integer AS fdc_id,
         cf.food_name AS name,
         'Custom' AS data_type,
         cf.is_global,
         cf.is_coach_food,
         cf.notes,
         CASE WHEN cf.serving_size > 0
           THEN ROUND((cf.calories_per_serving / cf.serving_size * 100)::numeric, 1)
           ELSE ROUND(cf.calories_per_serving::numeric, 1)
         END AS calories,
         CASE WHEN cf.serving_size > 0
           THEN ROUND((cf.protein / cf.serving_size * 100)::numeric, 1)
           ELSE ROUND(cf.protein::numeric, 1)
         END AS protein_g,
         CASE WHEN cf.serving_size > 0
           THEN ROUND((cf.carbs / cf.serving_size * 100)::numeric, 1)
           ELSE ROUND(cf.carbs::numeric, 1)
         END AS carbs_g,
         CASE WHEN cf.serving_size > 0
           THEN ROUND((cf.fat / cf.serving_size * 100)::numeric, 1)
           ELSE ROUND(cf.fat::numeric, 1)
         END AS fat_g,
         CASE WHEN cf.serving_size > 0
           THEN ROUND((cf.fiber / cf.serving_size * 100)::numeric, 1)
           ELSE ROUND(cf.fiber::numeric, 1)
         END AS fiber_g
       FROM custom_foods cf
       WHERE (cf.is_global = TRUE OR cf.user_id = $1)
         AND cf.food_name ILIKE $2
       ORDER BY cf.is_coach_food DESC, cf.food_name`,
      [dbUserId, `%${q}%`],
    )
    const customResults = customRows.map(r => ({
      ...r,
      calories:  r.calories  != null ? parseFloat(r.calories)  : null,
      protein_g: r.protein_g != null ? parseFloat(r.protein_g) : null,
      carbs_g:   r.carbs_g   != null ? parseFloat(r.carbs_g)   : null,
      fat_g:     r.fat_g     != null ? parseFloat(r.fat_g)     : null,
      fiber_g:   r.fiber_g   != null ? parseFloat(r.fiber_g)   : null,
      // FIX 1: is_coach_food=TRUE → 'coach' source (distinct badge)
      //        is_global=TRUE, is_coach_food=FALSE → 'global' (Food database badge)
      //        user private food → 'custom' (My food badge)
      _source:      r.is_coach_food ? 'coach' : r.is_global ? 'global' : 'custom',
      is_verified:  false,
      verification_source: null,
      source_label: r.is_coach_food ? 'Coach food' : r.is_global ? 'Food database' : 'My food',
    }))

    // ── Local search ─────────────────────────────────────────────────────────
    const localResults = await localSearch(q, limit, offset)

    // Custom foods always appear first; together they count toward threshold
    const combined = [...customResults, ...localResults]
    if (combined.length >= LOCAL_THRESHOLD) {
      return res.json(combined.slice(0, limit))
    }

    // ── USDA fallback ────────────────────────────────────────────────────────
    const localFdcIds = new Set(localResults.map(f => f.fdc_id).filter(Boolean))
    const needed      = limit - combined.length

    let usdaResults = []
    try {
      const raw = await searchUSDA(q, { pageSize: needed + 5 })
      usdaResults = raw
        .filter(f => !localFdcIds.has(f.fdc_id))
        .slice(0, needed)
    } catch (err) {
      console.warn('[foods] USDA fallback failed:', err.message)
    }

    res.json([...combined, ...usdaResults])
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/foods/barcode/:code
 *
 * Proxy for Open Food Facts API. Returns per-serving macros when available,
 * otherwise per-100g values. Tagged with is_per_serving so the client knows.
 */
router.get('/barcode/:code', requireAuth(), async (req, res, next) => {
  try {
    const code = req.params.code.replace(/\D/g, '')
    if (!code) return res.status(400).json({ error: 'Invalid barcode' })

    const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${code}.json`)
    if (!response.ok) return res.status(502).json({ error: 'Could not reach Open Food Facts' })

    let data = await response.json()

    // Retry with EAN-13 (prepend leading zero) for 12-digit UPC-A barcodes
    if ((data.status !== 1 || !data.product) && code.length === 12) {
      try {
        const response2 = await fetch(`https://world.openfoodfacts.org/api/v0/product/0${code}.json`)
        if (response2.ok) data = await response2.json()
      } catch {}
    }

    if (data.status !== 1 || !data.product) {
      return res.status(404).json({ error: 'Product not found in Open Food Facts' })
    }

    const p = data.product
    const n = p.nutriments || {}

    const hasSrv = n['energy-kcal_serving'] != null

    function srv(key100, keySrv) {
      const v = hasSrv ? n[keySrv] : n[key100]
      return v != null ? +parseFloat(v).toFixed(1) : null
    }

    function mg(key100, keySrv) {
      const v = hasSrv ? n[keySrv] : n[key100]
      return v != null ? Math.round(parseFloat(v) * 1000) : null
    }

    res.json({
      barcode:         code,
      name:            p.product_name || p.product_name_en || 'Unknown Product',
      brand:           p.brands || '',
      serving_size:    p.serving_size || '100g',
      image_url:       p.image_url || null,
      is_per_serving:  hasSrv,
      calories:        hasSrv ? Math.round(n['energy-kcal_serving'] ?? 0) : Math.round(n['energy-kcal_100g'] ?? 0),
      protein_g:       srv('proteins_100g',       'proteins_serving'),
      carbs_g:         srv('carbohydrates_100g',   'carbohydrates_serving'),
      fat_g:           srv('fat_100g',             'fat_serving'),
      saturated_fat_g: srv('saturated-fat_100g',   'saturated-fat_serving'),
      fiber_g:         srv('fiber_100g',           'fiber_serving'),
      sugar_g:         srv('sugars_100g',          'sugars_serving'),
      sodium_mg:       (() => {
        const v = hasSrv ? n.sodium_serving : n.sodium_100g
        return v != null ? Math.round(parseFloat(v) * 1000) : null
      })(),
      potassium_mg:    mg('potassium_100g', 'potassium_serving'),
      calcium_mg:      mg('calcium_100g',   'calcium_serving'),
      iron_mg:         (() => {
        const v = hasSrv ? n.iron_serving : n.iron_100g
        return v != null ? +((parseFloat(v) * 1000).toFixed(1)) : null
      })(),
      vitamin_d_mcg:   (() => {
        const v = hasSrv ? n['vitamin-d_serving'] : n['vitamin-d_100g']
        return v != null ? +parseFloat(v).toFixed(1) : null
      })(),
      magnesium_mg:    mg('magnesium_100g', 'magnesium_serving'),
      _source: 'barcode',
      is_verified: false,
      verification_source: 'Open Food Facts',
      source_label: 'Open Food Facts',
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/foods/fdc/:fdcId
 *
 * Fetches a single food directly from USDA by its FDC ID.
 * Useful for barcode scan detail views and deep-linking to a specific food.
 * Checks the local DB first; falls back to the USDA API if not found locally.
 */
router.get('/fdc/:fdcId', requireAuth(), async (req, res, next) => {
  try {
    const fdcId = parseInt(req.params.fdcId, 10)
    if (isNaN(fdcId)) return res.status(400).json({ error: 'Invalid fdc_id' })

    // Try local first — faster and works offline
    const { rows: [local] } = await pool.query(`
      SELECT
        f.id, f.fdc_id, f.name, f.data_type,
        ROUND(f.calories::numeric, 1) AS calories,
        f.serving_size, f.serving_size_unit,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1003 THEN fn.amount END)::numeric, 1) AS protein_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1004 THEN fn.amount END)::numeric, 1) AS fat_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1005 THEN fn.amount END)::numeric, 1) AS carbs_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1079 THEN fn.amount END)::numeric, 1) AS fiber_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1093 THEN fn.amount END)::numeric, 0) AS sodium_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1092 THEN fn.amount END)::numeric, 0) AS potassium_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1087 THEN fn.amount END)::numeric, 0) AS calcium_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1089 THEN fn.amount END)::numeric, 1) AS iron_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1114 THEN fn.amount END)::numeric, 1) AS vitamin_d_mcg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1090 THEN fn.amount END)::numeric, 0) AS magnesium_mg,
        json_agg(json_build_object(
          'name',      n.name,
          'unit_name', n.unit_name,
          'amount',    fn.amount
        ) ORDER BY n.name) FILTER (WHERE n.id IS NOT NULL) AS nutrients
      FROM foods f
      LEFT JOIN food_nutrients fn ON fn.food_id = f.id
      LEFT JOIN nutrients n ON n.id = fn.nutrient_id
      WHERE f.fdc_id = $1
      GROUP BY f.id
    `, [fdcId])

    if (local) return res.json(withFoodSource(parseNutrientNumbers(local)))

    // Not in local DB — fetch from USDA API
    try {
      const food = await lookupFdcId(fdcId)
      return res.json(food)
    } catch {
      return res.status(404).json({ error: 'Food not found' })
    }
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/foods/:id
 *
 * Returns a single food by its local UUID with its full nutrient profile.
 */
router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { rows: [food] } = await pool.query(`
      SELECT
        f.id, f.fdc_id, f.name, f.data_type,
        ROUND(f.calories::numeric, 1) AS calories,
        f.serving_size, f.serving_size_unit,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1003 THEN fn.amount END)::numeric, 1) AS protein_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1004 THEN fn.amount END)::numeric, 1) AS fat_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1005 THEN fn.amount END)::numeric, 1) AS carbs_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1079 THEN fn.amount END)::numeric, 1) AS fiber_g,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1093 THEN fn.amount END)::numeric, 0) AS sodium_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1092 THEN fn.amount END)::numeric, 0) AS potassium_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1087 THEN fn.amount END)::numeric, 0) AS calcium_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1089 THEN fn.amount END)::numeric, 1) AS iron_mg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1114 THEN fn.amount END)::numeric, 1) AS vitamin_d_mcg,
        ROUND(MAX(CASE WHEN n.fdc_nutrient_id = 1090 THEN fn.amount END)::numeric, 0) AS magnesium_mg,
        json_agg(json_build_object(
          'name',      n.name,
          'unit_name', n.unit_name,
          'amount',    fn.amount
        ) ORDER BY n.name) FILTER (WHERE n.id IS NOT NULL) AS nutrients
      FROM foods f
      LEFT JOIN food_nutrients fn ON fn.food_id = f.id
      LEFT JOIN nutrients n ON n.id = fn.nutrient_id
      WHERE f.id = $1
      GROUP BY f.id
    `, [req.params.id])

    if (!food) return res.status(404).json({ error: 'Food not found' })
    res.json(withFoodSource(parseNutrientNumbers(food)))
  } catch (err) {
    next(err)
  }
})

export default router
