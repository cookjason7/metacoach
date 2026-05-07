import { Router } from 'express'
import multer from 'multer'
import Anthropic from '@anthropic-ai/sdk'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
})

const anthropic = new Anthropic()

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'metacoach/meals' },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

const WARRIOR_FOODS = `Aligned Warrior Foods: lean proteins (chicken breast, turkey, fish, tuna, salmon, eggs, Greek yogurt, cottage cheese, whey protein), vegetables (broccoli, spinach, green beans, zucchini, sweet potato, asparagus, cauliflower), fruits (berries, apples, bananas), whole grains (oatmeal, brown rice, quinoa), healthy fats (avocado, almonds, walnuts, olive oil).
Off-list foods: fast food, fried foods, alcohol, candy, chips, soda, white bread, pastries, processed meats, ice cream.`

function buildAnalysisPrompt(phase, description) {
  const descLine = description?.trim()
    ? `User description: "${description.trim()}". Use this to improve identification accuracy and portion estimates.`
    : ''

  const phaseGuide = phase === 1
    ? 'Phase 1: for katie_feedback, write one calm sentence acknowledging the meal was logged. No food quality comments.'
    : `Phase ${phase}: for katie_feedback, write one calm sentence noting whether the main foods are aligned with or off the Warrior Food List:\n${WARRIOR_FOODS}`

  return `Analyze this meal photo. ${descLine}
Return ONLY a valid JSON object with these exact fields:
{
  "meal_name": "string",
  "ingredients": [{"item": "string", "portion": "string", "weight_g": number}],
  "calories": number,
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "saturated_fat_g": number,
  "fiber_g": number,
  "sugar_g": number,
  "sodium_mg": number,
  "katie_feedback": "string"
}

Estimate all macros from what is visible and the user description if provided.
katie_feedback: exactly 1 sentence, calm and direct, no exclamation points, no emojis, no em dashes, no filler. State one factual observation about the meal. No signature.
${phaseGuide}
Return only valid JSON, no markdown fences, no other text.`
}

// POST /api/meals/analyze
router.post('/analyze', requireAuth(), upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo provided' })

    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows: userRows } = await pool.query(
      'SELECT program_phase FROM users WHERE id = $1', [dbUserId],
    )
    const phase       = userRows[0]?.program_phase ?? 1
    const description = req.body.description ?? ''

    const base64    = req.file.buffer.toString('base64')
    const mediaType = req.file.mimetype

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: buildAnalysisPrompt(phase, description) },
          ],
        },
      ],
    })

    let text = message.content[0].text.trim()
    const fence = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/)
    if (fence) text = fence[1]

    res.json(JSON.parse(text))
  } catch (err) {
    next(err)
  }
})

