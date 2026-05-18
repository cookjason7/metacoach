import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// GET /api/health-assessment/me
router.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows } = await pool.query(
      'SELECT * FROM health_assessments WHERE user_id = $1',
      [dbUserId],
    )
    res.json(rows[0] ?? null)
  } catch (err) {
    next(err)
  }
})

// POST /api/health-assessment — upsert (autosave each section + final completion)
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const {
      // Section 1
      first_name, last_name, email, phone,
      // Structured address (new) — keep legacy `address` field for backward compat
      street_address, city, state, zip_code, country,
      date_of_birth, shirt_size, coach_name,
      // Section 2
      supplements, goals_6_months, injuries_limitations, num_kids, occupation,
      // Section 3
      energy_level, sleep_hours, stress_management, sleep_quality, daily_water,
      alcohol_weekdays, alcohol_weekends, happiness_level, confidence_level, activity_level,
      // Section 4 — Life Warrior identity traits (JSONB array of exactly 2 strings)
      identity_traits,
      // Completion flag — set true only on final submit
      completed,
    } = req.body

    const { rows } = await pool.query(`
      INSERT INTO health_assessments (
        user_id,
        first_name, last_name, email, phone,
        street_address, city, state, zip_code, country,
        date_of_birth, shirt_size, coach_name,
        supplements, goals_6_months, injuries_limitations, num_kids, occupation,
        energy_level, sleep_hours, stress_management, sleep_quality, daily_water,
        alcohol_weekdays, alcohol_weekends, happiness_level, confidence_level, activity_level,
        identity_traits,
        completed_at, updated_at
      ) VALUES (
        $1,
        $2,  $3,  $4,  $5,
        $6,  $7,  $8,  $9,  $10,
        $11, $12, $13,
        $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28,
        $29,
        $30, NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        first_name           = COALESCE($2,  health_assessments.first_name),
        last_name            = COALESCE($3,  health_assessments.last_name),
        email                = COALESCE($4,  health_assessments.email),
        phone                = COALESCE($5,  health_assessments.phone),
        street_address       = COALESCE($6,  health_assessments.street_address),
        city                 = COALESCE($7,  health_assessments.city),
        state                = COALESCE($8,  health_assessments.state),
        zip_code             = COALESCE($9,  health_assessments.zip_code),
        country              = COALESCE($10, health_assessments.country),
        date_of_birth        = COALESCE($11, health_assessments.date_of_birth),
        shirt_size           = COALESCE($12, health_assessments.shirt_size),
        coach_name           = COALESCE($13, health_assessments.coach_name),
        supplements          = COALESCE($14, health_assessments.supplements),
        goals_6_months       = COALESCE($15, health_assessments.goals_6_months),
        injuries_limitations = COALESCE($16, health_assessments.injuries_limitations),
        num_kids             = COALESCE($17, health_assessments.num_kids),
        occupation           = COALESCE($18, health_assessments.occupation),
        energy_level         = COALESCE($19, health_assessments.energy_level),
        sleep_hours          = COALESCE($20, health_assessments.sleep_hours),
        stress_management    = COALESCE($21, health_assessments.stress_management),
        sleep_quality        = COALESCE($22, health_assessments.sleep_quality),
        daily_water          = COALESCE($23, health_assessments.daily_water),
        alcohol_weekdays     = COALESCE($24, health_assessments.alcohol_weekdays),
        alcohol_weekends     = COALESCE($25, health_assessments.alcohol_weekends),
        happiness_level      = COALESCE($26, health_assessments.happiness_level),
        confidence_level     = COALESCE($27, health_assessments.confidence_level),
        activity_level       = COALESCE($28, health_assessments.activity_level),
        identity_traits      = COALESCE($29::jsonb, health_assessments.identity_traits),
        completed_at         = CASE WHEN $30::TIMESTAMPTZ IS NOT NULL THEN $30::TIMESTAMPTZ
                                    ELSE health_assessments.completed_at END,
        updated_at           = NOW()
      RETURNING *
    `, [
      dbUserId,
      first_name     ?? null, last_name      ?? null, email    ?? null, phone ?? null,
      street_address ?? null, city           ?? null, state    ?? null,
      zip_code       ?? null, country        ?? null,
      date_of_birth  ?? null, shirt_size     ?? null, coach_name ?? null,
      supplements          ?? null, goals_6_months       ?? null,
      injuries_limitations ?? null,
      num_kids != null ? Number(num_kids) : null,
      occupation ?? null,
      energy_level      != null ? Number(energy_level)      : null,
      sleep_hours       ?? null,
      stress_management != null ? Number(stress_management) : null,
      sleep_quality     != null ? Number(sleep_quality)     : null,
      daily_water       ?? null,
      alcohol_weekdays  != null ? Number(alcohol_weekdays)  : null,
      alcohol_weekends  != null ? Number(alcohol_weekends)  : null,
      happiness_level   != null ? Number(happiness_level)   : null,
      confidence_level  != null ? Number(confidence_level)  : null,
      activity_level    ?? null,
      Array.isArray(identity_traits) ? JSON.stringify(identity_traits) : null,
      completed ? new Date().toISOString() : null,
    ])

    // On final submit: mark assessment complete and promote 'invited' → 'active'.
    // Only 'invited' users are promoted — archived/deleted stay untouched.
    if (completed) {
      await pool.query(
        `UPDATE users
         SET assessment_complete = TRUE,
             start_date = COALESCE(start_date, CURRENT_DATE),
             client_status = CASE
               WHEN client_status = 'invited' THEN 'active'
               ELSE client_status
             END
         WHERE id = $1`,
        [dbUserId],
      )
    }

    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})


export default router
