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

async function getCoachFood(id) {
  const { rows } = await pool.query(`
    SELECT cf.id, cf.food_name, cf.calories_per_serving, cf.protein, cf.carbs, cf.fat, cf.fiber,
           cf.serving_size, cf.serving_unit, cf.notes,
           COALESCE(cf.is_active, TRUE) AS is_active,
           cf.created_at, cf.updated_at,
           u.first_name AS created_by_name
    FROM custom_foods cf
    LEFT JOIN users u ON u.id = cf.created_by
    WHERE cf.id = $1 AND cf.is_global = TRUE AND cf.is_coach_food = TRUE
  `, [id])
  return rows[0] ?? null
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

// PATCH /api/admin/users/:id/macros  (admin or assigned coach)
router.patch('/users/:id/macros', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const callerId = await getOrCreateUser(userId)
    const targetId = parseInt(req.params.id, 10)

    // Allow admin, or the coach assigned to this specific client
    const { rows: callerRows } = await pool.query('SELECT role FROM users WHERE id = $1', [callerId])
    const callerRole = callerRows[0]?.role
    if (callerRole !== 'admin') {
      const { rows: clientRows } = await pool.query('SELECT assigned_coach_id FROM users WHERE id = $1', [targetId])
      if (clientRows[0]?.assigned_coach_id !== callerId) {
        return res.status(403).json({ error: 'Not authorized' })
      }
    }

    const MACRO_FIELDS = ['goal_calories', 'goal_protein', 'goal_carbs', 'goal_fat', 'goal_fiber', 'goal_water']
    const setClauses = []
    const params = []
    for (const field of MACRO_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        const v = req.body[field]
        params.push(v == null ? null : Number(v))
        setClauses.push(`${field} = $${params.length}`)
      }
    }
    if (!setClauses.length) return res.status(400).json({ error: 'No fields provided' })
    params.push(targetId)
    const { rows } = await pool.query(`
      UPDATE users SET ${setClauses.join(', ')}
      WHERE id = $${params.length}
      RETURNING id, first_name, goal_calories, goal_protein, goal_carbs, goal_fat, goal_fiber, goal_water
    `, params)
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// ── Coach Foods ───────────────────────────────────────────────────────────────

// GET /api/admin/coach-foods — list all admin-curated coach foods (active first)
router.get('/coach-foods', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(`
      SELECT cf.id, cf.food_name, cf.calories_per_serving, cf.protein, cf.carbs, cf.fat, cf.fiber,
             cf.serving_size, cf.serving_unit, cf.notes,
             COALESCE(cf.is_active, TRUE) AS is_active,
             cf.created_at, cf.updated_at,
             u.first_name AS created_by_name
      FROM custom_foods cf
      LEFT JOIN users u ON u.id = cf.created_by
      WHERE cf.is_global = TRUE AND cf.is_coach_food = TRUE
      ORDER BY COALESCE(cf.is_active, TRUE) DESC, cf.food_name ASC
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/admin/coach-foods — create a new coach food
router.post('/coach-foods', requireAuth(), async (req, res, next) => {
  try {
    const callerId = await requireAdmin(req, res)
    if (callerId === null) return
    const { food_name, calories, protein, carbs, fat, fiber, serving_size, serving_unit, notes } = req.body
    if (!food_name?.trim()) return res.status(400).json({ error: 'food_name required' })

    const ss = serving_size != null && serving_size !== '' ? Number(serving_size) : 100
    const su = serving_unit?.trim() || 'g'

    const { rows } = await pool.query(`
      INSERT INTO custom_foods
        (is_global, is_coach_food, is_active, food_name, calories_per_serving, protein, carbs, fat, fiber,
         serving_size, serving_unit, notes, created_by)
      VALUES (TRUE, TRUE, TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      food_name.trim(),
      calories != null ? Number(calories) : null,
      protein  != null ? Number(protein)  : null,
      carbs    != null ? Number(carbs)    : null,
      fat      != null ? Number(fat)      : null,
      fiber    != null ? Number(fiber)    : null,
      ss, su,
      notes?.trim() || null,
      callerId,
    ])
    res.status(201).json(await getCoachFood(rows[0].id))
  } catch (err) { next(err) }
})

