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
             onboarding_complete, assessment_complete, paid, role,
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

// ── Coach Foods ───────────────────────────────────────────────────────────────

// GET /api/admin/coach-foods — list all admin-curated coach foods
router.get('/coach-foods', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(`
      SELECT id, food_name, calories_per_serving, protein, carbs, fat, fiber,
             serving_size, serving_unit, notes, created_at
      FROM custom_foods
      WHERE is_global = TRUE AND is_coach_food = TRUE
      ORDER BY food_name ASC
    `)
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/admin/coach-foods — create a new coach food (or promote existing food data)
router.post('/coach-foods', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const {
      food_name, calories, protein, carbs, fat, fiber,
      serving_size, serving_unit, notes,
    } = req.body
    if (!food_name?.trim()) return res.status(400).json({ error: 'food_name required' })

    const ss = serving_size != null && serving_size !== '' ? Number(serving_size) : 100
    const su = serving_unit?.trim() || 'g'

    const { rows } = await pool.query(`
      INSERT INTO custom_foods
        (is_global, is_coach_food, food_name, calories_per_serving, protein, carbs, fat, fiber,
         serving_size, serving_unit, notes)
      VALUES (TRUE, TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      food_name.trim(),
      calories  != null ? Number(calories)  : null,
      protein   != null ? Number(protein)   : null,
      carbs     != null ? Number(carbs)     : null,
      fat       != null ? Number(fat)       : null,
      fiber     != null ? Number(fiber)     : null,
      ss, su,
      notes?.trim() || null,
    ])
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/admin/coach-foods/:id — update notes or name on a coach food
router.patch('/coach-foods/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { notes } = req.body
    const { rows } = await pool.query(`
      UPDATE custom_foods SET notes = $1
      WHERE id = $2 AND is_coach_food = TRUE
      RETURNING *
    `, [notes?.trim() ?? null, id])
    if (!rows.length) return res.status(404).json({ error: 'Coach food not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/admin/coach-foods/:id — remove a coach food
router.delete('/coach-foods/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { rowCount } = await pool.query(
      'DELETE FROM custom_foods WHERE id = $1 AND is_coach_food = TRUE',
      [id],
    )
    if (!rowCount) return res.status(404).json({ error: 'Coach food not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── DEV TOOLS ─────────────────────────────────────────────────────────────────
// TODO: REMOVE BEFORE PRODUCTION LAUNCH
// These endpoints exist only for testing the onboarding/assessment flow.
// They reset flag columns only — no user data (meals, workouts, journal,
// community posts, progress photos) is ever deleted.

// PATCH /api/admin/users/:id/dev-reset
// Body: { reset_onboarding?: boolean, reset_assessment?: boolean }
router.patch('/users/:id/dev-reset', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const targetId = parseInt(req.params.id, 10)
    const { reset_onboarding = false, reset_assessment = false } = req.body

    if (!reset_onboarding && !reset_assessment) {
      return res.status(400).json({ error: 'Specify reset_onboarding and/or reset_assessment' })
    }

    // Build SET clause dynamically — only touch the requested flags
    const setClauses = []
    if (reset_onboarding) setClauses.push('onboarding_complete = FALSE')
    if (reset_assessment)  setClauses.push('assessment_complete = FALSE')

    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $1
       RETURNING id, first_name, email, onboarding_complete, assessment_complete`,
      [targetId],
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })

    console.log(`[DEV] Reset flags for user ${targetId}:`, setClauses.join(', '))
    res.json({ ok: true, user: rows[0] })
  } catch (err) {
    next(err)
  }
})

// ── Health Assessments ────────────────────────────────────────────────────────

// GET /api/admin/assessments — list all submitted assessments
router.get('/assessments', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(`
      SELECT ha.*,
             u.first_name AS user_first_name,
             u.email      AS user_email
      FROM health_assessments ha
      JOIN users u ON u.id = ha.user_id
      ORDER BY ha.updated_at DESC
    `)
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// GET /api/admin/assessments/:userId — get one user's assessment
router.get('/assessments/:userId', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(
      'SELECT * FROM health_assessments WHERE user_id = $1',
      [parseInt(req.params.userId, 10)],
    )
    res.json(rows[0] ?? null)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/admin/assessments/:userId — update coach_name or notes
router.patch('/assessments/:userId', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const targetId = parseInt(req.params.userId, 10)
    const { coach_name } = req.body
    const { rows } = await pool.query(`
      UPDATE health_assessments
      SET coach_name = COALESCE($1, coach_name),
          updated_at = NOW()
      WHERE user_id = $2
      RETURNING *
    `, [coach_name ?? null, targetId])
    if (!rows.length) return res.status(404).json({ error: 'Assessment not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

export default router
