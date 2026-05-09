/**
 * server/scripts/seed-foods.js
 *
 * Imports USDA SR Legacy and Foundation Foods into the local foods,
 * nutrients, and food_nutrients tables.
 *
 * ── SETUP ────────────────────────────────────────────────────────────────────
 *
 * 1. Go to https://fdc.nal.usda.gov/download-foods.html
 *
 * 2. Download ONE of these (SR Legacy is smaller and sufficient):
 *      Option A — SR Legacy only (~50 MB, ~9,000 foods):
 *        Click "April 2019" under "SR Legacy"
 *        Filename: FoodData_Central_sr_legacy_food_csv_2019-04-02.zip
 *
 *      Option B — SR Legacy + Foundation (~150 MB, ~11,000 foods):
 *        Also download "Foundation Foods" from the Foundation section
 *        Filename: FoodData_Central_foundation_food_csv_YYYY-MM-DD.zip
 *
 * 3. Extract each zip. You need exactly three files:
 *        food.csv
 *        nutrient.csv
 *        food_nutrient.csv
 *
 *    If you downloaded both SR Legacy and Foundation, merge them:
 *      - Concatenate both food.csv files (keep one header row)
 *      - Concatenate both food_nutrient.csv files (keep one header row)
 *      - nutrient.csv is identical in both — use either one
 *
 * 4. Place the three files in:  server/data/
 *
 * 5. Run:
 *        node server/scripts/seed-foods.js
 *
 * The script is idempotent — safe to run multiple times.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config'
import { createReadStream, existsSync } from 'fs'
import { parse } from 'csv-parse'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR  = path.join(__dirname, '../data')
const BATCH     = 500   // rows flushed to DB per round-trip

// ── What to import ────────────────────────────────────────────────────────────

// USDA nutrient IDs to store. Everything else is discarded to keep the table
// lean. Add more IDs here if you want additional micronutrients.
const KEEP_NUTRIENTS = new Set([
  1008, // Energy (kcal)                 ← populates foods.calories
  1003, // Protein (g)
  1004, // Total lipid / fat (g)
  1005, // Carbohydrate, by difference (g)
  1079, // Fiber, total dietary (g)
  2000, // Sugars, total including NLEA (g)
  1093, // Sodium (mg)
  1092, // Potassium (mg)
  1087, // Calcium (mg)
  1089, // Iron (mg)
  1090, // Magnesium (mg)
  1253, // Cholesterol (mg)
  1258, // Fatty acids, total saturated (g)
  1292, // Fatty acids, total monounsaturated (g)
  1293, // Fatty acids, total polyunsaturated (g)
  1106, // Vitamin A, RAE (μg)
  1162, // Vitamin C, total ascorbic acid (mg)
  1114, // Vitamin D (μg)
  1185, // Vitamin K (μg)
  1109, // Vitamin E (mg)
])

// Maps USDA data_type column values → our DB enum values.
// The CSV uses snake_case; our foods.data_type CHECK uses title case.
const DATA_TYPE_MAP = {
  sr_legacy_food:  'SR Legacy',
  foundation_food: 'Foundation',
}

// ── Database ─────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireFile(name) {
  const p = path.join(DATA_DIR, name)
  if (!existsSync(p)) {
    console.error(`\n✗ Missing file: ${p}`)
    console.error('  See setup instructions at the top of this script.')
    process.exit(1)
  }
  return p
}

/**
 * Streams a CSV file row-by-row and calls onBatch(rows) every BATCH rows.
 * Uses the async iterator protocol so await inside onBatch properly applies
 * backpressure — memory usage stays flat regardless of file size.
 */
async function streamCsv(filePath, onBatch) {
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true })
  )

  let batch = []
  let total = 0

  for await (const row of parser) {
    batch.push(row)
    if (batch.length >= BATCH) {
      await onBatch(batch)
      total += batch.length
      batch = []
    }
  }

  if (batch.length > 0) {
    await onBatch(batch)
    total += batch.length
  }

  return total
}

function log(label, n) {
  process.stdout.write(`\r  ${label}: ${n.toLocaleString()} rows processed`)
}

// ── Step 1: Nutrients ─────────────────────────────────────────────────────────

async function seedNutrients() {
  console.log('\n[1/4] Seeding nutrients…')
  let count = 0

  await streamCsv(requireFile('nutrient.csv'), async (rows) => {
    const ids   = rows.map(r => parseInt(r.id,         10))
    const names = rows.map(r => r.name)
    const units = rows.map(r => r.unit_name)

    // unnest turns parallel arrays into rows — much faster than individual INSERTs
    await pool.query(`
      INSERT INTO nutrients (fdc_nutrient_id, name, unit_name)
      SELECT * FROM unnest($1::int[], $2::text[], $3::text[])
      ON CONFLICT (fdc_nutrient_id) DO NOTHING
    `, [ids, names, units])

    count += rows.length
    log('nutrients', count)
  })

  // Return a map: USDA nutrient id → our local nutrients.id (SERIAL)
  // This is used in step 3 to write food_nutrients rows with the correct FK.
  const { rows } = await pool.query('SELECT id, fdc_nutrient_id FROM nutrients')
  const map = new Map(rows.map(r => [Number(r.fdc_nutrient_id), r.id]))
  console.log(`\n  ✓ ${map.size} nutrients ready`)
  return map
}

