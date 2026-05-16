import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// GET /api/measurements — client fetches their own measurements
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)
    const { rows } = await pool.query(
      `SELECT id, measurement_date, chest, waist, hips, created_at
       FROM client_measurements
       WHERE user_id = $1
       ORDER BY measurement_date DESC, created_at DESC`,
      [dbUserId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/measurements — client adds their own measurement
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)
    const { measurement_date, chest, waist, hips } = req.body
    const date = measurement_date || new Date().toISOString().slice(0, 10)
    const { rows } = await pool.query(
      `INSERT INTO client_measurements (user_id, measurement_date, chest, waist, hips)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, measurement_date, chest, waist, hips, created_at`,
      [dbUserId, date, chest ?? null, waist ?? null, hips ?? null],
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

export default router
