import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { awardAction } from '../gamification.js'
import { workoutGenLimit } from '../middleware/rateLimits.js'
import { generateWorkoutPlan } from '../services/workoutGenerator.js'

const router = Router()

// POST /api/workouts/generate — AI generates a plan, not saved yet
router.post('/generate', requireAuth(), workoutGenLimit, async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows } = await pool.query('SELECT first_name FROM users WHERE id = $1', [dbUserId])
    const firstName = rows[0]?.first_name || 'there'

    const answers = req.body
    if (!answers.goals || !answers.days_per_week || !answers.fitness_level) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { rows: [assessment] } = await pool.query(
      'SELECT injuries_limitations FROM health_assessments WHERE user_id = $1', [dbUserId],
    )

    const plan = await generateWorkoutPlan(pool, firstName, answers, {
      healthAssessmentInjuries: assessment?.injuries_limitations ?? null,
    })
    res.json(plan)
  } catch (err) {
    next(err)
  }
})

// POST /api/workouts/log-activity — quick activity log (no plan required)
// Optional body field log_date (YYYY-MM-DD, ≤ today) allows past-date logging.
router.post('/log-activity', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { activity_type, duration_minutes, notes, log_date } = req.body
    if (!activity_type?.trim()) return res.status(400).json({ error: 'activity_type required' })

    const todayStr   = new Date().toISOString().slice(0, 10)
    const targetDate = log_date && /^\d{4}-\d{2}-\d{2}$/.test(log_date) && log_date <= todayStr
      ? log_date : null

    await pool.query(
      targetDate
        ? `INSERT INTO activity_logs (user_id, activity_type, duration_minutes, notes, logged_at)
           VALUES ($1, $2, $3, $4, $5::date + CURRENT_TIME)`
        : `INSERT INTO activity_logs (user_id, activity_type, duration_minutes, notes)
           VALUES ($1, $2, $3, $4)`,
      targetDate
        ? [dbUserId, activity_type.trim(), duration_minutes ?? null, notes?.trim() ?? null, targetDate]
        : [dbUserId, activity_type.trim(), duration_minutes ?? null, notes?.trim() ?? null],
    )
    awardAction(pool, dbUserId, 'workout', targetDate ?? todayStr).catch(e => console.error('[gami activity]', e.message))
    res.status(201).json({ success: true })
  } catch (err) {
    next(err)
  }
})

// GET /api/workouts — list user's saved programs
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.description, w.created_at,
              (SELECT COUNT(*) FROM workout_exercises WHERE workout_id = w.id) AS exercise_count,
              (SELECT COUNT(DISTINCT day) FROM workout_exercises WHERE workout_id = w.id) AS day_count,
              (SELECT MAX(completed_at) FROM workout_logs WHERE workout_id = w.id AND user_id = $1) AS last_logged_at,
              (SELECT COUNT(*) FROM workout_logs WHERE workout_id = w.id AND user_id = $1) AS log_count
       FROM workouts w
       WHERE w.user_id = $1 AND w.status = 'assigned'
       ORDER BY w.created_at DESC`,
      [dbUserId],
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// GET /api/workouts/:id — get a single program with all exercises
router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)

    const { rows: [workout] } = await pool.query(
      "SELECT * FROM workouts WHERE id = $1 AND user_id = $2 AND status = 'assigned'",
      [workoutId, dbUserId],
    )
    if (!workout) return res.status(404).json({ error: 'Workout not found' })

    const { rows: exercises } = await pool.query(
      `SELECT we.*, e.image_url
       FROM workout_exercises we
       LEFT JOIN exercises e ON e.id = we.exercise_id
       WHERE we.workout_id = $1 ORDER BY we.id`,
      [workoutId],
    )

    const { rows: logs } = await pool.query(
      'SELECT * FROM workout_logs WHERE workout_id = $1 AND user_id = $2 ORDER BY completed_at DESC LIMIT 10',
      [workoutId, dbUserId],
    )

    res.json({ ...workout, exercises, logs })
  } catch (err) {
    next(err)
  }
})

// POST /api/workouts — save a generated plan
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { program_name, description, days } = req.body

    if (!program_name?.trim()) return res.status(400).json({ error: 'Program name required' })
    if (!Array.isArray(days) || !days.length) return res.status(400).json({ error: 'Days required' })

    const { rows: [workout] } = await pool.query(
      'INSERT INTO workouts (user_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [dbUserId, program_name.trim(), description ?? null],
    )

    for (const day of days) {
      for (const ex of (day.exercises || [])) {
        await pool.query(
          `INSERT INTO workout_exercises (workout_id, day, exercise_name, exercise_id, day_focus, sets, reps, rest_seconds, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [workout.id, day.day_name, ex.name, ex.exercise_id ?? null, day.focus ?? null,
           ex.sets ?? null, ex.reps ?? null, ex.rest_seconds ?? null, ex.notes ?? null],
        )
      }
    }

    res.status(201).json(workout)
  } catch (err) {
    next(err)
  }
})

