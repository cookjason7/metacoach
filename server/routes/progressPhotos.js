import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

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

// GET /api/progress-photos
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)

    const { rows } = await pool.query(
      `SELECT id, photo_url, angle, taken_at
       FROM progress_photos
       WHERE user_id = $1
       ORDER BY taken_at DESC`,
      [dbUserId],
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/progress-photos
router.post('/', requireAuth(), upload.single('photo'), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)
    const { angle }  = req.body

    if (!req.file) return res.status(400).json({ error: 'Photo required' })
    if (!['front', 'back', 'side'].includes(angle)) {
      return res.status(400).json({ error: 'angle must be front, back, or side' })
    }

    const result = await uploadToCloudinary(req.file.buffer)

    const { rows } = await pool.query(
      `INSERT INTO progress_photos (user_id, photo_url, angle)
       VALUES ($1, $2, $3)
       RETURNING id, photo_url, angle, taken_at`,
      [dbUserId, result.secure_url, angle],
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

export default router
