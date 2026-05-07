import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// GET /api/users/me
router.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT id, first_name, age, height_inches, starting_weight_lbs, goal_weight_lbs,
              activity_level, tried_before, why_joined, identity_anchors,
              onboarding_complete, goal_calories, goal_protein, goal_carbs, goal_fat,
              gender, phone_number, paid, role
       FROM users WHERE id = $1`,
      [dbUserId],
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/users/me
router.patch('/me', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const {
      first_name, age, height_inches, starting_weight_lbs, goal_weight_lbs,
      activity_level, tried_before, why_joined,
      identity_anchors, onboarding_complete, gender, phone_number,
    } = req.body

    const { rows } = await pool.query(
      `UPDATE users SET
         first_name          = COALESCE($1,  first_name),
         age                 = COALESCE($2,  age),
         height_inches       = COALESCE($3,  height_inches),
         starting_weight_lbs = COALESCE($4,  starting_weight_lbs),
         goal_weight_lbs     = COALESCE($5,  goal_weight_lbs),
         activity_level      = COALESCE($6,  activity_level),
         tried_before        = COALESCE($7,  tried_before),
         why_joined          = COALESCE($8,  why_joined),
         identity_anchors    = COALESCE($9,  identity_anchors),
         onboarding_complete = COALESCE($10, onboarding_complete),
         gender              = COALESCE($11, gender),
         phone_number        = COALESCE($12, phone_number)
       WHERE id = $13
       RETURNING *`,
      [
        first_name ?? null, age ?? null, height_inches ?? null,
        starting_weight_lbs ?? null, goal_weight_lbs ?? null,
        activity_level ?? null, tried_before ?? null, why_joined ?? null,
        identity_anchors ?? null, onboarding_complete ?? null,
        gender ?? null, phone_number ?? null,
        dbUserId,
      ],
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/users/me/activate — marks the current user as paid
router.post('/me/activate', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    await pool.query('UPDATE users SET paid = TRUE WHERE id = $1', [dbUserId])
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
