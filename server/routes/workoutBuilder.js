import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { assembleSession, getDayLabelForSession } from '../services/workoutAssembly/assembleSession.js'

const router = Router()

const SESSION_LENGTHS = [20, 30, 45, 60, 90]
const GOALS = ['strength', 'power', 'hypertrophy', 'endurance']
const LEVELS = ['beginner', 'intermediate', 'advanced']

// GET /api/workout-builder/session — assembles one A/B day's session purely
// from exercise_library / program_day_patterns / volume_rules /
// program_templates (see services/workoutAssembly). No Katie/AI involvement
// and nothing is persisted — read-only compute-and-return, additive
// alongside the existing Katie-generated flow in routes/workouts.js (not a
// replacement for it).
//
// Query params (all optional):
//   sessionLength  20|30|45|60|90                default 60
//   goal           strength|power|hypertrophy|endurance   default hypertrophy
//   level          beginner|intermediate|advanced default advanced
//   equipment      comma-separated list, e.g. "bodyweight,dumbbell,mini_band"
//                  default "bodyweight"
//   dayLabel       A|B — if omitted, derived from rotationIndex
//   rotationIndex  non-negative integer, cycles both dayLabel (if not given
//                  explicitly) and which exercise a pattern's pool lands on
//                  default 0
router.get('/session', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    await getOrCreateUser(userId) // confirms caller is a known app user

    const sessionLength = req.query.sessionLength ? Number(req.query.sessionLength) : 60
    if (!SESSION_LENGTHS.includes(sessionLength)) {
      return res.status(400).json({ error: `sessionLength must be one of ${SESSION_LENGTHS.join(', ')}` })
    }

    const goal = req.query.goal ?? 'hypertrophy'
    if (!GOALS.includes(goal)) {
      return res.status(400).json({ error: `goal must be one of ${GOALS.join(', ')}` })
    }

    const level = req.query.level ?? 'advanced'
    if (!LEVELS.includes(level)) {
      return res.status(400).json({ error: `level must be one of ${LEVELS.join(', ')}` })
    }

    const equipment = req.query.equipment
      ? String(req.query.equipment).split(',').map(e => e.trim()).filter(Boolean)
      : ['bodyweight']

    const rotationIndex = req.query.rotationIndex !== undefined ? Number(req.query.rotationIndex) : 0
    if (!Number.isInteger(rotationIndex) || rotationIndex < 0) {
      return res.status(400).json({ error: 'rotationIndex must be a non-negative integer' })
    }

    let dayLabel = req.query.dayLabel
    if (dayLabel !== undefined) {
      if (dayLabel !== 'A' && dayLabel !== 'B') {
        return res.status(400).json({ error: 'dayLabel must be "A" or "B"' })
      }
    } else {
      dayLabel = getDayLabelForSession(rotationIndex)
    }

    const session = await assembleSession(pool, { dayLabel, sessionLength, goal, level, equipment, rotationIndex })
    res.json(session)
  } catch (err) {
    next(err)
  }
})

export default router