// POST /api/meals/manual — manual entry, no photo
router.post('/manual', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { meal_name, calories, protein_g, carbs_g, fat_g, fiber_g, meal_slot } = req.body

    if (!meal_name?.trim()) return res.status(400).json({ error: 'Meal name required' })

    const { rows } = await pool.query(
      `INSERT INTO meals (user_id, meal_name, calories, protein, carbs, fat, fiber, meal_slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [dbUserId, meal_name.trim(), calories ?? null, protein_g ?? null,
       carbs_g ?? null, fat_g ?? null, fiber_g ?? null, meal_slot ?? null],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/meals/text-log — parse natural-language food description and save
router.post('/text-log', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { text, meal_slot } = req.body

    if (!text?.trim()) return res.status(400).json({ error: 'Text required' })

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Parse this food description and estimate macros per the amounts described. Return ONLY valid JSON:
{
  "meal_name": "string (concise name for what was described)",
  "calories": number,
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "fiber_g": number,
  "sugar_g": number
}
Food: "${text.trim()}"
Return only valid JSON, no markdown.`,
      }],
    })

    let txt = message.content[0].text.trim()
    const fence = txt.match(/```(?:json)?\n?([\s\S]+?)\n?```/)
    if (fence) txt = fence[1]

    let parsed
    try { parsed = JSON.parse(txt) } catch {
      return res.status(422).json({ error: 'Could not parse that food description. Try being more specific.' })
    }

    const { rows } = await pool.query(
      `INSERT INTO meals (user_id, meal_name, calories, protein, carbs, fat, fiber, sugar, meal_slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [dbUserId, parsed.meal_name, parsed.calories ?? null, parsed.protein_g ?? null,
       parsed.carbs_g ?? null, parsed.fat_g ?? null, parsed.fiber_g ?? null,
       parsed.sugar_g ?? null, meal_slot ?? null],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/meals/copy-day — copy all meals from one date to another
router.post('/copy-day', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { from_date, to_date } = req.body

    if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required' })

    const { rows: srcMeals } = await pool.query(
      `SELECT meal_name, photo_url, calories, protein, carbs, fat, fiber, portion_notes, meal_slot
       FROM meals
       WHERE user_id = $1
         AND logged_at >= $2::date
         AND logged_at <  $2::date + INTERVAL '1 day'
       ORDER BY logged_at`,
      [dbUserId, from_date],
    )

    if (!srcMeals.length) return res.status(404).json({ error: 'No meals found for that date' })

    const inserted = []
    for (const m of srcMeals) {
      const { rows } = await pool.query(
        `INSERT INTO meals (user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, portion_notes, meal_slot, logged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date + TIME '12:00:00')
         RETURNING *`,
        [dbUserId, m.meal_name, m.photo_url, m.calories, m.protein, m.carbs, m.fat,
         m.fiber, m.portion_notes, m.meal_slot, to_date],
      )
      inserted.push(rows[0])
    }

    res.status(201).json({ copied: inserted.length, meals: inserted })
  } catch (err) {
    next(err)
  }
})

// POST /api/meals/:id/copy — re-log a past meal, optionally on a specific date and slot
router.post('/:id/copy', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const mealId   = parseInt(req.params.id, 10)
    const { date, slot } = req.body

    const { rows: src } = await pool.query(
      `SELECT meal_name, calories, protein, carbs, fat, fiber, photo_url, portion_notes, meal_slot
       FROM meals WHERE id = $1 AND user_id = $2`,
      [mealId, dbUserId],
    )
    if (!src.length) return res.status(404).json({ error: 'Meal not found' })

    const m = src[0]
    const { rows } = await pool.query(
      `INSERT INTO meals (user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, portion_notes, meal_slot, logged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               COALESCE($11::date + TIME '12:00:00', NOW()))
       RETURNING *`,
      [dbUserId, m.meal_name, m.photo_url, m.calories, m.protein, m.carbs, m.fat, m.fiber,
       m.portion_notes, slot ?? m.meal_slot, date ?? null],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/meals — save photo meal
router.post('/', requireAuth(), upload.single('photo'), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { meal_name, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, meal_slot } = req.body
    const dbUserId = await getOrCreateUser(userId)

    let photo_url = null
    if (req.file) {
      try {
        const result = await uploadToCloudinary(req.file.buffer)
        photo_url = result.secure_url
      } catch (uploadErr) {
        console.warn('[meals] Cloudinary upload failed, saving without photo:', uploadErr.message)
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO meals (user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, sugar, meal_slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [dbUserId, meal_name, photo_url, calories, protein_g, carbs_g, fat_g,
       fiber_g ?? null, sugar_g ?? null, meal_slot ?? null],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// GET /api/meals/active-dates?start=YYYY-MM-DD&end=YYYY-MM-DD — dates that have meals
router.get('/active-dates', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { start, end } = req.query
    if (!start || !end) return res.json([])
    const { rows } = await pool.query(
      `SELECT DISTINCT DATE(m.logged_at) AS date
       FROM meals m JOIN users u ON u.id = m.user_id
       WHERE u.clerk_user_id = $1
         AND m.logged_at >= $2::date
         AND m.logged_at <  $3::date + INTERVAL '1 day'
       ORDER BY date`,
      [userId, start, end],
    )
    res.json(rows.map(r => {
      const d = new Date(r.date)
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const day = String(d.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }))
  } catch (err) {
    next(err)
  }
})

// GET /api/meals?date=YYYY-MM-DD — meals for a specific date (or all if no date)
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { date } = req.query

    const baseSelect = `
      SELECT m.id, m.meal_name, m.photo_url,
             m.calories, m.protein, m.carbs, m.fat, m.fiber, m.sugar,
             m.portion_notes, m.logged_at, m.meal_slot
      FROM meals m
      JOIN users u ON u.id = m.user_id
      WHERE u.clerk_user_id = $1`

    const { rows } = date
      ? await pool.query(
          `${baseSelect}
             AND m.logged_at >= $2::date
             AND m.logged_at <  $2::date + INTERVAL '1 day'
           ORDER BY m.logged_at ASC`,
          [userId, date],
        )
      : await pool.query(
          `${baseSelect} ORDER BY m.logged_at DESC`,
          [userId],
        )

    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// GET /api/meals/today — daily macro totals
router.get('/today', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(m.calories), 0)::int AS total_calories,
         COALESCE(SUM(m.protein),  0)::int AS total_protein,
         COALESCE(SUM(m.carbs),    0)::int AS total_carbs,
         COALESCE(SUM(m.fat),      0)::int AS total_fat,
         COALESCE(SUM(m.fiber),    0)::int AS total_fiber,
         COUNT(*)::int                     AS meal_count
       FROM meals m
       JOIN users u ON u.id = m.user_id
       WHERE u.clerk_user_id = $1
         AND m.logged_at >= CURRENT_DATE
         AND m.logged_at <  CURRENT_DATE + INTERVAL '1 day'`,
      [userId],
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/meals/:id — edit a meal
router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const mealId   = parseInt(req.params.id, 10)

    const { meal_name, calories, protein, carbs, fat, fiber, portion_notes, meal_slot } = req.body

    const { rows } = await pool.query(
      `UPDATE meals SET
         meal_name     = COALESCE($1, meal_name),
         calories      = COALESCE($2, calories),
         protein       = COALESCE($3, protein),
         carbs         = COALESCE($4, carbs),
         fat           = COALESCE($5, fat),
         fiber         = COALESCE($6, fiber),
         portion_notes = COALESCE($7, portion_notes),
         meal_slot     = COALESCE($8, meal_slot)
       WHERE id = $9 AND user_id = $10
       RETURNING *`,
      [
        meal_name ?? null, calories ?? null, protein ?? null,
        carbs ?? null, fat ?? null, fiber ?? null, portion_notes ?? null,
        meal_slot ?? null, mealId, dbUserId,
      ],
    )
    if (!rows.length) return res.status(404).json({ error: 'Meal not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/meals/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const mealId   = parseInt(req.params.id, 10)

    const { rowCount } = await pool.query(
      'DELETE FROM meals WHERE id = $1 AND user_id = $2',
      [mealId, dbUserId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Meal not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// GET /api/meals/week — this week's daily averages
router.get('/week', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    const { rows } = await pool.query(
      `SELECT
         ROUND(AVG(dc))::int              AS avg_calories,
         ROUND(AVG(dp))::int              AS avg_protein,
         ROUND(AVG(dcarbs))::int          AS avg_carbs,
         ROUND(AVG(dfat))::int            AS avg_fat,
         ROUND(AVG(dfiber))::int          AS avg_fiber,
         COALESCE(SUM(dm), 0)::int        AS meals_this_week
       FROM (
         SELECT
           SUM(m.calories)                AS dc,
           SUM(m.protein)                 AS dp,
           SUM(m.carbs)                   AS dcarbs,
           SUM(m.fat)                     AS dfat,
           COALESCE(SUM(m.fiber), 0)      AS dfiber,
           COUNT(*)                        AS dm
         FROM meals m
         JOIN users u ON u.id = m.user_id
         WHERE u.clerk_user_id = $1
           AND m.logged_at >= DATE_TRUNC('week', CURRENT_DATE)
         GROUP BY DATE(m.logged_at)
       ) t`,
      [userId],
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

export default router
