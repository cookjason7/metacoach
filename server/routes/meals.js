import { Router } from 'express'
import multer from 'multer'
import Anthropic from '@anthropic-ai/sdk'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { awardAction, checkFullDay, checkProteinGoal } from '../gamification.js'
import { normalizeMealPayload } from '../mealValidation.js'
import { mealAnalyzeLimit, mealTextLimit } from '../middleware/rateLimits.js'

// Fire gamification hooks non-blocking so they never fail the main request
function fireGamification(pool, dbUserId, dateStr) {
  const d = dateStr ?? new Date().toISOString().slice(0, 10)
  awardAction(pool, dbUserId, 'food_log', d).catch(e => console.error('[gami food_log]', e.message))
  checkFullDay(pool, dbUserId, d).catch(e => console.error('[gami full_day]', e.message))
  checkProteinGoal(pool, dbUserId, d).catch(e => console.error('[gami protein]', e.message))
}

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

function parseMicronutrients(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function mealMetaFromBody(body) {
  return {
    serving_size: body.serving_size !== undefined && body.serving_size !== '' ? Number(body.serving_size) : null,
    serving_unit: body.serving_unit ?? null,
    source_type: body.source_type ?? body._source ?? null,
    source_label: body.source_label ?? null,
    is_verified: body.is_verified === true || body.is_verified === 'true',
    micronutrients: parseMicronutrients(body.micronutrients),
  }
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
router.post('/analyze', requireAuth(), mealAnalyzeLimit, upload.single('photo'), async (req, res, next) => {
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
    const v = normalizeMealPayload(req.body)
    if (!v.ok) return res.status(400).json({ error: v.error })
    const d = v.data

    const { rows } = await pool.query(
      `INSERT INTO meals (
         user_id, meal_name, calories, protein, carbs, fat, fiber, meal_slot, log_date,
         serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [dbUserId, d.meal_name, d.calories, d.protein, d.carbs, d.fat, d.fiber,
       d.meal_slot, d.log_date,
       d.serving_size ?? null, d.serving_unit ?? null,
       d.source_type ?? null, d.source_label ?? null,
       d.is_verified ?? false, d.micronutrients ?? null],
    )
    fireGamification(pool, dbUserId, d.log_date)
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/meals/text-log — parse natural-language food description and save
router.post('/text-log', requireAuth(), mealTextLimit, async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { text, meal_slot, log_date } = req.body

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

    const v = normalizeMealPayload({ ...parsed, meal_slot, log_date })
    if (!v.ok) return res.status(400).json({ error: v.error })
    const d = v.data

    const { rows } = await pool.query(
      `INSERT INTO meals (user_id, meal_name, calories, protein, carbs, fat, fiber, sugar, meal_slot, log_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [dbUserId, d.meal_name, d.calories, d.protein, d.carbs, d.fat, d.fiber,
       d.sugar, d.meal_slot, d.log_date],
    )
    fireGamification(pool, dbUserId, d.log_date)
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/meals/copy-day — copy all meals from one date to another
// mode: 'add' (append) | 'replace' (delete target then insert) | absent (409 if target has meals)
router.post('/copy-day', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { from_date, to_date, mode } = req.body

    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    if (!from_date || !to_date || !dateRe.test(from_date) || !dateRe.test(to_date))
      return res.status(400).json({ error: 'from_date and to_date must be YYYY-MM-DD' })
    if (from_date === to_date)
      return res.status(400).json({ error: 'Source and target date cannot be the same' })

    // Fetch source meals
    const { rows: srcMeals } = await pool.query(
      `SELECT meal_name, photo_url, calories, protein, carbs, fat, fiber, sugar, portion_notes, meal_slot,
              serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
       FROM meals
       WHERE user_id = $1
         AND COALESCE(log_date, logged_at::date) = $2::date
       ORDER BY logged_at`,
      [dbUserId, from_date],
    )
    if (!srcMeals.length) return res.status(404).json({ error: 'No meals found for source date' })

    // Check target
    const { rows: tgtCheck } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM meals
       WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) = $2::date`,
      [dbUserId, to_date],
    )
    const targetCount = tgtCheck[0].count
    if (targetCount > 0 && !mode)
      return res.status(409).json({ target_has_logs: true, target_count: targetCount })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (mode === 'replace' && targetCount > 0) {
        await client.query(
          `DELETE FROM meals WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) = $2::date`,
          [dbUserId, to_date],
        )
      }
      const inserted = []
      for (const m of srcMeals) {
        const { rows } = await client.query(
          `INSERT INTO meals (
             user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, sugar, portion_notes,
             meal_slot, log_date, serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15,$16,$17,$18)
           RETURNING *`,
          [dbUserId, m.meal_name, m.photo_url, m.calories, m.protein, m.carbs, m.fat,
           m.fiber, m.sugar, m.portion_notes, m.meal_slot, to_date,
           m.serving_size, m.serving_unit, m.source_type, m.source_label, m.is_verified, m.micronutrients],
        )
        inserted.push(rows[0])
      }
      await client.query('COMMIT')
      res.status(201).json({ copied: inserted.length, meals: inserted })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) { next(err) }
})

// POST /api/meals/copy-meal — copy one meal slot from one date to another
// mode: 'add' | 'replace' | absent (409 if target slot has meals)
router.post('/copy-meal', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { from_date, from_slot, to_date, to_slot, mode } = req.body

    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    if (!from_date || !to_date || !dateRe.test(from_date) || !dateRe.test(to_date))
      return res.status(400).json({ error: 'from_date and to_date must be YYYY-MM-DD' })
    if (!from_slot || !to_slot)
      return res.status(400).json({ error: 'from_slot and to_slot are required' })
    if (from_date === to_date && from_slot === to_slot)
      return res.status(400).json({ error: 'Source and target slot cannot be the same' })

    const { rows: srcMeals } = await pool.query(
      `SELECT meal_name, photo_url, calories, protein, carbs, fat, fiber, sugar, portion_notes,
              serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
       FROM meals
       WHERE user_id = $1
         AND COALESCE(log_date, logged_at::date) = $2::date
         AND meal_slot = $3
       ORDER BY logged_at`,
      [dbUserId, from_date, from_slot],
    )
    if (!srcMeals.length) return res.status(404).json({ error: 'No meals found for source date and slot' })

    const { rows: tgtCheck } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM meals
       WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) = $2::date AND meal_slot = $3`,
      [dbUserId, to_date, to_slot],
    )
    const targetCount = tgtCheck[0].count
    if (targetCount > 0 && !mode)
      return res.status(409).json({ target_has_logs: true, target_count: targetCount })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (mode === 'replace' && targetCount > 0) {
        await client.query(
          `DELETE FROM meals WHERE user_id = $1 AND COALESCE(log_date, logged_at::date) = $2::date AND meal_slot = $3`,
          [dbUserId, to_date, to_slot],
        )
      }
      const inserted = []
      for (const m of srcMeals) {
        const { rows } = await client.query(
          `INSERT INTO meals (
             user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, sugar, portion_notes,
             meal_slot, log_date, serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15,$16,$17,$18)
           RETURNING *`,
          [dbUserId, m.meal_name, m.photo_url, m.calories, m.protein, m.carbs, m.fat,
           m.fiber, m.sugar, m.portion_notes, to_slot, to_date,
           m.serving_size, m.serving_unit, m.source_type, m.source_label, m.is_verified, m.micronutrients],
        )
        inserted.push(rows[0])
      }
      await client.query('COMMIT')
      res.status(201).json({ copied: inserted.length, meals: inserted })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) { next(err) }
})

