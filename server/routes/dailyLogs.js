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

    res.set('Cache-Control', 'no-store')
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

// GET /api/daily-logs/progress?range=30d|90d|6m|custom&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
router.get('/progress', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)
    const rangeParam = ['7d', '30d', '90d', 'custom'].includes(req.query.range) ? req.query.range : '7d'
    const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    const isoDate = d => d.toISOString().slice(0, 10)
    const days       = rangeParam === '90d' ? 90 : rangeParam === '30d' ? 30 : 7
    let startDate
    let endDate = isoDate(new Date())

    if (rangeParam === 'custom') {
      if (!validDate(req.query.start_date) || !validDate(req.query.end_date)) {
        return res.status(400).json({ error: 'Custom range requires start_date and end_date in YYYY-MM-DD format.' })
      }
      startDate = req.query.start_date
      endDate   = req.query.end_date
      if (startDate > endDate) return res.status(400).json({ error: 'start_date must be on or before end_date.' })
    } else {
      const d = new Date()
      d.setDate(d.getDate() - days)
      startDate = isoDate(d)
    }

    const md = `COALESCE(log_date, logged_at::date)`

    const [sumR, wtR, stpR, slpR, macR, waterR, photoR] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT ROUND(weight_lbs::numeric,1) FROM daily_logs WHERE user_id=$1
             AND weight_lbs IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date
             ORDER BY logged_date ASC LIMIT 1) AS weight_start,
          (SELECT ROUND(weight_lbs::numeric,1) FROM daily_logs WHERE user_id=$1
             AND weight_lbs IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date
             ORDER BY logged_date DESC LIMIT 1) AS weight_current,
          (SELECT goal_calories    FROM users WHERE id=$1) AS goal_calories,
          (SELECT goal_protein     FROM users WHERE id=$1) AS goal_protein,
          (SELECT starting_weight_lbs FROM users WHERE id=$1) AS starting_weight_lbs,
          (SELECT ROUND(AVG(dc)) FROM
             (SELECT SUM(calories) dc FROM meals WHERE user_id=$1
                AND ${md} BETWEEN $2::date AND $3::date GROUP BY ${md}) t) AS avg_calories,
          (SELECT ROUND(AVG(dp)::numeric,1) FROM
             (SELECT SUM(protein) dp FROM meals WHERE user_id=$1
                AND ${md} BETWEEN $2::date AND $3::date GROUP BY ${md}) t) AS avg_protein,
          (SELECT ROUND(AVG(steps)) FROM daily_logs WHERE user_id=$1
             AND steps IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date) AS avg_steps,
          (SELECT ROUND(AVG(water_oz)::numeric,1) FROM daily_logs WHERE user_id=$1
             AND water_oz IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date) AS avg_water_oz,
          (SELECT ROUND(AVG(sleep_minutes)) FROM daily_logs WHERE user_id=$1
             AND sleep_minutes IS NOT NULL AND logged_date BETWEEN $2::date AND $3::date) AS avg_sleep_minutes,
          (SELECT COUNT(*)::int FROM workout_logs WHERE user_id=$1
             AND completed_at::date BETWEEN $2::date AND $3::date) AS workouts_completed,
          (SELECT COUNT(*)::int FROM activity_logs WHERE user_id=$1
             AND logged_at::date BETWEEN $2::date AND $3::date) AS activities_completed,
          (SELECT ROUND(COALESCE(SUM((micronutrients->>'sodium_mg')::numeric),0))
             FROM meals WHERE user_id=$1 AND ${md} BETWEEN $2::date AND $3::date) AS total_sodium_mg,
          (SELECT ROUND(AVG(dns)) FROM
             (SELECT SUM((micronutrients->>'sodium_mg')::numeric) dns FROM meals WHERE user_id=$1
                AND ${md} BETWEEN GREATEST($2::date, $3::date - INTERVAL '6 days') AND $3::date GROUP BY ${md}) t) AS avg_sodium_7d
      `, [dbUserId, startDate, endDate]),

      pool.query(`
        SELECT logged_date AS date, ROUND(weight_lbs::numeric,1) AS value
        FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL
          AND logged_date BETWEEN $2::date AND $3::date
        ORDER BY logged_date
      `, [dbUserId, startDate, endDate]),

      pool.query(`
        SELECT logged_date AS date, steps AS value
        FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL
          AND logged_date BETWEEN $2::date AND $3::date
        ORDER BY logged_date
      `, [dbUserId, startDate, endDate]),

      pool.query(`
        SELECT logged_date AS date, sleep_minutes AS value
        FROM daily_logs WHERE user_id=$1 AND sleep_minutes IS NOT NULL
          AND logged_date BETWEEN $2::date AND $3::date
        ORDER BY logged_date
      `, [dbUserId, startDate, endDate]),

      pool.query(`
        SELECT ${md} AS date,
          ROUND(SUM(calories)) AS calories,
          ROUND(SUM(protein)::numeric,1) AS protein,
          ROUND(COALESCE(SUM((micronutrients->>'sodium_mg')::numeric),0)) AS sodium_mg
        FROM meals WHERE user_id=$1 AND ${md} BETWEEN $2::date AND $3::date
        GROUP BY ${md} ORDER BY ${md}
      `, [dbUserId, startDate, endDate]),

      pool.query(`
        SELECT logged_date AS date, ROUND(water_oz::numeric,1) AS value
        FROM daily_logs WHERE user_id=$1 AND water_oz IS NOT NULL
          AND logged_date BETWEEN $2::date AND $3::date
        ORDER BY logged_date
      `, [dbUserId, startDate, endDate]),

      pool.query(`
        SELECT photo_session_id AS session_id, MIN(taken_at) AS session_date,
          json_agg(json_build_object(
            'id', id, 'photo_url', photo_url, 'angle', angle, 'taken_at', taken_at
          ) ORDER BY taken_at) AS photos
        FROM progress_photos WHERE user_id=$1
          AND taken_at::date BETWEEN $2::date AND $3::date
        GROUP BY photo_session_id
        ORDER BY MIN(taken_at) DESC
        LIMIT 20
      `, [dbUserId, startDate, endDate]),
    ])

    const summary = { ...sumR.rows[0] }
    summary.weight_change = (summary.weight_start != null && summary.weight_current != null)
      ? Math.round((Number(summary.weight_current) - Number(summary.weight_start)) * 10) / 10
      : null
    summary.total_activity = (summary.workouts_completed ?? 0) + (summary.activities_completed ?? 0)

    const photoSessions = photoR.rows.map(row => {
      const byAngle = { front: null, side: null, back: null }
      for (const p of row.photos) {
        if (['front', 'side', 'back'].includes(p.angle)) byAngle[p.angle] = p
      }
      return { session_id: row.session_id, session_date: row.session_date, photos: byAngle }
    })

    res.set('Cache-Control', 'no-store')
    res.json({
      range: rangeParam,
      days,
      start_date: startDate,
      end_date: endDate,
      summary,
      weight_series:   wtR.rows,
      step_series:     stpR.rows,
      sleep_series:    slpR.rows,
      macro_series:    macR.rows,
      water_series:    waterR.rows,
      progress_photos: photoSessions,
    })
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
