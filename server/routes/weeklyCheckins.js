import { Router } from 'express'
import { requireAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// Returns the Monday of the current week as YYYY-MM-DD (UTC)
function currentWeekStart() {
  const today = new Date()
  const day  = today.getUTCDay()           // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day   // days back to Monday
  const monday = new Date(today)
  monday.setUTCDate(today.getUTCDate() + diff)
  return monday.toISOString().slice(0, 10)
}

// GET /api/weekly-checkins/me — client fetches all their own check-ins
router.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const { rows } = await pool.query(
      'SELECT * FROM weekly_checkins WHERE user_id = $1 ORDER BY week_start DESC',
      [dbUserId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/weekly-checkins — upsert this week's check-in (client only)
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)

    const {
      week_start,
      current_weight,
      sleep_quality,
      energy,
      stress,
      cravings,
      workouts_completed,
      days_food_logged,
      days_hit_protein,
      biggest_win,
      biggest_struggle,
      coach_notes,
    } = req.body

    // Validate / default week_start
    const weekStart = week_start || currentWeekStart()

    const { rows } = await pool.query(`
      INSERT INTO weekly_checkins (
        user_id, week_start,
        current_weight, sleep_quality, energy, stress, cravings,
        workouts_completed, days_food_logged, days_hit_protein,
        biggest_win, biggest_struggle, coach_notes,
        submitted_at, updated_at
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13,
        NOW(), NOW()
      )
      ON CONFLICT (user_id, week_start) DO UPDATE SET
        current_weight     = COALESCE($3,  weekly_checkins.current_weight),
        sleep_quality      = COALESCE($4,  weekly_checkins.sleep_quality),
        energy             = COALESCE($5,  weekly_checkins.energy),
        stress             = COALESCE($6,  weekly_checkins.stress),
        cravings           = COALESCE($7,  weekly_checkins.cravings),
        workouts_completed = COALESCE($8,  weekly_checkins.workouts_completed),
        days_food_logged   = COALESCE($9,  weekly_checkins.days_food_logged),
        days_hit_protein   = COALESCE($10, weekly_checkins.days_hit_protein),
        biggest_win        = COALESCE($11, weekly_checkins.biggest_win),
        biggest_struggle   = COALESCE($12, weekly_checkins.biggest_struggle),
        coach_notes        = COALESCE($13, weekly_checkins.coach_notes),
        updated_at         = NOW()
      RETURNING *
    `, [
      dbUserId, weekStart,
      current_weight     != null ? Number(current_weight)     : null,
      sleep_quality      != null ? Number(sleep_quality)      : null,
      energy             != null ? Number(energy)             : null,
      stress             != null ? Number(stress)             : null,
      cravings           != null ? Number(cravings)           : null,
      workouts_completed != null ? Number(workouts_completed) : null,
      days_food_logged   != null ? Number(days_food_logged)   : null,
      days_hit_protein   != null ? Number(days_hit_protein)   : null,
      biggest_win      ?? null,
      biggest_struggle ?? null,
      coach_notes      ?? null,
    ])

    res.json(rows[0])
  } catch (err) { next(err) }
})

export default router
