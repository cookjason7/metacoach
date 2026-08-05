import { Router } from 'express'
import { requireAuth } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail, getOrgCoachName } from '../db.js'
import { awardAction } from '../gamification.js'
import { workoutGenLimit } from '../middleware/rateLimits.js'
import { generateWorkoutPlan } from '../services/workoutGenerator.js'
import { getWorkoutDayNotes } from '../services/workoutDayNotes.js'
import { insertWorkoutExercise } from '../services/workoutExerciseInsert.js'

const router = Router()

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping. Same pattern as coachAdmin.js / messages.js (commits bf7addf, dbc3f60).
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

// Org-scoping note: reads below are already scoped by user_id = dbUserId (or, for
// nested exercises/logs, by a workout_id already verified to belong to dbUserId) —
// left unfiltered. activity_logs (POST /log-activity) has no org_id column, so
// that INSERT is untouched. All other INSERTs into workouts/workout_exercises/
// workout_logs now set org_id = req.orgId. UPDATE/DELETE additionally get an
// explicit org_id filter (non-super-admin only), same as meals.js (eefd525).

// POST /api/workouts/generate — AI generates a plan, not saved yet
router.post('/generate', requireAuth(), workoutGenLimit, async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
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
      coachName: await getOrgCoachName(req.orgId),
      // TEMPORARY — see workout_circuit_diagnostics in db.js
      userId: dbUserId,
      orgId: req.orgId,
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
    const userId = req.effectiveClerkUserId
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
    const userId = req.effectiveClerkUserId
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
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)

    const { rows: [workout] } = await pool.query(
      "SELECT * FROM workouts WHERE id = $1 AND user_id = $2 AND status = 'assigned'",
      [workoutId, dbUserId],
    )
    if (!workout) return res.status(404).json({ error: 'Workout not found' })

    const { rows: exercises } = await pool.query(
      `SELECT we.*,
              COALESCE(
                (SELECT image_url FROM exercises WHERE id = we.exercise_id),
                (SELECT image_url FROM exercises
                   WHERE lower(trim(name)) = lower(trim(we.exercise_name))
                     AND image_url IS NOT NULL
                   ORDER BY id LIMIT 1)
              ) AS image_url
       FROM workout_exercises we
       WHERE we.workout_id = $1 ORDER BY we.sort_order, we.id`,
      [workoutId],
    )

    const { rows: logs } = await pool.query(
      'SELECT * FROM workout_logs WHERE workout_id = $1 AND user_id = $2 ORDER BY completed_at DESC LIMIT 10',
      [workoutId, dbUserId],
    )

    // Coach-authored per-day notes, keyed by day name. Bundled into this response
    // rather than given its own client route, matching how exercises/logs are already
    // returned together — the client view needs all three in one paint anyway.
    // Read-only for the client; only coaches write these (see coachAdmin.js).
    const day_notes = await getWorkoutDayNotes(workoutId)

    res.json({ ...workout, exercises, logs, day_notes })
  } catch (err) {
    next(err)
  }
})

// POST /api/workouts — save a generated plan
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const { program_name, description, days, requested_circuits } = req.body

    if (!program_name?.trim()) return res.status(400).json({ error: 'Program name required' })
    if (!Array.isArray(days) || !days.length) return res.status(400).json({ error: 'Days required' })

    // requested_circuits: round-trips verbatim from the /generate response (see
    // generateWorkoutPlan in workoutGenerator.js) through the client's plan-review
    // state back into this save request — undefined/null for anything that didn't
    // go through AI generation (e.g. a manually-built program).
    const { rows: [workout] } = await pool.query(
      `INSERT INTO workouts (user_id, name, description, org_id, requested_circuits)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [dbUserId, program_name.trim(), description ?? null, req.orgId, requested_circuits != null ? JSON.stringify(requested_circuits) : null],
    )

    for (const day of days) {
      for (const ex of (day.exercises || [])) {
        // group_type comes from the generator (workoutGenerator.js mergeResponse) as
        // one of exercise/superset/circuit, but this whole `plan` object round-trips
        // through the client between generate and save — normalize defensively rather
        // than trust it's still one of the three valid values by the time it comes back.
        const groupType = ['exercise', 'superset', 'circuit'].includes(ex.group_type) ? ex.group_type : 'exercise'
        await insertWorkoutExercise({
          workout_id: workout.id, day: day.day_name, exercise_name: ex.name,
          exercise_id: ex.exercise_id ?? null, day_focus: day.focus ?? null,
          sets: ex.sets ?? null, reps: ex.reps ?? null, rest_seconds: ex.rest_seconds ?? null,
          notes: ex.notes ?? null, org_id: req.orgId, section_name: ex.section_name ?? null,
          group_id: ex.group_id ?? null, group_type: groupType, group_label: ex.group_label ?? null,
        })
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
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)
    const { notes } = req.body

    const { rows: [log] } = await pool.query(
      'INSERT INTO workout_logs (user_id, workout_id, notes, org_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [dbUserId, workoutId, notes ?? null, req.orgId],
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
    const userId = req.effectiveClerkUserId
    const dbUserId  = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)
    // Verify ownership
    const { rows: [w] } = await pool.query('SELECT id FROM workouts WHERE id=$1 AND user_id=$2', [workoutId, dbUserId])
    if (!w) return res.status(404).json({ error: 'Workout not found' })
    const { day, exercise_name, sets, reps, weight, rest_seconds, notes, sort_order } = req.body
    if (!exercise_name?.trim()) return res.status(400).json({ error: 'exercise_name required' })
    const ex = await insertWorkoutExercise({
      workout_id: workoutId, day: day ?? 'Day 1', exercise_name: exercise_name.trim(),
      sets: sets ?? null, reps: reps ?? null, weight: weight ?? null,
      rest_seconds: rest_seconds ?? null, notes: notes ?? null, sort_order: sort_order ?? 0,
      org_id: req.orgId,
    })
    res.status(201).json(ex)
  } catch (err) { next(err) }
})

// PUT /api/workouts/exercises/:id — update an exercise (user must own the parent workout)
router.put('/exercises/:id', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
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
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $${values.length + 2}`
    const { rows: [updated] } = await pool.query(
      `UPDATE workout_exercises SET ${setClauses} WHERE id=$1${orgFilter} RETURNING *`,
      bypassOrg ? [exId, ...values] : [exId, ...values, ctx.orgId],
    )
    res.json(updated)
  } catch (err) { next(err) }
})

// DELETE /api/workouts/exercises/:id — remove an exercise (user must own the parent workout)
router.delete('/exercises/:id', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId  = await getOrCreateUser(userId)
    const exId      = parseInt(req.params.id, 10)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const orgFilter = isSuperAdmin(ctx) ? '' : ` AND we.org_id=$3`
    const { rowCount } = await pool.query(
      `DELETE FROM workout_exercises we USING workouts w
       WHERE we.workout_id=w.id AND we.id=$1 AND w.user_id=$2${orgFilter}`,
      isSuperAdmin(ctx) ? [exId, dbUserId] : [exId, dbUserId, ctx.orgId])
    if (!rowCount) return res.status(404).json({ error: 'Exercise not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// DELETE /api/workouts/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const workoutId = parseInt(req.params.id, 10)

    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const orgFilter = isSuperAdmin(ctx) ? '' : ` AND org_id = $3`

    const { rowCount } = await pool.query(
      `DELETE FROM workouts WHERE id = $1 AND user_id = $2${orgFilter}`,
      isSuperAdmin(ctx) ? [workoutId, dbUserId] : [workoutId, dbUserId, ctx.orgId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Workout not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