// POST /api/meals/:id/copy — re-log a past meal, optionally on a specific date and slot
router.post('/:id/copy', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const mealId   = parseInt(req.params.id, 10)
    const { date, slot } = req.body

    const { rows: src } = await pool.query(
      `SELECT meal_name, calories, protein, carbs, fat, fiber, photo_url, portion_notes, meal_slot,
              serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
       FROM meals WHERE id = $1 AND user_id = $2`,
      [mealId, dbUserId],
    )
    if (!src.length) return res.status(404).json({ error: 'Meal not found' })

    const m = src[0]
    const { rows } = await pool.query(
      `INSERT INTO meals (
         user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, portion_notes,
         meal_slot, log_date, serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               COALESCE($11::date, CURRENT_DATE), $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [dbUserId, m.meal_name, m.photo_url, m.calories, m.protein, m.carbs, m.fat, m.fiber,
       m.portion_notes, slot ?? m.meal_slot, date ?? null, m.serving_size, m.serving_unit,
       m.source_type, m.source_label, m.is_verified, m.micronutrients],
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
    const v = normalizeMealPayload(req.body)
    if (!v.ok) return res.status(400).json({ error: v.error })
    const d = v.data
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
      `INSERT INTO meals (
         user_id, meal_name, photo_url, calories, protein, carbs, fat, fiber, sugar, meal_slot, log_date,
         serving_size, serving_unit, source_type, source_label, is_verified, micronutrients
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [dbUserId, d.meal_name, photo_url, d.calories, d.protein, d.carbs, d.fat,
       d.fiber, d.sugar, d.meal_slot, d.log_date,
       d.serving_size ?? null, d.serving_unit ?? null,
       d.source_type ?? null, d.source_label ?? null,
       d.is_verified ?? false, d.micronutrients ?? null],
    )
    fireGamification(pool, dbUserId, d.log_date)
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// GET /api/meals/recent?slot=Breakfast&limit=5 — most recently logged unique meals
router.get('/recent', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const slot  = req.query.slot ?? null
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '5', 10), 1), 20)

    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (LOWER(m.meal_name))
           m.meal_name, m.calories, m.protein, m.carbs, m.fat, m.fiber,
           m.serving_size, m.serving_unit, m.source_type, m.source_label, m.is_verified,
           COALESCE(m.log_date, m.logged_at::date) AS last_logged
         FROM meals m
         JOIN users u ON u.id = m.user_id
         WHERE u.clerk_user_id = $1
           AND ($2::text IS NULL OR m.meal_slot = $2)
         ORDER BY LOWER(m.meal_name), COALESCE(m.log_date, m.logged_at::date) DESC
       ) sub
       ORDER BY last_logged DESC
       LIMIT $3`,
      [userId, slot, limit],
    )
    res.json(rows)
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
      `SELECT DISTINCT COALESCE(m.log_date, m.logged_at::date) AS date
       FROM meals m JOIN users u ON u.id = m.user_id
       WHERE u.clerk_user_id = $1
         AND COALESCE(m.log_date, m.logged_at::date) >= $2::date
         AND COALESCE(m.log_date, m.logged_at::date) <= $3::date
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
             m.portion_notes, m.logged_at, m.log_date, m.meal_slot,
             m.serving_size, m.serving_unit, m.source_type, m.source_label,
             m.is_verified, m.micronutrients
      FROM meals m
      JOIN users u ON u.id = m.user_id
      WHERE u.clerk_user_id = $1`

    const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit, 10), 1), 200) : null

    const { rows } = date
      ? await pool.query(
          `${baseSelect}
             AND COALESCE(m.log_date, m.logged_at::date) = $2::date
           ORDER BY m.logged_at ASC`,
          [userId, date],
        )
      : await pool.query(
          `${baseSelect} ORDER BY m.logged_at DESC${limit ? ` LIMIT ${limit}` : ''}`,
          [userId],
        )

    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// GET /api/meals/today — daily macro totals (accepts optional ?date=YYYY-MM-DD)
router.get('/today', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    // Client passes its local date; fall back to server CURRENT_DATE if not provided
    const date = req.query.date ?? new Date().toISOString().slice(0, 10)

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
         AND COALESCE(m.log_date, m.logged_at::date) = $2::date`,
      [userId, date],
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

    const v = normalizeMealPayload(req.body, { partial: true })
    if (!v.ok) return res.status(400).json({ error: v.error })
    const d = v.data

    const { rows } = await pool.query(
      `UPDATE meals SET
         meal_name     = COALESCE($1, meal_name),
         calories      = COALESCE($2, calories),
         protein       = COALESCE($3, protein),
         carbs         = COALESCE($4, carbs),
         fat           = COALESCE($5, fat),
         fiber         = COALESCE($6, fiber),
         portion_notes = COALESCE($7, portion_notes),
         meal_slot     = COALESCE($8, meal_slot),
         log_date      = COALESCE($9::date, log_date),
         serving_size  = COALESCE($10, serving_size),
         serving_unit  = COALESCE($11, serving_unit)
       WHERE id = $12 AND user_id = $13
       RETURNING *`,
      [
        d.meal_name ?? null, d.calories ?? null, d.protein ?? null,
        d.carbs ?? null, d.fat ?? null, d.fiber ?? null,
        req.body.portion_notes ?? null,
        d.meal_slot ?? null, d.log_date ?? null,
        d.serving_size ?? null, d.serving_unit ?? null,
        mealId, dbUserId,
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
           AND COALESCE(m.log_date, m.logged_at::date) >= DATE_TRUNC('week', CURRENT_DATE)
         GROUP BY COALESCE(m.log_date, m.logged_at::date)
       ) t`,
      [userId],
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

export default router
