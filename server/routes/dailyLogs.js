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
      `SELECT dl.water_oz, dl.steps, dl.weight_lbs, dl.sleep_minutes
       FROM daily_logs dl
       JOIN users u ON u.id = dl.user_id
       WHERE u.clerk_user_id = $1
         AND dl.logged_date = CURRENT_DATE`,
      [userId],
    )

    res.json(rows[0] ?? { water_oz: null, steps: null, weight_lbs: null, sleep_minutes: null })
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
         ROUND(AVG(weight_lbs)::numeric, 1)    AS avg_weight,
         ROUND(AVG(sleep_minutes))::int        AS avg_sleep_minutes
       FROM daily_logs dl
       JOIN users u ON u.id = dl.user_id
       WHERE u.clerk_user_id = $1
         AND dl.logged_date >= DATE_TRUNC('week', CURRENT_DATE)`,
      [userId],
    )
    res.json(rows[0] ?? { avg_water_oz: null, avg_steps: null, avg_weight: null, avg_sleep_minutes: null })
  } catch (err) {
    next(err)
  }
})

// POST /api/daily-logs — upsert; only provided fields are written.
// Sending a field as explicit null (e.g. { steps: null }) is a CLEAR signal:
// sets the value to null and the source to null so auto-sync can fill it again.
// Omitting a field entirely keeps the existing value unchanged (COALESCE).
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const body      = req.body
    const dbUserId  = await getOrCreateUser(userId)

    // Detect explicit null == "clear this field so sync can fill it"
    const clearSteps = Object.hasOwn(body, 'steps')         && body.steps         === null
    const clearSleep = Object.hasOwn(body, 'sleep_minutes') && body.sleep_minutes === null

    if (clearSteps || clearSleep) {
      const sets = []
      if (clearSteps) sets.push('steps = NULL', 'steps_source = NULL')
      if (clearSleep) sets.push('sleep_minutes = NULL', 'sleep_source = NULL')
      const { rows: cleared } = await pool.query(
        `UPDATE daily_logs SET ${sets.join(', ')}
         WHERE user_id = $1 AND logged_date = CURRENT_DATE
         RETURNING water_oz, steps, weight_lbs, sleep_minutes`,
        [dbUserId],
      )
      return res.json(cleared[0] ?? { water_oz: null, steps: null, weight_lbs: null, sleep_minutes: null })
    }

    const { water_oz = null, steps = null, weight_lbs = null, sleep_minutes = null } = body

    const { rows } = await pool.query(
      `INSERT INTO daily_logs (user_id, logged_date, water_oz, steps, weight_lbs, steps_source, sleep_minutes, sleep_source)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, 'manual', $5, 'manual')
       ON CONFLICT (user_id, logged_date) DO UPDATE SET
         water_oz      = COALESCE(EXCLUDED.water_oz,      daily_logs.water_oz),
         steps         = COALESCE(EXCLUDED.steps,         daily_logs.steps),
         weight_lbs    = COALESCE(EXCLUDED.weight_lbs,    daily_logs.weight_lbs),
         sleep_minutes = COALESCE(EXCLUDED.sleep_minutes, daily_logs.sleep_minutes),
         steps_source = CASE
           WHEN EXCLUDED.steps IS NOT NULL THEN 'manual'
           ELSE COALESCE(daily_logs.steps_source, 'manual')
         END,
         sleep_source = CASE
           WHEN EXCLUDED.sleep_minutes IS NOT NULL THEN 'manual'
           ELSE COALESCE(daily_logs.sleep_source, 'manual')
         END
       RETURNING water_oz, steps, weight_lbs, sleep_minutes`,
      [dbUserId, water_oz, steps, weight_lbs, sleep_minutes],
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
