import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { assembleSession, getDayLabelForSession } from '../services/workoutAssembly/assembleSession.js'

const router = Router()

const SESSION_LENGTHS = [20, 30, 45, 60, 90]
const GOALS = ['strength', 'power', 'hypertrophy', 'endurance']
const LEVELS = ['beginner', 'intermediate', 'advanced']

function getSessionOptions(query) {
  const sessionLength = query.sessionLength ? Number(query.sessionLength) : 60
  if (!SESSION_LENGTHS.includes(sessionLength)) {
    return { error: `sessionLength must be one of ${SESSION_LENGTHS.join(', ')}` }
  }

  const goal = query.goal ?? 'hypertrophy'
  if (!GOALS.includes(goal)) {
    return { error: `goal must be one of ${GOALS.join(', ')}` }
  }

  const level = query.level ?? 'advanced'
  if (!LEVELS.includes(level)) {
    return { error: `level must be one of ${LEVELS.join(', ')}` }
  }

  const equipment = query.equipment
    ? String(query.equipment).split(',').map(e => e.trim()).filter(Boolean)
    : ['bodyweight']

  const rotationIndex = query.rotationIndex !== undefined ? Number(query.rotationIndex) : 0
  if (!Number.isInteger(rotationIndex) || rotationIndex < 0) {
    return { error: 'rotationIndex must be a non-negative integer' }
  }

  let dayLabel = query.dayLabel
  if (dayLabel !== undefined) {
    if (dayLabel !== 'A' && dayLabel !== 'B') {
      return { error: 'dayLabel must be "A" or "B"' }
    }
  } else {
    dayLabel = getDayLabelForSession(rotationIndex)
  }

  return { options: { dayLabel, sessionLength, goal, level, equipment, rotationIndex } }
}

async function handleSessionRequest(req, res, next) {
  try {
    const { userId } = getAuth(req)
    await getOrCreateUser(userId)

    const parsed = getSessionOptions(req.query)
    if (parsed.error) return res.status(400).json({ error: parsed.error })

    const session = await assembleSession(pool, parsed.options)
    res.json(session)
  } catch (err) {
    next(err)
  }
}

// GET /api/workout-builder/session
// Admin QA route retained for the existing raw JSON test page. Pure rules-based
// assembly only; no Katie/AI involvement and nothing is persisted.
router.get('/session', requireAuth(), handleSessionRequest)

// GET /api/workout-builder/my-session
// Client-facing preview endpoint for authenticated test clients. This stays
// separate from the existing Katie-generated Workouts flow.
router.get('/my-session', requireAuth(), handleSessionRequest)

export default router