// POST /api/workouts/:id/log — record a completed workout
router.post('/:id/log', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)
    const { notes } = req.body

    const { rows: [log] } = await pool.query(
      'INSERT INTO workout_logs (user_id, workout_id, notes) VALUES ($1, $2, $3) RETURNING *',
      [dbUserId, workoutId, notes ?? null],
    )
    const today = new Date().toISOString().slice(0, 10)
    awardAction(pool, dbUserId, 'workout', today).catch(e => console.error('[gami workout]', e.message))
    res.status(201).json(log)
  } catch (err) {
    next(err)
  }
})

// POST /api/workouts/:id/exercises — add an exercise to a workout the user owns
router.post('/:id/exercises', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId  = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)
    // Verify ownership
    const { rows: [w] } = await pool.query('SELECT id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, dbUserId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })
    const { day, exercise_name, sets, reps, weight, rest_seconds, notes, sort_order } = req.body
    if (!exercise_name?.trim()) return res.status(400).json({ error: 'exercise_name required' })
    const { rows: [ex] } = await pool.query(
      `INSERT INTO workout_exercises (workout_id, day, exercise_name, sets, reps, weight, rest_seconds, notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [workoutId, day ?? 'Day 1', exercise_name.trim(), sets ?? null, reps ?? null,
       weight ?? null, rest_seconds ?? null, notes ?? null, sort_order ?? 0],
    )
    res.status(201).json(ex)
  } catch (err) { next(err) }
})

// PUT /api/workouts/exercises/:id — update an exercise (user must own the parent workout)
router.put('/exercises/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId  = await getOrCreateUser(userId)
    const exId      = parseInt(req.params.id, 10)
    // Verify ownership through the workout
    const { rows: [ex] } = await pool.query(
      `SELECT we.* FROM workout_exercises we
       JOIN workouts w ON w.id = we.workout_id
       WHERE we.id=$1 AND w.user_id=$2`, [exId, dbUserId])
    if (!ex) return res.status(404).json({ error: 'Exercise not found' })
    const allowed = ['exercise_name', 'sets', 'reps', 'weight', 'rest_seconds', 'notes', 'day', 'sort_order']
    const sets_entries = Object.entries(req.body).filter(([k]) => allowed.includes(k))
    if (!sets_entries.length) return res.status(400).json({ error: 'No valid fields to update' })
    const setClauses = sets_entries.map(([k], i) => `${k}=$${i + 2}`).join(', ')
    const values     = sets_entries.map(([, v]) => v)
    const { rows: [updated] } = await pool.query(
      `UPDATE workout_exercises SET ${setClauses} WHERE id=$1 RETURNING *`,
      [exId, ...values],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// DELETE /api/workouts/exercises/:id — remove an exercise (user must own the parent workout)
router.delete('/exercises/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId  = await getOrCreateUser(userId)
    const exId      = parseInt(req.params.id, 10)
    const { rowCount } = await pool.query(
      `DELETE FROM workout_exercises we USING workouts w
       WHERE we.workout_id=w.id AND we.id=$1 AND w.user_id=$2`, [exId, dbUserId])
    if (!rowCount) return res.status(404).json({ error: 'Exercise not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// DELETE /api/workouts/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)

    const { rowCount } = await pool.query(
      'DELETE FROM workouts WHERE id = $1 AND user_id = $2',
      [workoutId, dbUserId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Workout not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
