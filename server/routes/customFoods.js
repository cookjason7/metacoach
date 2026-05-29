import { Router } from 'express'
import multer from 'multer'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { parseLabelFromImageWithAI } from '../services/labelParser.js'
import { labelScanLimit } from '../middleware/rateLimits.js'
import { trackEvent } from '../services/usageTracker.js'

const router = Router()

const ALLOWED_LABEL_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
const uploadLabelImage = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_LABEL_TYPES.has(file.mimetype)),
})

// GET /api/custom-foods — user's custom foods + global foods
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT * FROM custom_foods
       WHERE is_global = TRUE OR user_id = $1
       ORDER BY is_global DESC, food_name ASC`,
      [dbUserId],
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/custom-foods
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const {
      is_global, food_name, calories_per_serving, protein, carbs, fat, fiber,
      sugar, sodium_mg, serving_size, serving_unit, barcode,
    } = req.body

    if (!food_name?.trim()) return res.status(400).json({ error: 'Food name required' })

    if (is_global) {
      const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
      if (rows[0]?.role !== 'admin') {
        return res.status(403).json({ error: 'Only admin can create global foods' })
      }
    }

    const cleanBarcode = barcode?.toString().replace(/\D/g, '').trim() || null

    // If this barcode already exists for this user (or globally), return the existing entry
    if (cleanBarcode) {
      const { rows: [existing] } = await pool.query(
        `SELECT * FROM custom_foods
         WHERE barcode = $1 AND (is_global = TRUE OR user_id = $2)
         LIMIT 1`,
        [cleanBarcode, dbUserId],
      )
      if (existing) return res.status(200).json(existing)
    }

    // Client-created private foods enter the admin review queue automatically.
    // Admin-created global foods are already approved.
    const reviewStatus = (is_global) ? 'approved' : 'pending'

    const { rows } = await pool.query(
      `INSERT INTO custom_foods
         (user_id, is_global, food_name, calories_per_serving, protein, carbs, fat, fiber, sugar, sodium_mg, serving_size, serving_unit, barcode, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        is_global ? null : dbUserId,
        is_global ?? false,
        food_name.trim(),
        calories_per_serving ?? null,
        protein   ?? null,
        carbs     ?? null,
        fat       ?? null,
        fiber     ?? null,
        sugar     ?? null,
        sodium_mg ?? null,
        serving_size  ?? 100,
        serving_unit  ?? 'g',
        cleanBarcode,
        reviewStatus,
      ],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/custom-foods/scan-label — parse nutrition label image with AI, return draft (does NOT save)
router.post('/scan-label', requireAuth(), labelScanLimit, uploadLabelImage.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided. Upload a JPG, PNG, or WEBP file.' })
    }
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const t0 = Date.now()
    const draft = await parseLabelFromImageWithAI(req.file.buffer, req.file.mimetype)
    // Track label scan AI call (non-blocking) — token counts not available from labelParser,
    // so we log a null-cost event to record the call happened
    trackEvent({
      actorUserId: dbUserId,
      feature:     'label_scan',
      action:      'ai_call',
      provider:    'anthropic',
      providerOp:  'messages.create',
      model:       'claude-sonnet-4-6',
      fileCount:   1,
      bytesIn:     req.file.size,
      durationMs:  Date.now() - t0,
      metadata:    { mime_type: req.file.mimetype, note: 'token_count_via_labelParser' },
    })
    res.json(draft)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || undefined })
    next(err)
  }
})

// PATCH /api/custom-foods/:id — edit name, macros, and serving for user's own foods
router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const foodId   = parseInt(req.params.id, 10)
    if (isNaN(foodId)) return res.status(400).json({ error: 'Invalid id' })

    const { rows: [food] } = await pool.query(
      'SELECT id, user_id FROM custom_foods WHERE id = $1',
      [foodId],
    )
    if (!food) return res.status(404).json({ error: 'Food not found' })

    const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const isAdmin = userRows[0]?.role === 'admin'

    if (!isAdmin && food.user_id !== dbUserId) {
      return res.status(403).json({ error: 'Not your food' })
    }

    const { food_name, calories_per_serving, protein, carbs, fat, fiber, sugar, sodium_mg, serving_size, serving_unit } = req.body

    if (food_name !== undefined && !String(food_name ?? '').trim()) {
      return res.status(400).json({ error: 'Food name cannot be empty' })
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE custom_foods SET
         food_name            = COALESCE($1, food_name),
         calories_per_serving = COALESCE($2, calories_per_serving),
         protein              = COALESCE($3, protein),
         carbs                = COALESCE($4, carbs),
         fat                  = COALESCE($5, fat),
         fiber                = COALESCE($6, fiber),
         sugar                = COALESCE($7, sugar),
         sodium_mg            = COALESCE($8, sodium_mg),
         serving_size         = COALESCE($9, serving_size),
         serving_unit         = COALESCE($10, serving_unit)
       WHERE id = $11
       RETURNING *`,
      [
        food_name        != null ? String(food_name).trim() : null,
        calories_per_serving != null ? Number(calories_per_serving) : null,
        protein          != null ? Number(protein)       : null,
        carbs            != null ? Number(carbs)         : null,
        fat              != null ? Number(fat)           : null,
        fiber            != null ? Number(fiber)         : null,
        sugar            != null ? Number(sugar)         : null,
        sodium_mg        != null ? Number(sodium_mg)     : null,
        serving_size     != null ? Number(serving_size)  : null,
        serving_unit     != null ? String(serving_unit)  : null,
        foodId,
      ],
    )
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/custom-foods/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const foodId   = parseInt(req.params.id, 10)

    const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const isAdmin = userRows[0]?.role === 'admin'

    const { rowCount } = await pool.query(
      isAdmin
        ? 'DELETE FROM custom_foods WHERE id = $1'
        : 'DELETE FROM custom_foods WHERE id = $1 AND user_id = $2',
      isAdmin ? [foodId] : [foodId, dbUserId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Food not found' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