// PATCH /api/admin/coach-foods/:id — update any fields on a coach food
router.patch('/coach-foods/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { food_name, calories, protein, carbs, fat, fiber, serving_size, serving_unit, notes, is_active } = req.body

    const sets = []
    const params = []
    function add(col, val) { params.push(val); sets.push(`${col} = $${params.length}`) }

    if (food_name  !== undefined) add('food_name',            food_name.trim())
    if (calories   !== undefined) add('calories_per_serving', calories  !== '' ? Number(calories)  : null)
    if (protein    !== undefined) add('protein',              protein   !== '' ? Number(protein)   : null)
    if (carbs      !== undefined) add('carbs',                carbs     !== '' ? Number(carbs)     : null)
    if (fat        !== undefined) add('fat',                  fat       !== '' ? Number(fat)       : null)
    if (fiber      !== undefined) add('fiber',                fiber     !== '' ? Number(fiber)     : null)
    if (serving_size !== undefined) add('serving_size',       serving_size !== '' ? Number(serving_size) : 100)
    if (serving_unit !== undefined) add('serving_unit',       serving_unit?.trim() || 'g')
    if (notes      !== undefined) add('notes',                notes?.trim() || null)
    if (is_active  !== undefined) add('is_active',            Boolean(is_active))

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' })

    params.push(id)
    const { rows } = await pool.query(`
      UPDATE custom_foods
      SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length} AND is_global = TRUE AND is_coach_food = TRUE
      RETURNING id
    `, params)
    if (!rows.length) return res.status(404).json({ error: 'Coach food not found' })
    res.json(await getCoachFood(rows[0].id))
  } catch (err) { next(err) }
})

