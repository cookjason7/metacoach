import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// GET /api/custom-foods — user's custom foods + global foods
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT * FROM custom_foods
       WHERE is_global = TRUE OR user_id = $1
       ORDER BY is_global DESC, food_name ASC`,
      [dbUserId],
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/custom-foods
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const {
      is_global, food_name, calories_per_serving, protein, carbs, fat, fiber,
      serving_size, serving_unit,
    } = req.body

    if (!food_name?.trim()) return res.status(400).json({ error: 'Food name required' })

    if (is_global) {
      const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
      if (rows[0]?.role !== 'admin') {
        return res.status(403).json({ error: 'Only admin can create global foods' })
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO custom_foods
         (user_id, is_global, food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        is_global ? null : dbUserId,
        is_global ?? false,
        food_name.trim(),
        calories_per_serving ?? null,
        protein  ?? null,
        carbs    ?? null,
        fat      ?? null,
        fiber    ?? null,
        serving_size  ?? 100,
        serving_unit  ?? 'g',
      ],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/custom-foods/:id — edit name, macros, and serving for user's own foods
router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const foodId   = parseInt(req.params.id, 10)
    if (isNaN(foodId)) return res.status(400).json({ error: 'Invalid id' })

    const { rows: [food] } = await pool.query(
      'SELECT id, user_id FROM custom_foods WHERE id = $1',
      [foodId],
    )
    if (!food) return res.status(404).json({ error: 'Food not found' })

    const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const isAdmin = userRows[0]?.role === 'admin'

    if (!isAdmin && food.user_id !== dbUserId) {
      return res.status(403).json({ error: 'Not your food' })
    }

    const { food_name, calories_per_serving, protein, carbs, fat, fiber, serving_size, serving_unit } = req.body

    if (food_name !== undefined && !String(food_name ?? '').trim()) {
      return res.status(400).json({ error: 'Food name cannot be empty' })
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE custom_foods SET
         food_name            = COALESCE($1, food_name),
         calories_per_serving = COALESCE($2, calories_per_serving),
         protein              = COALESCE($3, protein),
         carbs                = COALESCE($4, carbs),
         fat                  = COALESCE($5, fat),
         fiber                = COALESCE($6, fiber),
         serving_size         = COALESCE($7, serving_size),
         serving_unit         = COALESCE($8, serving_unit)
       WHERE id = $9
       RETURNING *`,
      [
        food_name        != null ? String(food_name).trim() : null,
        calories_per_serving != null ? Number(calories_per_serving) : null,
        protein          != null ? Number(protein)       : null,
        carbs            != null ? Number(carbs)         : null,
        fat              != null ? Number(fat)           : null,
        fiber            != null ? Number(fiber)         : null,
        serving_size     != null ? Number(serving_size)  : null,
        serving_unit     != null ? String(serving_unit)  : null,
        foodId,
      ],
    )
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/custom-foods/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const foodId   = parseInt(req.params.id, 10)

    const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const isAdmin = userRows[0]?.role === 'admin'

    const { rowCount } = await pool.query(
      isAdmin
        ? 'DELETE FROM custom_foods WHERE id = $1'
        : 'DELETE FROM custom_foods WHERE id = $1 AND user_id = $2',
      isAdmin ? [foodId] : [foodId, dbUserId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Food not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