// ── Step 2: Foods ─────────────────────────────────────────────────────────────

async function seedFoods() {
  console.log('\n[2/4] Seeding foods…')
  let inserted = 0
  let skipped  = 0

  await streamCsv(requireFile('food.csv'), async (rows) => {
    const filtered = rows.filter(r => {
      const dt = r.data_type?.trim()
      // Individual data-type downloads omit the data_type column — treat as SR Legacy
      return !dt || DATA_TYPE_MAP[dt] !== undefined
    })

    if (filtered.length === 0) {
      skipped += rows.length
      return
    }

    const fdcIds    = filtered.map(r => parseInt(r.fdc_id, 10))
    const names     = filtered.map(r => r.description)
    const dataTypes = filtered.map(r => DATA_TYPE_MAP[r.data_type?.trim()] ?? 'SR Legacy')

    await pool.query(`
      INSERT INTO foods (fdc_id, name, data_type)
      SELECT * FROM unnest($1::int[], $2::text[], $3::text[])
      ON CONFLICT (fdc_id) DO NOTHING
    `, [fdcIds, names, dataTypes])

    inserted += filtered.length
    skipped  += rows.length - filtered.length
    log('foods', inserted)
  })

  // Return a map: USDA fdc_id (integer) → our UUID
  const { rows } = await pool.query('SELECT id, fdc_id FROM foods')
  const map = new Map(rows.map(r => [Number(r.fdc_id), r.id]))
  console.log(`\n  ✓ ${map.size} foods ready (${skipped.toLocaleString()} non-SR/Foundation rows skipped)`)
  return map
}

// ── Step 3: Food nutrients ────────────────────────────────────────────────────

async function seedFoodNutrients(foodMap, nutrientMap) {
  console.log('\n[3/4] Seeding food_nutrients…')
  let inserted = 0
  let skipped  = 0

  await streamCsv(requireFile('food_nutrient.csv'), async (rows) => {
    const foodIds     = []
    const nutrientIds = []
    const amounts     = []

    for (const r of rows) {
      const fdcId      = parseInt(r.fdc_id,      10)
      const usdaNutId  = parseInt(r.nutrient_id, 10)
      const amount     = parseFloat(r.amount)

      // Skip: food not in our set, nutrient not wanted, or bad amount
      if (!foodMap.has(fdcId) || !KEEP_NUTRIENTS.has(usdaNutId) || isNaN(amount)) {
        skipped++
        continue
      }

      const localNutId = nutrientMap.get(usdaNutId)
      if (!localNutId) { skipped++; continue }

      foodIds.push(foodMap.get(fdcId))
      nutrientIds.push(localNutId)
      amounts.push(amount)
    }

    if (foodIds.length === 0) return

    await pool.query(`
      INSERT INTO food_nutrients (food_id, nutrient_id, amount)
      SELECT * FROM unnest($1::uuid[], $2::int[], $3::numeric[])
      ON CONFLICT DO NOTHING
    `, [foodIds, nutrientIds, amounts])

    inserted += foodIds.length
    log('food_nutrients', inserted)
  })

  console.log(`\n  ✓ ${inserted.toLocaleString()} nutrient rows inserted (${skipped.toLocaleString()} skipped)`)
}

// ── Step 4: Populate foods.calories ──────────────────────────────────────────

async function updateCalories() {
  console.log('\n[4/4] Populating foods.calories from Energy (kcal) nutrient…')

  const { rowCount } = await pool.query(`
    UPDATE foods f
    SET    calories = fn.amount
    FROM   food_nutrients fn
    JOIN   nutrients n ON n.id = fn.nutrient_id
    WHERE  fn.food_id         = f.id
      AND  n.fdc_nutrient_id  = 1008
      AND  f.calories         IS NULL
  `)

  console.log(`  ✓ ${rowCount.toLocaleString()} foods updated with calorie values`)
}

// ── Summary query ─────────────────────────────────────────────────────────────

async function printSummary() {
  const { rows } = await pool.query(`
    SELECT
      data_type,
      COUNT(*)::int                        AS foods,
      ROUND(AVG(calories))::int            AS avg_cal,
      COUNT(calories)::int                 AS with_calories
    FROM foods
    GROUP BY data_type
    ORDER BY data_type
  `)

  console.log('\n── Database summary ─────────────────────────────')
  for (const r of rows) {
    console.log(`  ${r.data_type.padEnd(12)} ${String(r.foods).padStart(6)} foods  avg ${r.avg_cal ?? '—'} cal`)
  }

  const { rows: [nt] } = await pool.query('SELECT COUNT(*)::int AS n FROM food_nutrients')
  console.log(`  food_nutrients: ${nt.n.toLocaleString()} rows`)
  console.log('─────────────────────────────────────────────────')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║   MetaCoach Food Database Seeder         ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log(`Data directory: ${DATA_DIR}`)

  const t0 = Date.now()

  const nutrientMap = await seedNutrients()
  const foodMap     = await seedFoods()
  await seedFoodNutrients(foodMap, nutrientMap)
  await updateCalories()
  await printSummary()

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n✓ Seed complete in ${elapsed}s\n`)

  await pool.end()
}

main().catch(err => {
  console.error('\n✗ Seed failed:', err.message)
  process.exit(1)
})
