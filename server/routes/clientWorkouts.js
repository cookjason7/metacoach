import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// Helper: convert a pg DATE value (a JS Date in the server's local TZ) or a string
// into a YYYY-MM-DD string. Uses local components so the day is never shifted by a
// timezone offset. Same approach as clientHabits.js.
function toISODate(v) {
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Expand coach_assigned_workouts rows into per-day instances for [start, end].
// Respects frequency ('daily' | 'weekly' | 'specific_days'), start/end dates, and
// days_of_week (CSV of 0-6, Sun=0). Mirrors the habit expandCalendar logic.
// exByKey maps `${workout_id}|${day_label}` → the ordered workout_exercises rows,
// so each expanded instance carries the exercises the client logs against.
function expandCalendar(schedules, logs, exByKey, startDate, endDate) {
  const logMap = {}  // { assignment_id: { date: log } }
  for (const l of logs) {
    const dateKey = toISODate(l.scheduled_date)
    if (!logMap[l.assignment_id]) logMap[l.assignment_id] = {}
    logMap[l.assignment_id][dateKey] = l
  }

  const calendar = {}
  const winStart = new Date(`${startDate}T00:00:00`)
  const winEnd   = new Date(`${endDate}T00:00:00`)
  for (const s of schedules) {
    const sStartISO = toISODate(s.start_date)
    const sEndISO   = toISODate(s.end_date)
    const sStart = new Date(`${sStartISO}T00:00:00`)
    const sEnd   = sEndISO ? new Date(`${sEndISO}T00:00:00`) : winEnd
    const allowed = s.days_of_week
      ? s.days_of_week.split(',').map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n))
      : null

    const iterStart = new Date(Math.max(winStart.getTime(), sStart.getTime()))
    const iterEnd   = new Date(Math.min(winEnd.getTime(), sEnd.getTime()))
    for (let d = new Date(iterStart); d <= iterEnd; d.setDate(d.getDate() + 1)) {
      if (s.frequency === 'specific_days' && allowed && !allowed.includes(d.getDay())) continue
      if (s.frequency === 'weekly' && d.getDay() !== sStart.getDay()) continue
      const key = toISODate(d)
      if (!calendar[key]) calendar[key] = []
      calendar[key].push({
        assignment: { ...s, start_date: sStartISO, end_date: sEndISO },
        exercises: exByKey[`${s.workout_id}|${s.day_label}`] ?? [],
        log: logMap[s.id]?.[key] ?? null,
      })
    }
  }
  return calendar
}

// GET /api/client-workouts/me/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns the calling client's scheduled workouts expanded for the window, each
// instance carrying its day's exercises (with target sets/reps/weight) and the
// existing log if one has been recorded.
router.get('/me/calendar', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const start = req.query.start ?? new Date().toISOString().slice(0, 10)
    const end   = req.query.end   ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)

    const { rows: schedules } = await pool.query(`
      SELECT s.*, w.name AS workout_name
      FROM coach_assigned_workouts s
      JOIN workouts w ON w.id = s.workout_id
      WHERE s.user_id = $1 AND s.active = TRUE
        AND s.start_date <= $3::date
        AND (s.end_date IS NULL OR s.end_date >= $2::date)
    `, [dbUserId, start, end])

    const { rows: logs } = await pool.query(`
      SELECT id, assignment_id, scheduled_date, notes, completed_at
      FROM workout_logs
      WHERE user_id = $1 AND assignment_id IS NOT NULL
        AND scheduled_date BETWEEN $2::date AND $3::date
    `, [dbUserId, start, end])

    // Fetch the exercises for every (workout_id, day_label) referenced by a schedule,
    // then index by `${workout_id}|${day_label}` so expandCalendar can attach them.
    const exByKey = {}
    const workoutIds = [...new Set(schedules.map(s => s.workout_id))]
    if (workoutIds.length) {
      const { rows: exRows } = await pool.query(`
        SELECT we.*,
               COALESCE(
                 (SELECT image_url FROM exercises WHERE id = we.exercise_id),
                 (SELECT image_url FROM exercises
                    WHERE lower(trim(name)) = lower(trim(we.exercise_name))
                      AND image_url IS NOT NULL
                    ORDER BY id LIMIT 1)
               ) AS image_url
        FROM workout_exercises we
        WHERE we.workout_id = ANY($1::int[])
        ORDER BY we.sort_order, we.id
      `, [workoutIds])
      for (const ex of exRows) {
        const k = `${ex.workout_id}|${ex.day}`
        if (!exByKey[k]) exByKey[k] = []
        exByKey[k].push(ex)
      }
    }

    res.json({
      start, end,
      calendar: expandCalendar(schedules, logs, exByKey, start, end),
    })
  } catch (err) { next(err) }
})