// DELETE /api/admin/coach-foods/:id — remove a coach food
router.delete('/coach-foods/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { rows } = await pool.query(
      `UPDATE custom_foods
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND is_global = TRUE AND is_coach_food = TRUE
       RETURNING id`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Coach food not found' })
    res.json(await getCoachFood(rows[0].id))
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

// ── Usage Analytics ───────────────────────────────────────────────────────────
// GET /api/admin/usage-analytics?start=YYYY-MM-DD&end=YYYY-MM-DD
// Super-admin only. Default: last 30 days.

router.get('/usage-analytics', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return

    const now    = new Date()
    const defEnd = now.toISOString().slice(0, 10)
    const defStart = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)

    const start = req.query.start || defStart
    const end   = req.query.end   || defEnd

    // Validate date format
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRe.test(start) || !dateRe.test(end)) {
      return res.status(400).json({ error: 'start and end must be YYYY-MM-DD' })
    }

    const startTs = `${start}T00:00:00Z`
    const endTs   = `${end}T23:59:59Z`

    // Run all aggregation queries in parallel
    const [
      totalsResult,
      byFeatureResult,
      byProviderResult,
      highCostClientsResult,
      recentExpensiveResult,
      dailyTrendResult,
      engagementResult,
      clientCountResult,
    ] = await Promise.all([

      // 1. Overall totals
      pool.query(`
        SELECT
          COALESCE(SUM(estimated_cost_usd), 0)                                        AS total_cost,
          COALESCE(SUM(CASE WHEN action = 'ai_call' THEN estimated_cost_usd ELSE 0 END), 0) AS ai_cost,
          COALESCE(SUM(CASE WHEN action = 'upload'  THEN estimated_cost_usd ELSE 0 END), 0) AS upload_cost,
          COUNT(*)::int                                                                AS event_count,
          COUNT(CASE WHEN status = 'error' THEN 1 END)::int                          AS error_count
        FROM usage_events
        WHERE occurred_at BETWEEN $1 AND $2
      `, [startTs, endTs]),

      // 2. Cost by feature
      pool.query(`
        SELECT feature,
               COALESCE(SUM(estimated_cost_usd), 0) AS cost,
               COUNT(*)::int AS events,
               COUNT(CASE WHEN status = 'error' THEN 1 END)::int AS errors
        FROM usage_events
        WHERE occurred_at BETWEEN $1 AND $2
        GROUP BY feature
        ORDER BY cost DESC
      `, [startTs, endTs]),

      // 3. Cost by provider
      pool.query(`
        SELECT COALESCE(provider, 'unknown') AS provider,
               COALESCE(SUM(estimated_cost_usd), 0) AS cost,
               COUNT(*)::int AS events
        FROM usage_events
        WHERE occurred_at BETWEEN $1 AND $2
        GROUP BY provider
        ORDER BY cost DESC
      `, [startTs, endTs]),

      // 4. High-cost clients — cost attributed to target_user_id (if set) else actor_user_id
      pool.query(`
        SELECT
          COALESCE(ue.target_user_id, ue.actor_user_id)      AS user_id,
          u.first_name,
          u.email,
          u.role,
          COALESCE(SUM(ue.estimated_cost_usd), 0)            AS total_cost,
          COUNT(*)::int                                       AS events,
          COUNT(CASE WHEN ue.action = 'ai_call' THEN 1 END)::int AS ai_calls,
          COUNT(CASE WHEN ue.action = 'upload'  THEN 1 END)::int AS uploads
        FROM usage_events ue
        LEFT JOIN users u ON u.id = COALESCE(ue.target_user_id, ue.actor_user_id)
        WHERE ue.occurred_at BETWEEN $1 AND $2
          AND COALESCE(ue.target_user_id, ue.actor_user_id) IS NOT NULL
        GROUP BY 1, 2, 3, 4
        ORDER BY total_cost DESC
        LIMIT 25
      `, [startTs, endTs]),

      // 5. Recent expensive or error events
      pool.query(`
        SELECT
          ue.id, ue.occurred_at, ue.feature, ue.action, ue.provider,
          ue.model, ue.input_tokens, ue.output_tokens,
          ue.estimated_cost_usd, ue.status, ue.duration_ms,
          u.first_name AS user_name, u.email AS user_email
        FROM usage_events ue
        LEFT JOIN users u ON u.id = COALESCE(ue.target_user_id, ue.actor_user_id)
        WHERE ue.occurred_at BETWEEN $1 AND $2
          AND (ue.estimated_cost_usd > 0 OR ue.status = 'error')
        ORDER BY ue.estimated_cost_usd DESC NULLS LAST, ue.occurred_at DESC
        LIMIT 30
      `, [startTs, endTs]),

      // 6. Daily cost trend
      pool.query(`
        SELECT
          DATE(occurred_at AT TIME ZONE 'UTC')                                        AS date,
          COALESCE(SUM(estimated_cost_usd), 0)                                        AS total_cost,
          COALESCE(SUM(CASE WHEN action = 'ai_call' THEN estimated_cost_usd ELSE 0 END), 0) AS ai_cost,
          COALESCE(SUM(CASE WHEN action = 'upload'  THEN estimated_cost_usd ELSE 0 END), 0) AS upload_cost,
          COUNT(*)::int                                                                AS events
        FROM usage_events
        WHERE occurred_at BETWEEN $1 AND $2
        GROUP BY DATE(occurred_at AT TIME ZONE 'UTC')
        ORDER BY date ASC
      `, [startTs, endTs]),

      // 7. Client engagement status
      // Rules:
      //   never_logged_in : last_login_at IS NULL
      //   inactive        : last_login_at < 30 days ago AND no meal/log activity in 30 days
      //   at_risk         : has activity in 30 days but < 2 active days in last 14 days
      //   moderate        : 2-4 active days in last 14 days
      //   high_usage      : 5+ active days in last 14 days
      pool.query(`
        WITH active_days_14 AS (
          SELECT user_id, COUNT(DISTINCT COALESCE(log_date, logged_at::date)) AS meal_days
          FROM meals
          WHERE COALESCE(log_date, logged_at::date) >= CURRENT_DATE - 14
          GROUP BY user_id
        ),
        active_days_30 AS (
          SELECT user_id, COUNT(DISTINCT COALESCE(log_date, logged_at::date)) AS meal_days
          FROM meals
          WHERE COALESCE(log_date, logged_at::date) >= CURRENT_DATE - 30
          GROUP BY user_id
        ),
        katie_msgs_14 AS (
          SELECT user_id, COUNT(*) AS msg_count
          FROM coaching_conversations
          WHERE role = 'user' AND created_at >= NOW() - INTERVAL '14 days'
          GROUP BY user_id
        )
        SELECT
          u.id, u.first_name, u.email, u.role, u.coaching_type,
          u.last_login_at, u.created_at,
          COALESCE(a14.meal_days, 0) AS active_days_14,
          COALESCE(a30.meal_days, 0) AS active_days_30,
          COALESCE(km.msg_count,  0) AS katie_msgs_14,
          CASE
            WHEN u.last_login_at IS NULL THEN 'never_logged_in'
            WHEN u.last_login_at < NOW() - INTERVAL '30 days'
              AND COALESCE(a30.meal_days, 0) = 0                THEN 'inactive'
            WHEN COALESCE(a14.meal_days, 0) >= 5
              OR  COALESCE(km.msg_count,  0) >= 10              THEN 'high_usage'
            WHEN COALESCE(a14.meal_days, 0) >= 2               THEN 'moderate'
            WHEN COALESCE(a30.meal_days, 0) >= 1               THEN 'at_risk'
            ELSE 'inactive'
          END AS engagement_status
        FROM users u
        LEFT JOIN active_days_14 a14 ON a14.user_id = u.id
        LEFT JOIN active_days_30 a30 ON a30.user_id = u.id
        LEFT JOIN katie_msgs_14  km  ON km.user_id  = u.id
        WHERE u.role = 'client'
          AND u.client_status = 'active'
        ORDER BY active_days_14 DESC, u.first_name ASC
      `),

      // 8. Total client counts
      pool.query(`
        SELECT
          COUNT(*)::int AS total_clients,
          COUNT(CASE WHEN last_login_at >= NOW() - INTERVAL '30 days' THEN 1 END)::int AS active_30d
        FROM users
        WHERE role = 'client' AND client_status = 'active'
      `),
    ])

    const totals       = totalsResult.rows[0]
    const counts       = clientCountResult.rows[0]
    const totalCost    = Number(totals.total_cost)
    const totalClients = counts.total_clients
    const activeClients = counts.active_30d

    // Low/no usage clients = clients with at_risk or inactive or never_logged_in status
    const engagementRows = engagementResult.rows
    const lowUsage = engagementRows.filter(r =>
      ['inactive', 'never_logged_in', 'at_risk'].includes(r.engagement_status),
    )

    res.json({
      range: { start, end },
      totals: {
        total_cost:         totalCost,
        ai_cost:            Number(totals.ai_cost),
        upload_cost:        Number(totals.upload_cost),
        event_count:        totals.event_count,
        error_count:        totals.error_count,
        cost_per_active_client:   activeClients  > 0 ? totalCost / activeClients  : null,
        cost_per_total_client:    totalClients   > 0 ? totalCost / totalClients    : null,
        total_clients,
        active_clients_30d: activeClients,
      },
      by_feature:  byFeatureResult.rows.map(r => ({ ...r, cost: Number(r.cost) })),
      by_provider: byProviderResult.rows.map(r => ({ ...r, cost: Number(r.cost) })),
      high_cost_clients: highCostClientsResult.rows.map(r => ({
        ...r,
        total_cost: Number(r.total_cost),
      })),
      low_usage_clients: lowUsage,
      engagement_summary: {
        never_logged_in: engagementRows.filter(r => r.engagement_status === 'never_logged_in').length,
        inactive:        engagementRows.filter(r => r.engagement_status === 'inactive').length,
        at_risk:         engagementRows.filter(r => r.engagement_status === 'at_risk').length,
        moderate:        engagementRows.filter(r => r.engagement_status === 'moderate').length,
        high_usage:      engagementRows.filter(r => r.engagement_status === 'high_usage').length,
      },
      engagement_per_client: engagementRows,
      recent_events:   recentExpensiveResult.rows.map(r => ({
        ...r,
        estimated_cost_usd: r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
      })),
      daily_trend: dailyTrendResult.rows.map(r => ({
        date:        r.date,
        total_cost:  Number(r.total_cost),
        ai_cost:     Number(r.ai_cost),
        upload_cost: Number(r.upload_cost),
        events:      r.events,
      })),
    })
  } catch (err) {
    next(err)
  }
})

export default router
