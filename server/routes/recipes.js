import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// GET /api/recipes
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.servings, r.calories, r.protein, r.carbs, r.fat, r.fiber, r.created_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', ri.id, 'food_name', ri.food_name, 'amount', ri.amount, 'unit', ri.unit,
                    'calories', ri.calories, 'protein', ri.protein, 'carbs', ri.carbs,
                    'fat', ri.fat, 'fiber', ri.fiber
                  ) ORDER BY ri.id
                ) FILTER (WHERE ri.id IS NOT NULL),
                '[]'::json
              ) AS ingredients
       FROM recipes r
       LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
       WHERE r.user_id = $1
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [dbUserId],
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/recipes
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { name, servings, ingredients } = req.body

    if (!name?.trim()) return res.status(400).json({ error: 'Recipe name required' })
    if (!Array.isArray(ingredients) || !ingredients.length) {
      return res.status(400).json({ error: 'At least one ingredient required' })
    }

    const totals = ingredients.reduce(
      (acc, ing) => ({
        calories: acc.calories + (parseFloat(ing.calories) || 0),
        protein:  acc.protein  + (parseFloat(ing.protein)  || 0),
        carbs:    acc.carbs    + (parseFloat(ing.carbs)    || 0),
        fat:      acc.fat      + (parseFloat(ing.fat)      || 0),
        fiber:    acc.fiber    + (parseFloat(ing.fiber)    || 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
    )

    const { rows: [recipe] } = await pool.query(
      `INSERT INTO recipes (user_id, name, servings, calories, protein, carbs, fat, fiber)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [dbUserId, name.trim(), parseFloat(servings) || 1,
       totals.calories, totals.protein, totals.carbs, totals.fat, totals.fiber],
    )

    for (const ing of ingredients) {
      await pool.query(
        `INSERT INTO recipe_ingredients (recipe_id, food_name, calories, protein, carbs, fat, fiber, amount, unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [recipe.id, ing.food_name || 'Ingredient',
         parseFloat(ing.calories) || null, parseFloat(ing.protein) || null,
         parseFloat(ing.carbs) || null, parseFloat(ing.fat) || null,
         parseFloat(ing.fiber) || null, parseFloat(ing.amount) || null,
         ing.unit || null],
      )
    }

    res.status(201).json({ ...recipe, ingredients })
  } catch (err) {
    next(err)
  }
})

// POST /api/recipes/:id/log — log a recipe as a meal
router.post('/:id/log', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId  = await getOrCreateUser(userId)
    const recipeId  = parseInt(req.params.id, 10)
    const { meal_slot, log_date, servings } = req.body

    const { rows } = await pool.query(
      'SELECT * FROM recipes WHERE id = $1 AND user_id = $2',
      [recipeId, dbUserId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Recipe not found' })

    const r = rows[0]
    const totalServings = Math.max(parseFloat(r.servings) || 1, 0.01)
    const servingsEaten = Math.max(parseFloat(servings) || 1, 0.01)

    const { rows: [meal] } = await pool.query(
      `INSERT INTO meals (user_id, meal_name, calories, protein, carbs, fat, fiber, meal_slot, log_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        dbUserId, r.name,
        r.calories != null ? Math.round(r.calories / totalServings * servingsEaten) : null,
        r.protein  != null ? +(r.protein  / totalServings * servingsEaten).toFixed(1) : null,
        r.carbs    != null ? +(r.carbs    / totalServings * servingsEaten).toFixed(1) : null,
        r.fat      != null ? +(r.fat      / totalServings * servingsEaten).toFixed(1) : null,
        r.fiber    != null ? +(r.fiber    / totalServings * servingsEaten).toFixed(1) : null,
        meal_slot ?? null,
        log_date ?? null,
      ],
    )
    res.status(201).json(meal)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/recipes/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const recipeId = parseInt(req.params.id, 10)

    const { rowCount } = await pool.query(
      'DELETE FROM recipes WHERE id = $1 AND user_id = $2',
      [recipeId, dbUserId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Recipe not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
