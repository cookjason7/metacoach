import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { awardAction } from '../gamification.js'
import { workoutGenLimit } from '../middleware/rateLimits.js'

const router = Router()
const anthropic = new Anthropic()

function buildWorkoutPrompt(firstName, answers) {
  const goals = Array.isArray(answers.goals) ? answers.goals.join(', ') : answers.goals
  return `You are Katie, an enthusiastic and supportive fitness coach for the Life Warrior Coaching program.
Create a personalized weekly workout program for ${firstName} based on their profile:
- Fitness goals: ${goals}
- Training days per week: ${answers.days_per_week}
- Session length: ${answers.session_length}
- Available equipment: ${answers.equipment}
- Injuries or limitations: ${answers.injuries || 'None'}
- Fitness level: ${answers.fitness_level}

Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "program_name": "string (creative, motivating program name)",
  "description": "string (2-3 sentences, Katie-style intro to this program)",
  "days": [
    {
      "day_name": "string (e.g. 'Day 1 — Upper Body Push')",
      "focus": "string (e.g. 'Chest, Shoulders, Triceps')",
      "exercises": [
        {
          "name": "string",
          "sets": number,
          "reps": "string (e.g. '10-12' or '30 seconds')",
          "rest_seconds": number,
          "notes": "string (brief form tip or coaching cue, 1 sentence)"
        }
      ]
    }
  ]
}

Include exactly ${answers.days_per_week} training days.
Start each day with a short warm-up and end with a brief cool-down (these count as exercises with sets=1, reps like "5 minutes").
Use only exercises appropriate for the available equipment.
Make it realistic, progressive, and achievable for a ${answers.fitness_level} trainee.`
}

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

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildWorkoutPrompt(firstName, answers) }],
    })

    let text = message.content[0].text.trim()
    const fence = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/)
    if (fence) text = fence[1]

    res.json(JSON.parse(text))
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
       WHERE w.user_id = $1
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
      'SELECT * FROM workouts WHERE id = $1 AND user_id = $2',
      [workoutId, dbUserId],
    )
    if (!workout) return res.status(404).json({ error: 'Workout not found' })

    const { rows: exercises } = await pool.query(
      'SELECT * FROM workout_exercises WHERE workout_id = $1 ORDER BY id',
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
          `INSERT INTO workout_exercises (workout_id, day, exercise_name, sets, reps, rest_seconds, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [workout.id, day.day_name, ex.name, ex.sets ?? null, ex.reps ?? null,
           ex.rest_seconds ?? null, ex.notes ?? null],
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
