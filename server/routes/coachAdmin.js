import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCurrentStaff(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [dbUserId])
  return { dbUserId, role: rows[0]?.role ?? 'client' }
}

async function requireStaff(req, res) {
  const ctx = await getCurrentStaff(req)
  if (ctx.role !== 'admin' && ctx.role !== 'coach') {
    res.status(403).json({ error: 'Staff only' })
    return null
  }
  return ctx
}

async function requireAdmin(req, res) {
  const ctx = await getCurrentStaff(req)
  if (ctx.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' })
    return null
  }
  return ctx
}

// Returns true if staff member (admin or coach) can access this client
async function canAccessClient(ctx, clientId) {
  if (ctx.role === 'admin') return true
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE id = $1 AND assigned_coach_id = $2',
    [clientId, ctx.dbUserId],
  )
  return rows.length > 0
}

// Internal supportive status tag — never use shame words
function computeStatusTag(client) {
  if (!client.onboarding_complete || !client.assessment_complete) return 'New Client'
  const adh7  = Number(client.adherence_7d  || 0)
  const adh30 = Number(client.adherence_30d || 0)
  if (adh7 >= 80) return 'Consistent'
  if (adh7 >= 50) return 'Building Momentum'
  if (adh30 >= 50 && adh7 < 30) return 'Needs Attention'
  if (adh7 > adh30) return 'Rebuilding Momentum'
  return 'Building Momentum'
}

// Same supportive language for momentum
function computeMomentum(adh7, adh30) {
  if (adh7 >= 90) return 'Locked In'
  if (adh7 >= 75) return 'Strong'
  if (adh7 >= 50) return 'Stable'
  if (adh7 < 30 && adh30 > adh7) return 'Rebuilding Momentum'
  return 'Building'
}

// ─── Clients list ─────────────────────────────────────────────────────────────

// GET /api/coach-admin/clients?status=active|archived|all (default active)
router.get('/clients', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const params = []
    let where = `WHERE u.role IN ('client', 'admin') AND COALESCE(u.client_status, 'active') != 'deleted'`

    const statusFilter = req.query.status ?? 'active'
    if (statusFilter === 'active') {
      where += ` AND COALESCE(u.client_status, 'active') = 'active'`
    } else if (statusFilter === 'archived') {
      where += ` AND u.client_status = 'archived'`
    }
    // 'all' → no extra filter (still excludes deleted)

    if (ctx.role === 'coach') {
      params.push(ctx.dbUserId)
      where += ` AND u.assigned_coach_id = $${params.length}`
    }

    const { rows } = await pool.query(`
      SELECT
        u.id, u.first_name, u.email, u.phone_number,
        u.coaching_type, u.assigned_coach_id, u.role,
        u.onboarding_complete, u.assessment_complete,
        u.last_login_at, u.start_date, u.paid, u.paid_at, u.created_at,
        u.client_status, u.archived_at,
        -- Effective start date: explicit start_date → paid_at → created_at
        COALESCE(u.start_date, u.paid_at::date, u.created_at::date) AS effective_start_date,
        (SELECT first_name FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_name,
        (SELECT email      FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_email,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = u.id) AS last_meal_at,
        COALESCE((
          SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions hc
          WHERE hc.user_id = u.id AND hc.completion_date >= CURRENT_DATE - INTERVAL '7 days'
        ), 0) AS adherence_7d,
        COALESCE((
          SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions hc
          WHERE hc.user_id = u.id AND hc.completion_date >= CURRENT_DATE - INTERVAL '30 days'
        ), 0) AS adherence_30d
      FROM users u
      ${where}
      ORDER BY u.first_name ASC NULLS LAST
    `, params)

    res.json(rows.map(r => ({ ...r, status_tag: computeStatusTag(r) })))
  } catch (err) { next(err) }
})

