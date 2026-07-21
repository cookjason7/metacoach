import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { photoUploadLimit } from '../middleware/rateLimits.js'
import { trackEvent } from '../services/usageTracker.js'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
})

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'metacoach/progress' },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

function publicIdFromCloudinaryUrl(url) {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const uploadIdx = parts.indexOf('upload')
    if (uploadIdx === -1) return null
    const assetParts = parts.slice(uploadIdx + 1).filter(p => !/^v\d+$/.test(p))
    const joined = assetParts.join('/')
    return joined.replace(/\.[a-zA-Z0-9]+$/, '') || null
  } catch {
    return null
  }
}

// GET /api/progress-photos
// Returns sessions grouped by photo_session_id, most-recent session first.
// Each session: { session_id, session_date, photos: { front, side, back } }
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT
         photo_session_id AS session_id,
         MIN(taken_at)    AS session_date,
         json_agg(
           json_build_object(
             'id',        id,
             'photo_url', photo_url,
             'angle',     angle,
             'taken_at',  taken_at
           ) ORDER BY taken_at
         ) AS photos
       FROM progress_photos
       WHERE user_id = $1
       GROUP BY photo_session_id
       ORDER BY MIN(taken_at) DESC`,
      [dbUserId],
    )

    // Shape each session: photos array → { front, side, back } map
    const sessions = rows.map(row => {
      const byAngle = { front: null, side: null, back: null }
      for (const p of row.photos) {
        if (['front', 'side', 'back'].includes(p.angle)) byAngle[p.angle] = p
      }
      return {
        session_id:   row.session_id,
        session_date: row.session_date,
        photos:       byAngle,
      }
    })

    res.json(sessions)
  } catch (err) {
    next(err)
  }
})

// POST /api/progress-photos
// Body (multipart): photo (file), angle (front|back|side), session_id (optional string),
//                   taken_at_date (optional YYYY-MM-DD, ≤ today) for past-date logging
router.post('/', requireAuth(), photoUploadLimit, upload.single('photo'), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)
    const { angle, session_id, taken_at_date } = req.body

    if (!req.file) return res.status(400).json({ error: 'Photo required' })
    if (!['front', 'back', 'side'].includes(angle)) {
      return res.status(400).json({ error: 'angle must be front, back, or side' })
    }

    // Resolve target date for session grouping (optional, ≤ today)
    const todayStr   = new Date().toISOString().slice(0, 10)
    const targetDate = taken_at_date && /^\d{4}-\d{2}-\d{2}$/.test(taken_at_date) && taken_at_date <= todayStr
      ? taken_at_date : todayStr

    // If no session_id supplied, fall back to a date-based key so it still groups sensibly
    const sessionId = session_id?.trim() || `auto-${dbUserId}-${targetDate}`

    const result = await uploadToCloudinary(req.file.buffer)

    const { rows } = await pool.query(
      targetDate !== todayStr
        ? `INSERT INTO progress_photos (user_id, photo_url, angle, photo_session_id, taken_at, org_id)
           VALUES ($1, $2, $3, $4, $5::date + CURRENT_TIME, $6)
           RETURNING id, photo_url, angle, taken_at, photo_session_id AS session_id`
        : `INSERT INTO progress_photos (user_id, photo_url, angle, photo_session_id, org_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, photo_url, angle, taken_at, photo_session_id AS session_id`,
      targetDate !== todayStr
        ? [dbUserId, result.secure_url, angle, sessionId, targetDate, req.orgId]
        : [dbUserId, result.secure_url, angle, sessionId, req.orgId],
    )
    // Track upload (non-blocking)
    trackEvent({
      actorUserId: dbUserId,
      feature:     'progress_photo',
      action:      'upload',
      provider:    'cloudinary',
      providerOp:  'upload_stream',
      fileCount:   1,
      bytesIn:     req.file.size,
      metadata:    { angle, mime_type: req.file.mimetype },
    })
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/progress-photos/:id
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)
    const id         = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `DELETE FROM progress_photos
       WHERE id = $1 AND user_id = $2
       RETURNING id, photo_url, angle`,
      [id, dbUserId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' })

    const publicId = publicIdFromCloudinaryUrl(rows[0].photo_url)
    if (publicId) {
      cloudinary.uploader.destroy(publicId).catch(err => {
        console.warn('[progress photo delete] Cloudinary cleanup skipped:', err.message)
      })
    }

    trackEvent({
      actorUserId: dbUserId,
      feature:     'progress_photo',
      action:      'delete',
      provider:    'cloudinary',
      providerOp:  'destroy',
      fileCount:   1,
      metadata:    { angle: rows[0].angle, cloudinary_cleanup_attempted: Boolean(publicId) },
    })

    res.json({ ok: true, id })
  } catch (err) {
    next(err)
  }
})

export default router
