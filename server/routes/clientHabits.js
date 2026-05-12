import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// Helper: expand habit assignments into per-day instances for [start, end].
// Respects frequency:
//   'daily'          — every day in the habit's date range
//   'specific_days'  — only days listed in days_of_week (CSV of 0-6, Sun=0)
//   'weekly'         — same weekday as habit.start_date
function expandCalendar(habits, completions, startDate, endDate) {
  const compMap = {}
  for (const c of completions) {
    const dateKey = c.completion_date instanceof Date
      ? c.completion_date.toISOString().slice(0, 10)
      : String(c.completion_date).slice(0, 10)
    if (!compMap[c.habit_id]) compMap[c.habit_id] = {}
    compMap[c.habit_id][dateKey] = c
  }

  const calendar = {}
  const winStart = new Date(`${startDate}T00:00:00`)
  const winEnd   = new Date(`${endDate}T00:00:00`)
  for (const habit of habits) {
    const hStart = new Date(`${String(habit.start_date).slice(0, 10)}T00:00:00`)
    const hEnd   = habit.end_date
      ? new Date(`${String(habit.end_date).slice(0, 10)}T00:00:00`)
      : winEnd

    const allowed = habit.days_of_week
      ? habit.days_of_week.split(',').map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n))
      : null

    const iterStart = new Date(Math.max(winStart, hStart))
    const iterEnd   = new Date(Math.min(winEnd, hEnd))
    for (let d = new Date(iterStart); d <= iterEnd; d.setDate(d.getDate() + 1)) {
      if (habit.frequency === 'specific_days' && allowed && !allowed.includes(d.getDay())) continue
      if (habit.frequency === 'weekly' && d.getDay() !== hStart.getDay()) continue
      const key = d.toISOString().slice(0, 10)
      if (!calendar[key]) calendar[key] = []
      calendar[key].push({ habit, completion: compMap[habit.id]?.[key] ?? null })
    }
  }
  return calendar
}

// GET /api/client-habits/me/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns the calling client's assigned habits expanded for the window.
router.get('/me/calendar', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const start = req.query.start ?? new Date().toISOString().slice(0, 10)
    const end   = req.query.end   ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)

    const { rows: habits } = await pool.query(`
      SELECT * FROM coach_assigned_habits
      WHERE user_id = $1 AND active = TRUE
        AND start_date <= $3::date
        AND (end_date IS NULL OR end_date >= $2::date)
    `, [dbUserId, start, end])

    const { rows: completions } = await pool.query(`
      SELECT habit_id, completion_date, completed_value, target_value,
             completion_percentage, status
      FROM habit_completions
      WHERE user_id = $1 AND completion_date BETWEEN $2::date AND $3::date
    `, [dbUserId, start, end])

    res.json({
      start, end,
      calendar: expandCalendar(habits, completions, start, end),
    })
  } catch (err) { next(err) }
})

// POST /api/client-habits/me/completions
// body: { habit_id, completion_date, completed_value }
// Inserts/updates a completion row; computes percentage + status server-side.
router.post('/me/completions', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { habit_id, completion_date, completed_value } = req.body
    if (!habit_id || !completion_date) {
      return res.status(400).json({ error: 'habit_id and completion_date are required' })
    }

    // Verify habit belongs to this user
    const { rows: hRows } = await pool.query(
      'SELECT * FROM coach_assigned_habits WHERE id = $1 AND user_id = $2',
      [habit_id, dbUserId],
    )
    if (!hRows.length) return res.status(404).json({ error: 'Habit not found' })
    const habit = hRows[0]

    // Compute percentage + status
    let percentage = 0
    const val = completed_value == null ? 0 : Number(completed_value)
    if (habit.habit_type === 'numeric' && habit.target_value && Number(habit.target_value) > 0) {
      percentage = Math.min(100, Math.round((val / Number(habit.target_value)) * 1000) / 10)
    } else {
      // boolean / completion — anything > 0 counts as 100%
      percentage = val > 0 ? 100 : 0
    }

    let status = 'not_started'
    if (percentage >= 80)      status = 'complete'
    else if (percentage >= 50) status = 'partial'

    const { rows } = await pool.query(`
      INSERT INTO habit_completions
        (user_id, habit_id, completion_date, completed_value, target_value, completion_percentage, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (habit_id, completion_date) DO UPDATE SET
        completed_value       = EXCLUDED.completed_value,
        target_value          = EXCLUDED.target_value,
        completion_percentage = EXCLUDED.completion_percentage,
        status                = EXCLUDED.status,
        updated_at            = NOW()
      RETURNING *
    `, [
      dbUserId, habit_id, completion_date,
      val, habit.target_value, percentage, status,
    ])

    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/client-habits/me/completions/:habitId/:date — clear a completion
router.delete('/me/completions/:habitId/:date', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const habitId = parseInt(req.params.habitId, 10)
    const date = req.params.date

    await pool.query(
      `DELETE FROM habit_completions
       WHERE user_id = $1 AND habit_id = $2 AND completion_date = $3::date`,
      [dbUserId, habitId, date],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router
