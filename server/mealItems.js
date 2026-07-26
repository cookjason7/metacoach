// Shared per-ingredient (meal_items) parsing, persistence, and edit logic —
// used by both Photo (POST /api/meals) and Text Entry (POST /api/meals/text-log)
// ingestion in server/routes/meals.js, and by the PATCH /api/meals/:id/items
// ingredient-editor endpoint.

const MACRO_CAP  = 10000
const CAL_CAP    = 100000
const WEIGHT_CAP = 100000

// Parses the ingredients array returned by a photo or text-entry AI analysis.
// It arrives as a JSON string (multipart/form-data has no native array type)
// or already parsed (JSON request body / a Claude response already run
// through JSON.parse). Malformed/absent input yields no items — this is
// best-effort enrichment of the collapsed meals row, never blocking the save.
export function parseIngredients(raw) {
  if (raw == null || raw === '') return []
  let arr = raw
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter(i => i && typeof i === 'object' && typeof i.item === 'string' && i.item.trim())
    .map(i => ({
      item:     i.item.trim().slice(0, 255),
      portion:  typeof i.portion === 'string' ? i.portion.trim().slice(0, 255) : null,
      weight_g: Number.isFinite(Number(i.weight_g)) ? Number(i.weight_g) : null,
      calories: Number.isFinite(Number(i.calories)) ? Number(i.calories) : null,
      protein:  Number.isFinite(Number(i.protein_g ?? i.protein)) ? Number(i.protein_g ?? i.protein) : null,
      carbs:    Number.isFinite(Number(i.carbs_g ?? i.carbs))     ? Number(i.carbs_g ?? i.carbs)     : null,
      fat:      Number.isFinite(Number(i.fat_g ?? i.fat))         ? Number(i.fat_g ?? i.fat)         : null,
    }))
}

// Returns the inserted rows (with their DB-assigned ids) rather than the
// input array — callers need the id to let the ingredient editor reference
// a specific row on save (PATCH /api/meals/:id/items).
export async function insertMealItems(client, mealId, items) {
  const inserted = []
  for (const it of items) {
    const { rows } = await client.query(
      `INSERT INTO meal_items (meal_id, item, portion, weight_g, calories, protein, carbs, fat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, meal_id, item, portion, weight_g, calories, protein, carbs, fat`,
      [mealId, it.item, it.portion, it.weight_g, it.calories, it.protein, it.carbs, it.fat],
    )
    inserted.push(rows[0])
  }
  return inserted
}

function numericOrNull(val, cap) {
  if (val === undefined || val === null || val === '') return null
  const n = Number(val)
  if (!Number.isFinite(n) || n < 0 || n > cap) return null
  return n
}

// Validates item edits submitted from the ingredient editor. Each entry must
// reference an existing item by id; ownership (does this id actually belong
// to this meal) is enforced by the caller's SQL (meal_id-scoped WHERE), not
// here — this only sanitizes field values.
export function sanitizeItemEdits(rawItems) {
  if (!Array.isArray(rawItems)) return { ok: false, error: 'items must be an array' }
  const data = []
  for (const raw of rawItems) {
    const id = parseInt(raw?.id, 10)
    if (!Number.isInteger(id)) return { ok: false, error: 'Each item requires a valid id' }
    data.push({
      id,
      portion:  typeof raw.portion === 'string' ? (raw.portion.trim().slice(0, 255) || null) : null,
      weight_g: numericOrNull(raw.weight_g, WEIGHT_CAP),
      calories: numericOrNull(raw.calories, CAL_CAP),
      protein:  numericOrNull(raw.protein,  MACRO_CAP),
      carbs:    numericOrNull(raw.carbs,    MACRO_CAP),
      fat:      numericOrNull(raw.fat,      MACRO_CAP),
    })
  }
  return { ok: true, data }
}

// Applies an ingredient-editor save: deletes items the client dropped,
// updates the survivors, then recomputes the meals row's collapsed
// calories/protein/carbs/fat as the authoritative sum of what's left — the
// server, not the client, has the final say on the rollup. Fiber/sugar are
// untouched since meal_items doesn't track them (they stay whatever the
// original AI estimate set at log time).
export async function applyMealItemEdits(client, mealId, items) {
  const { rows: existing } = await client.query(
    `SELECT id FROM meal_items WHERE meal_id = $1`, [mealId],
  )
  const keepIds  = new Set(items.map(i => i.id))
  const toDelete = existing.map(r => r.id).filter(id => !keepIds.has(id))
  if (toDelete.length) {
    await client.query(`DELETE FROM meal_items WHERE id = ANY($1::int[]) AND meal_id = $2`, [toDelete, mealId])
  }
  for (const it of items) {
    await client.query(
      `UPDATE meal_items SET portion = $1, weight_g = $2, calories = $3, protein = $4, carbs = $5, fat = $6
       WHERE id = $7 AND meal_id = $8`,
      [it.portion, it.weight_g, it.calories, it.protein, it.carbs, it.fat, it.id, mealId],
    )
  }
  const { rows: sumRows } = await client.query(
    `SELECT COALESCE(SUM(calories), 0) AS calories, COALESCE(SUM(protein), 0) AS protein,
            COALESCE(SUM(carbs), 0) AS carbs, COALESCE(SUM(fat), 0) AS fat
     FROM meal_items WHERE meal_id = $1`,
    [mealId],
  )
  const sum = sumRows[0]
  const { rows: mealRows } = await client.query(
    `UPDATE meals SET calories = $1, protein = $2, carbs = $3, fat = $4 WHERE id = $5 RETURNING *`,
    [Math.round(sum.calories), sum.protein, sum.carbs, sum.fat, mealId],
  )
  const { rows: itemRows } = await client.query(
    `SELECT id, meal_id, item, portion, weight_g, calories, protein, carbs, fat
     FROM meal_items WHERE meal_id = $1 ORDER BY id ASC`,
    [mealId],
  )
  const meal = mealRows[0]
  meal.items = itemRows
  return meal
}
