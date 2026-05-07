import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

async function requireAdmin(req, res) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
  if (rows[0]?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' })
    return null
  }
  return dbUserId
}

// GET /api/admin/users
router.get('/users', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(`
      SELECT id, first_name, email, goal_calories, goal_protein, goal_carbs, goal_fat,
             onboarding_complete, paid, role,
             (SELECT MAX(logged_at) FROM meals WHERE user_id = users.id) AS last_meal_at
      FROM users
      WHERE onboarding_complete = TRUE
      ORDER BY first_name ASC NULLS LAST
    `)
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/admin/users/:id/macros
router.patch('/users/:id/macros', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const targetId = parseInt(req.params.id, 10)
    const { goal_calories, goal_protein, goal_carbs, goal_fat } = req.body
    const { rows } = await pool.query(`
      UPDATE users SET
        goal_calories = COALESCE($1, goal_calories),
        goal_protein  = COALESCE($2, goal_protein),
        goal_carbs    = COALESCE($3, goal_carbs),
        goal_fat      = COALESCE($4, goal_fat)
      WHERE id = $5
      RETURNING id, first_name, goal_calories, goal_protein, goal_carbs, goal_fat
    `, [
      goal_calories != null ? Number(goal_calories) : null,
      goal_protein  != null ? Number(goal_protein)  : null,
      goal_carbs    != null ? Number(goal_carbs)    : null,
      goal_fat      != null ? Number(goal_fat)      : null,
      targetId,
    ])
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

export default router