// GET /api/coach-admin/coaches — list available coaches for assignment dropdown
router.get('/coaches', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const { rows } = await pool.query(`
      SELECT id, first_name, email FROM users
      WHERE role IN ('coach', 'admin')
      ORDER BY first_name ASC NULLS LAST
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Single client profile ────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id
router.get('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(`
      SELECT u.*,
        COALESCE(u.start_date, u.paid_at::date, u.created_at::date) AS effective_start_date,
        (SELECT first_name FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_name,
        (SELECT email      FROM users WHERE id = u.assigned_coach_id) AS assigned_coach_email,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = u.id) AS last_meal_at,
        COALESCE((SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions
          WHERE user_id = u.id AND completion_date >= CURRENT_DATE - INTERVAL '7 days'), 0) AS adherence_7d,
        COALESCE((SELECT AVG(completion_percentage)::numeric(5,1)
          FROM habit_completions
          WHERE user_id = u.id AND completion_date >= CURRENT_DATE - INTERVAL '30 days'), 0) AS adherence_30d,
        (SELECT COUNT(*) FROM comeback_events WHERE user_id = u.id) AS comeback_count,
        ha.first_name           AS assessment_first_name,
        ha.last_name            AS assessment_last_name,
        ha.phone                AS assessment_phone,
        ha.date_of_birth        AS assessment_dob,
        ha.shirt_size           AS assessment_shirt_size,
        ha.street_address       AS assessment_street_address,
        ha.city                 AS assessment_city,
        ha.state                AS assessment_state,
        ha.zip_code             AS assessment_zip_code,
        ha.country              AS assessment_country
      FROM users u
      LEFT JOIN health_assessments ha ON ha.user_id = u.id
      WHERE u.id = $1
    `, [id])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })

    const c = rows[0]

    // Field fallback chain: users table → health_assessments → null
    const merged = {
      ...c,
      // Build display name from first_name + assessment data
      display_first_name: c.first_name || c.assessment_first_name || null,
      display_last_name:  c.assessment_last_name || null,
      display_phone:      c.phone_number || c.assessment_phone || null,
      display_dob:        c.assessment_dob || null,
      display_shirt_size: c.assessment_shirt_size || null,
      display_address: {
        street:  c.assessment_street_address || null,
        city:    c.assessment_city || null,
        state:   c.assessment_state || null,
        zip:     c.assessment_zip_code || null,
        country: c.assessment_country || null,
      },
      status_tag: computeStatusTag(c),
      momentum: computeMomentum(c.adherence_7d, c.adherence_30d),
    }
    res.json(merged)
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id — admin can update profile/coaching fields
// Dynamic SET so `assigned_coach_id: null` actually unassigns the coach (unlike
// COALESCE, which would preserve the existing value).
router.patch('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)

    const allowed = ['coaching_type', 'assigned_coach_id', 'role', 'start_date',
                     'phone_number', 'paid', 'first_name']
    const setClauses = []
    const params = []
    for (const key of allowed) {
      if (key in req.body) {
        let value = req.body[key]
        // Normalize empty string → NULL for these fields
        if (key === 'assigned_coach_id') {
          value = (value === '' || value === null) ? null : Number(value)
        }
        if (key === 'start_date' && value === '') value = null
        params.push(value)
        setClauses.push(`${key} = $${params.length}`)
      }
    }

    // When flipping paid → TRUE, also set paid_at if it's currently NULL
    if (req.body.paid === true) {
      setClauses.push('paid_at = COALESCE(paid_at, NOW())')
    }

    if (setClauses.length === 0) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])
      return res.json(rows[0] ?? null)
    }

    params.push(id)
    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params,
    )
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── Lifecycle: archive / reactivate / soft-delete ────────────────────────────

// PATCH /api/coach-admin/clients/:id/archive
router.patch('/clients/:id/archive', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { userId } = getAuth(req)
    const adminDbId = await getOrCreateUser(userId)
    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'archived',
          archived_at = NOW(),
          archived_by = $2
      WHERE id = $1 AND COALESCE(client_status, 'active') != 'deleted'
      RETURNING id, client_status, archived_at
    `, [id, adminDbId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, ...rows[0] })
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/clients/:id/reactivate
router.patch('/clients/:id/reactivate', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'active',
          archived_at = NULL,
          archived_by = NULL,
          deleted_at = NULL,
          deleted_by = NULL
      WHERE id = $1
      RETURNING id, client_status
    `, [id])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, ...rows[0] })
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/clients/:id — SOFT delete (preserves all data)
// Pass ?hard=true to permanently remove (admin only, requires confirmation
// at the API level by sending {confirm: 'PERMANENT_DELETE'} in the body).
router.delete('/clients/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await requireAdmin(req, res) === null) return
    const id = parseInt(req.params.id, 10)
    const { userId } = getAuth(req)
    const adminDbId = await getOrCreateUser(userId)

    if (id === adminDbId) {
      return res.status(400).json({ error: 'Cannot delete your own account' })
    }

    // Hard delete only if explicitly confirmed
    if (req.query.hard === 'true' && req.body?.confirm === 'PERMANENT_DELETE') {
      await pool.query('DELETE FROM users WHERE id = $1', [id])
      return res.json({ ok: true, hard_deleted: true })
    }

    const { rows } = await pool.query(`
      UPDATE users
      SET client_status = 'deleted',
          deleted_at = NOW(),
          deleted_by = $2
      WHERE id = $1
      RETURNING id, client_status, deleted_at
    `, [id, adminDbId])
    if (!rows.length) return res.status(404).json({ error: 'Client not found' })
    res.json({ ok: true, soft_deleted: true, ...rows[0] })
  } catch (err) { next(err) }
})

// ─── Engagement / progress summary ────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/engagement
router.get('/clients/:id/engagement', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const wk = `CURRENT_DATE - INTERVAL '7 days'`
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM meals WHERE user_id = $1 AND logged_at >= ${wk}) AS food_logs_week,
        (SELECT COUNT(*) FROM workout_logs WHERE user_id = $1 AND completed_at >= ${wk}) AS workouts_week,
        (SELECT COUNT(*) FROM daily_logs WHERE user_id = $1 AND logged_date >= CURRENT_DATE - 7 AND water_oz IS NOT NULL) AS water_logs_week,
        (SELECT COUNT(*) FROM daily_logs WHERE user_id = $1 AND logged_date >= CURRENT_DATE - 7 AND steps IS NOT NULL) AS step_logs_week,
        (SELECT MAX(logged_at) FROM meals WHERE user_id = $1) AS last_meal_at,
        (SELECT MAX(logged_date) FROM daily_logs WHERE user_id = $1) AS last_daily_log,
        (SELECT COUNT(*) FROM habit_completions WHERE user_id = $1 AND completion_date >= ${wk} AND status = 'complete') AS habits_complete_week,
        (SELECT COUNT(*) FROM habit_completions WHERE user_id = $1 AND completion_date >= ${wk} AND status IS NULL) AS habits_missed_week,
        (SELECT COUNT(*) FROM comeback_events WHERE user_id = $1) AS comeback_count
    `, [id])

    res.json(stats)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/progress — 7d/30d summaries from existing tables
router.get('/clients/:id/progress', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const [weights, water, steps, recentMeals, recentWorkouts, recentJournals, photos] = await Promise.all([
      pool.query(`SELECT logged_date, weight_lbs FROM daily_logs
                  WHERE user_id = $1 AND weight_lbs IS NOT NULL
                  ORDER BY logged_date DESC LIMIT 30`, [id]),
      pool.query(`SELECT logged_date, water_oz FROM daily_logs
                  WHERE user_id = $1 AND water_oz IS NOT NULL
                  ORDER BY logged_date DESC LIMIT 30`, [id]),
      pool.query(`SELECT logged_date, steps FROM daily_logs
                  WHERE user_id = $1 AND steps IS NOT NULL
                  ORDER BY logged_date DESC LIMIT 30`, [id]),
      pool.query(`SELECT meal_name, calories, logged_at FROM meals
                  WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 10`, [id]),
      pool.query(`SELECT w.name AS workout_name, wl.completed_at FROM workout_logs wl
                  LEFT JOIN workouts w ON w.id = wl.workout_id
                  WHERE wl.user_id = $1 ORDER BY wl.completed_at DESC LIMIT 10`, [id]),
      pool.query(`SELECT photo_url, angle, taken_at FROM progress_photos
                  WHERE user_id = $1 ORDER BY taken_at DESC LIMIT 6`, [id]),
      pool.query(`SELECT id, photo_url, angle, taken_at FROM progress_photos
                  WHERE user_id = $1 ORDER BY taken_at DESC LIMIT 6`, [id]),
    ])

    res.json({
      weights:        weights.rows,
      water:          water.rows,
      steps:          steps.rows,
      recent_meals:   recentMeals.rows,
      recent_workouts: recentWorkouts.rows,
      progress_photos: photos.rows,
    })
  } catch (err) { next(err) }
})