// POST /api/client-workouts/me/logs
// body: { assignment_id, scheduled_date, notes, sets: [{ workout_exercise_id, set_number, actual_reps, actual_weight }] }
// Upserts the workout_logs row for the (assignment, date) slot and replaces its
// child workout_set_logs with the provided sets. `sets` is optional.
router.post('/me/logs', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { assignment_id, scheduled_date, notes, sets } = req.body
    if (!assignment_id || !scheduled_date) {
      return res.status(400).json({ error: 'assignment_id and scheduled_date are required' })
    }
    if (!DATE_RE.test(scheduled_date)) {
      return res.status(400).json({ error: 'scheduled_date must be YYYY-MM-DD' })
    }
    if (sets != null && !Array.isArray(sets)) {
      return res.status(400).json({ error: 'sets must be an array' })
    }

    // Verify the assignment belongs to this client; derive its workout_id
    const { rows: aRows } = await pool.query(
      'SELECT id, workout_id FROM coach_assigned_workouts WHERE id = $1 AND user_id = $2',
      [assignment_id, dbUserId],
    )
    if (!aRows.length) return res.status(404).json({ error: 'Schedule not found' })
    const workoutId = aRows[0].workout_id

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: [log] } = await client.query(`
        INSERT INTO workout_logs (user_id, workout_id, assignment_id, scheduled_date, notes, org_id)
        VALUES ($1, $2, $3, $4::date, $5, $6)
        ON CONFLICT (assignment_id, scheduled_date) DO UPDATE SET
          notes        = EXCLUDED.notes,
          completed_at = NOW()
        RETURNING *
      `, [dbUserId, workoutId, assignment_id, scheduled_date, notes ?? null, req.orgId])

      // Replace the child set logs so re-submitting a day is idempotent
      await client.query('DELETE FROM workout_set_logs WHERE workout_log_id = $1', [log.id])
      const savedSets = []
      for (const s of (sets ?? [])) {
        const { rows: [row] } = await client.query(`
          INSERT INTO workout_set_logs
            (workout_log_id, workout_exercise_id, set_number, actual_reps, actual_weight)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [
          log.id,
          s.workout_exercise_id ?? null,
          s.set_number ?? null,
          s.actual_reps ?? null,
          s.actual_weight ?? null,
        ])
        savedSets.push(row)
      }

      await client.query('COMMIT')
      res.status(201).json({ log, sets: savedSets })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) { next(err) }
})

// GET /api/client-workouts/me/logs/:assignmentId/:date — fetch an existing log +
// its set logs for prefill when the client reopens a day they already logged.
router.get('/me/logs/:assignmentId/:date', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const assignmentId = parseInt(req.params.assignmentId, 10)
    const date = req.params.date
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
    }

    const { rows: [log] } = await pool.query(`
      SELECT * FROM workout_logs
      WHERE user_id = $1 AND assignment_id = $2 AND scheduled_date = $3::date
    `, [dbUserId, assignmentId, date])

    if (!log) return res.json({ log: null, sets: [] })

    const { rows: sets } = await pool.query(`
      SELECT * FROM workout_set_logs WHERE workout_log_id = $1 ORDER BY id
    `, [log.id])

    res.json({ log, sets })
  } catch (err) { next(err) }
})

export default router
