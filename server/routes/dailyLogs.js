import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { checkWaterGoal } from '../gamification.js'

const router = Router()

// GET /api/daily-logs/today
router.get('/today', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    const { rows } = await pool.query(
      `SELECT dl.water_oz, dl.steps, dl.weight_lbs
       FROM daily_logs dl
       JOIN users u ON u.id = dl.user_id
       WHERE u.clerk_user_id = $1
         AND dl.logged_date = CURRENT_DATE`,
      [userId],
    )

    res.json(rows[0] ?? { water_oz: null, steps: null, weight_lbs: null })
  } catch (err) {
    next(err)
  }
})

// GET /api/daily-logs/week — this week's averages
router.get('/week', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    const { rows } = await pool.query(
      `SELECT
         ROUND(AVG(water_oz))::int             AS avg_water_oz,
         ROUND(AVG(steps))::int                AS avg_steps,
         ROUND(AVG(weight_lbs)::numeric, 1)    AS avg_weight
       FROM daily_logs dl
       JOIN users u ON u.id = dl.user_id
       WHERE u.clerk_user_id = $1
         AND dl.logged_date >= DATE_TRUNC('week', CURRENT_DATE)`,
      [userId],
    )
    res.json(rows[0] ?? { avg_water_oz: null, avg_steps: null, avg_weight: null })
  } catch (err) {
    next(err)
  }
})

// POST /api/daily-logs — upsert; only provided fields are written
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { water_oz = null, steps = null, weight_lbs = null } = req.body

    const dbUserId = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `INSERT INTO daily_logs (user_id, logged_date, water_oz, steps, weight_lbs, steps_source)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, 'manual')
       ON CONFLICT (user_id, logged_date) DO UPDATE SET
         water_oz   = COALESCE(EXCLUDED.water_oz,   daily_logs.water_oz),
         steps      = COALESCE(EXCLUDED.steps,      daily_logs.steps),
         weight_lbs = COALESCE(EXCLUDED.weight_lbs, daily_logs.weight_lbs),
         steps_source = CASE
           WHEN EXCLUDED.steps IS NOT NULL THEN 'manual'
           ELSE daily_logs.steps_source
         END
       RETURNING water_oz, steps, weight_lbs`,
      [dbUserId, water_oz, steps, weight_lbs],
    )

    const today = new Date().toISOString().slice(0, 10)
    if (rows[0].water_oz != null) {
      checkWaterGoal(pool, dbUserId, parseFloat(rows[0].water_oz), today)
        .catch(e => console.error('[gami water]', e.message))
    }
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

export default router