// ─── Habit assignment ─────────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/habits — list assigned habits
router.get('/clients/:id/habits', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { rows } = await pool.query(`
      SELECT h.*, (SELECT first_name FROM users WHERE id = h.assigned_by_user_id) AS assigned_by_name
      FROM coach_assigned_habits h
      WHERE h.user_id = $1
      ORDER BY h.start_date DESC, h.created_at DESC
    `, [id])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/habits — assign new habit
router.post('/clients/:id/habits', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const {
      habit_name, habit_type = 'boolean', target_value, unit,
      frequency = 'daily', start_date, end_date, days_of_week, notes,
    } = req.body
    if (!habit_name?.trim() || !start_date) {
      return res.status(400).json({ error: 'habit_name and start_date required' })
    }

    const { rows } = await pool.query(`
      INSERT INTO coach_assigned_habits
        (user_id, assigned_by_user_id, habit_name, habit_type, target_value, unit,
         frequency, start_date, end_date, days_of_week, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      id, ctx.dbUserId,
      habit_name.trim(), habit_type,
      target_value != null ? Number(target_value) : null,
      unit?.trim() || null,
      frequency, start_date, end_date ?? null,
      days_of_week ?? null,
      notes?.trim() || null,
    ])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/coach-admin/habits/:habitId — edit habit
router.patch('/habits/:habitId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const habitId = parseInt(req.params.habitId, 10)

    // verify access via the habit's user
    const { rows: hRows } = await pool.query('SELECT user_id FROM coach_assigned_habits WHERE id = $1', [habitId])
    if (!hRows.length) return res.status(404).json({ error: 'Habit not found' })
    if (!await canAccessClient(ctx, hRows[0].user_id)) return res.status(403).json({ error: 'Forbidden' })

    const {
      habit_name, habit_type, target_value, unit,
      frequency, start_date, end_date, days_of_week, notes, active,
    } = req.body

    const { rows } = await pool.query(`
      UPDATE coach_assigned_habits SET
        habit_name   = COALESCE($1, habit_name),
        habit_type   = COALESCE($2, habit_type),
        target_value = COALESCE($3, target_value),
        unit         = COALESCE($4, unit),
        frequency    = COALESCE($5, frequency),
        start_date   = COALESCE($6, start_date),
        end_date     = COALESCE($7, end_date),
        days_of_week = COALESCE($8, days_of_week),
        notes        = COALESCE($9, notes),
        active       = COALESCE($10, active),
        updated_at   = NOW()
      WHERE id = $11 RETURNING *
    `, [
      habit_name ?? null, habit_type ?? null,
      target_value != null ? Number(target_value) : null,
      unit ?? null, frequency ?? null,
      start_date ?? null, end_date ?? null, days_of_week ?? null,
      notes ?? null, active ?? null,
      habitId,
    ])
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/habits/:habitId
router.delete('/habits/:habitId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const habitId = parseInt(req.params.habitId, 10)

    const { rows: hRows } = await pool.query('SELECT user_id FROM coach_assigned_habits WHERE id = $1', [habitId])
    if (!hRows.length) return res.status(404).json({ error: 'Habit not found' })
    if (!await canAccessClient(ctx, hRows[0].user_id)) return res.status(403).json({ error: 'Forbidden' })

    await pool.query('DELETE FROM coach_assigned_habits WHERE id = $1', [habitId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/habits/calendar?start=...&end=...
// Expand habits into per-day instances for the calendar view
router.get('/clients/:id/habits/calendar', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const startDate = req.query.start ?? new Date().toISOString().slice(0, 10)
    const endDate   = req.query.end   ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)

    // Get all habits that overlap the window, plus completions
    const { rows: habits } = await pool.query(`
      SELECT * FROM coach_assigned_habits
      WHERE user_id = $1 AND active = TRUE
        AND start_date <= $3::date
        AND (end_date IS NULL OR end_date >= $2::date)
    `, [id, startDate, endDate])

    const { rows: completions } = await pool.query(`
      SELECT habit_id, completion_date, completed_value, completion_percentage, status
      FROM habit_completions
      WHERE user_id = $1
        AND completion_date BETWEEN $2::date AND $3::date
    `, [id, startDate, endDate])

    // Helper: pg returns DATE as a JS Date in server local TZ. Use local
    // components — do NOT use toISOString() which can shift the day.
    const toISODate = v => {
      if (v == null) return null
      if (typeof v === 'string') return v.slice(0, 10)
      if (v instanceof Date) {
        const y = v.getFullYear()
        const m = String(v.getMonth() + 1).padStart(2, '0')
        const d = String(v.getDate()).padStart(2, '0')
        return `${y}-${m}-${d}`
      }
      return String(v).slice(0, 10)
    }

    // Build a {habit_id: {date: completion}} map
    const compMap = {}
    for (const c of completions) {
      const dateKey = toISODate(c.completion_date)
      if (!compMap[c.habit_id]) compMap[c.habit_id] = {}
      compMap[c.habit_id][dateKey] = c
    }

    // Expand each habit into per-day instances within the window
    const calendar = {}  // { 'YYYY-MM-DD': [{ habit, completion }] }
    const start = new Date(`${startDate}T00:00:00`)
    const end   = new Date(`${endDate}T00:00:00`)
    for (const habit of habits) {
      const hStartISO = toISODate(habit.start_date)
      const hEndISO   = toISODate(habit.end_date)
      const habitStart = new Date(`${hStartISO}T00:00:00`)
      const habitEnd   = hEndISO ? new Date(`${hEndISO}T00:00:00`) : end
      const allowed = habit.days_of_week
        ? habit.days_of_week.split(',').map(s => parseInt(s, 10))
        : null

      const iterStart = new Date(Math.max(start.getTime(), habitStart.getTime()))
      const iterEnd   = new Date(Math.min(end.getTime(), habitEnd.getTime()))
      for (let d = new Date(iterStart); d <= iterEnd; d.setDate(d.getDate() + 1)) {
        if (habit.frequency === 'specific_days' && allowed && !allowed.includes(d.getDay())) continue
        if (habit.frequency === 'weekly' && d.getDay() !== habitStart.getDay()) continue

        const key = toISODate(d)
        if (!calendar[key]) calendar[key] = []
        calendar[key].push({
          habit: { ...habit, start_date: hStartISO, end_date: hEndISO },
          completion: compMap[habit.id]?.[key] ?? null,
        })
      }
    }

    res.json({ start: startDate, end: endDate, calendar })
  } catch (err) { next(err) }
})

// ─── Notes ────────────────────────────────────────────────────────────────────

// GET /api/coach-admin/clients/:id/notes
router.get('/clients/:id/notes', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    // Coaches cannot see admin_private notes
    const visibilityFilter = ctx.role === 'admin'
      ? ''
      : `AND n.visibility = 'shared_staff'`

    const { rows } = await pool.query(`
      SELECT n.*, u.first_name AS author_name
      FROM client_notes n
      LEFT JOIN users u ON u.id = n.author_id
      WHERE n.client_id = $1 ${visibilityFilter}
      ORDER BY n.created_at DESC
    `, [id])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/notes
router.post('/clients/:id/notes', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { note_body, visibility = 'shared_staff' } = req.body
    if (!note_body?.trim()) return res.status(400).json({ error: 'note_body required' })

    // Only admins can create admin_private notes
    const finalVisibility = (visibility === 'admin_private' && ctx.role !== 'admin')
      ? 'shared_staff'
      : visibility

    const { rows } = await pool.query(`
      INSERT INTO client_notes (client_id, author_id, note_body, visibility)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [id, ctx.dbUserId, note_body.trim(), finalVisibility])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/coach-admin/notes/:noteId
router.delete('/notes/:noteId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const noteId = parseInt(req.params.noteId, 10)

    const { rows: nRows } = await pool.query('SELECT client_id, author_id, visibility FROM client_notes WHERE id = $1', [noteId])
    if (!nRows.length) return res.status(404).json({ error: 'Note not found' })

    // Coaches can only delete their own notes; admins can delete any
    if (ctx.role !== 'admin' && nRows[0].author_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'Cannot delete this note' })
    }
    if (nRows[0].visibility === 'admin_private' && ctx.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' })
    }

    await pool.query('DELETE FROM client_notes WHERE id = $1', [noteId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Messages ─────────────────────────────────────────────────────────────────

// GET /api/coach-admin/messaging/inbox — returns all threads across accessible clients with unread counts
router.get('/messaging/inbox', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const isAdmin = ctx.role === 'admin'
    const params = []
    let extraWhere = `COALESCE(u.client_status, 'active') != 'deleted'`
    if (!isAdmin) {
      params.push(ctx.dbUserId)
      extraWhere += ` AND u.assigned_coach_id = $${params.length} AND m.thread_type = 'coach_thread'`
    }
    const { rows } = await pool.query(`
      SELECT
        u.id AS client_id,
        u.first_name,
        m.thread_type,
        COUNT(*) FILTER (WHERE m.sender_role = 'client' AND m.read_at IS NULL)::int AS unread,
        MAX(m.created_at) AS last_message_at,
        (SELECT CASE WHEN message_body != '' THEN message_body ELSE '📷 Image' END
          FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type
          ORDER BY created_at DESC LIMIT 1) AS last_message_body,
        (SELECT sender_role FROM client_messages
          WHERE client_id = u.id AND thread_type = m.thread_type
          ORDER BY created_at DESC LIMIT 1) AS last_sender_role
      FROM client_messages m
      JOIN users u ON u.id = m.client_id
      WHERE ${extraWhere}
      GROUP BY u.id, u.first_name, m.thread_type
      ORDER BY MAX(m.created_at) DESC
    `, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/messages?thread=coach_thread|admin_private|ai_admin
router.get('/clients/:id/messages', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const thread = req.query.thread

    // Permission gate per thread type:
    // coach_thread:  admin + assigned coach can view
    // admin_private: admin only
    // ai_admin:      admin only
    if ((thread === 'admin_private' || thread === 'ai_admin') && ctx.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only thread' })
    }

    const params = [id]
    let where = 'WHERE m.client_id = $1'
    if (thread) {
      params.push(thread)
      where += ` AND m.thread_type = $${params.length}`
    } else if (ctx.role !== 'admin') {
      // Coaches default to coach_thread only
      where += ` AND m.thread_type = 'coach_thread'`
    }

    const { rows } = await pool.query(`
      SELECT m.*, u.first_name AS sender_name
      FROM client_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      ${where}
      ORDER BY m.created_at ASC
    `, params)

    // Mark client messages as read now that staff has viewed the thread
    const readParams = [id]
    let readWhere = `WHERE client_id = $1 AND sender_role = 'client' AND read_at IS NULL`
    if (thread) {
      readParams.push(thread)
      readWhere += ` AND thread_type = $${readParams.length}`
    }
    await pool.query(`UPDATE client_messages SET read_at = NOW() ${readWhere}`, readParams)

    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/coach-admin/clients/:id/messages
router.post('/clients/:id/messages', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { message_body = '', thread_type = 'coach_thread', image_url } = req.body
    if (!message_body?.trim() && !image_url) return res.status(400).json({ error: 'message_body or image required' })

    // Coach can only send to coach_thread
    if (ctx.role === 'coach' && thread_type !== 'coach_thread') {
      return res.status(403).json({ error: 'Coaches can only send to coach thread' })
    }

    // Determine visibility based on thread_type
    const visibility = (thread_type === 'admin_private' || thread_type === 'ai_admin')
      ? 'client_and_admin_only'
      : 'client_and_staff'

    // If sending to ai_admin, verify client is an AI client
    if (thread_type === 'ai_admin') {
      const { rows } = await pool.query('SELECT coaching_type FROM users WHERE id = $1', [id])
      if (rows[0]?.coaching_type !== 'ai') {
        return res.status(400).json({ error: 'ai_admin thread is only for AI coaching clients' })
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [id, ctx.dbUserId, ctx.role, message_body.trim(), thread_type, visibility, image_url ?? null])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// ─── Assessment view/edit ─────────────────────────────────────────────────────
// Admin can already view via /api/admin/assessments. Add a write endpoint here.

// PATCH /api/coach-admin/clients/:id/assessment — admin/coach can edit assessment
router.patch('/clients/:id/assessment', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    // Use a simple field-by-field COALESCE approach for safety
    const fields = [
      'first_name', 'last_name', 'phone', 'street_address', 'city', 'state', 'zip_code', 'country',
      'date_of_birth', 'shirt_size', 'coach_name', 'supplements', 'goals_6_months',
      'injuries_limitations', 'num_kids', 'occupation', 'energy_level', 'sleep_hours',
      'stress_management', 'sleep_quality', 'daily_water', 'alcohol_weekdays', 'alcohol_weekends',
      'happiness_level', 'confidence_level', 'activity_level',
    ]
    const setClauses = []
    const params = []
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f])
        setClauses.push(`${f} = $${params.length}`)
      }
    }
    if (!setClauses.length) return res.json({ ok: true })
    params.push(id)
    const { rows } = await pool.query(`
      UPDATE health_assessments SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE user_id = $${params.length} RETURNING *
    `, params)
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// ─── Comeback events ──────────────────────────────────────────────────────────

// POST /api/coach-admin/clients/:id/comeback — manually log a comeback (system can also call this)
router.post('/clients/:id/comeback', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })

    const { gap_start_date, gap_end_date, comeback_date, comeback_type = 'returned_to_logging' } = req.body
    if (!comeback_date) return res.status(400).json({ error: 'comeback_date required' })
    const { rows } = await pool.query(`
      INSERT INTO comeback_events (user_id, gap_start_date, gap_end_date, comeback_date, comeback_type)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [id, gap_start_date ?? null, gap_end_date ?? null, comeback_date, comeback_type])
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/coach-admin/clients/:id/comeback
router.get('/clients/:id/comeback', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await requireStaff(req, res); if (!ctx) return
    const id = parseInt(req.params.id, 10)
    if (!await canAccessClient(ctx, id)) return res.status(403).json({ error: 'Forbidden' })
    const { rows } = await pool.query(
      'SELECT * FROM comeback_events WHERE user_id = $1 ORDER BY comeback_date DESC LIMIT 20',
      [id],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

export default router
