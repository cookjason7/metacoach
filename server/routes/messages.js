import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { trackEvent } from '../services/usageTracker.js'
import { notifyNewDirectMessage } from '../services/pushService.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)
    cb(null, ok)
  },
})

const uploadAudioMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype?.startsWith('audio/')
    cb(null, ok)
  },
})

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'metacoach/messages' },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

function uploadAudioToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'metacoach/messages/audio', resource_type: 'video' },
      (err, result) => {
        if (err) return reject(err)
        // Store the raw Cloudinary URL; playback fallbacks are handled by the UI.
        const secure_url = result.secure_url
        resolve({ ...result, secure_url })
      },
    )
    stream.end(buffer)
  })
}

const router = Router()

function visibleThreadTypesForClient(coachingType) {
  return coachingType === 'vip'
    ? ['admin_private', 'coach_thread']
    : ['admin_private', 'ai_admin']
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getClientContext(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query(
    `SELECT u.id, u.coaching_type, u.assigned_coach_id,
            coach.first_name AS assigned_coach_name
     FROM users u
     LEFT JOIN users coach ON coach.id = u.assigned_coach_id
     WHERE u.id = $1`,
    [dbUserId],
  )
  return { dbUserId, ...(rows[0] ?? {}) }
}

// Which threads should this client see? Clients see all their own messages.
// Coaches see admin_private messages, but those messages are visible
// to the *recipient* client too — admin_private is private from OTHER staff,
// not from the client they're addressed to.
async function listThreadsForClient(dbUserId, coachingType) {
  const visibleThreadTypes = visibleThreadTypesForClient(coachingType)
  const { rows } = await pool.query(`
    SELECT
      thread_type,
      COUNT(*) FILTER (WHERE read_at IS NULL AND sender_id != $1) AS unread,
      MAX(created_at) AS last_message_at,
      (SELECT CASE
          WHEN message_body IS NOT NULL AND message_body != '' THEN message_body
          WHEN audio_url IS NOT NULL THEN 'Voice message'
          WHEN image_url IS NOT NULL THEN 'Image'
          ELSE ''
        END
        FROM client_messages
        WHERE client_id = $1 AND thread_type = m.thread_type AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1) AS last_message_body
    FROM client_messages m
    WHERE client_id = $1 AND thread_type = ANY($2::text[]) AND m.deleted_at IS NULL
    GROUP BY thread_type
    ORDER BY MAX(created_at) DESC
  `, [dbUserId, visibleThreadTypes])

  // Inject available threads even if no messages yet so UI can show them
  const existing = new Set(rows.map(r => r.thread_type))
  const all = []
  if (coachingType !== 'vip') {
    if (!existing.has('ai_admin')) all.push({ thread_type: 'ai_admin', unread: 0, last_message_at: null, last_message_body: null })
  } else {
    if (!existing.has('coach_thread')) all.push({ thread_type: 'coach_thread', unread: 0, last_message_at: null, last_message_body: null })
  }
  return [...rows, ...all]
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/messages/upload  (any authenticated user — client or staff)
router.post('/upload', requireAuth(), upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file received' })
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const result = await uploadToCloudinary(req.file.buffer)
    // Track upload (non-blocking)
    trackEvent({
      actorUserId: dbUserId,
      feature:     'message_upload',
      action:      'upload',
      provider:    'cloudinary',
      providerOp:  'upload_stream',
      fileCount:   1,
      bytesIn:     req.file.size,
      metadata:    { mime_type: req.file.mimetype },
    })
    res.json({ url: result.secure_url })
  } catch (err) { next(err) }
})

// POST /api/messages/upload-audio  (client or staff)
router.post('/upload-audio', requireAuth(), uploadAudioMulter.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file received' })
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const result = await uploadAudioToCloudinary(req.file.buffer)
    trackEvent({
      actorUserId: dbUserId,
      feature:     'message_audio_upload',
      action:      'upload',
      provider:    'cloudinary',
      providerOp:  'upload_stream',
      fileCount:   1,
      bytesIn:     req.file.size,
      metadata:    { mime_type: req.file.mimetype },
    })
    res.json({ url: result.secure_url })
  } catch (err) { next(err) }
})

// GET /api/messages/threads
router.get('/threads', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const threads = await listThreadsForClient(ctx.dbUserId, ctx.coaching_type)
    res.json({ threads, coachName: ctx.assigned_coach_name ?? null })
  } catch (err) { next(err) }
})

// GET /api/messages/unread-count
router.get('/unread-count', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS unread
       FROM client_messages
       WHERE client_id = $1
         AND read_at IS NULL
         AND sender_id != $1
         AND deleted_at IS NULL
         AND thread_type = ANY($2::text[])`,
      [ctx.dbUserId, visibleThreadTypesForClient(ctx.coaching_type)],
    )
    res.json({ unread: rows[0]?.unread ?? 0 })
  } catch (err) { next(err) }
})

// GET /api/messages/thread/:threadType
router.get('/thread/:threadType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const thread = req.params.threadType

    // ai_admin thread for hybrid/ai clients; coach_thread for VIP only
    if (thread === 'ai_admin' && ctx.coaching_type === 'vip') {
      return res.status(403).json({ error: 'Not available for VIP clients' })
    }
    if (thread === 'coach_thread' && ctx.coaching_type !== 'vip') {
      return res.status(403).json({ error: 'Not available for non-VIP clients' })
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const beforeId = req.query.before_id ? parseInt(req.query.before_id) : null

    const qParams = [ctx.dbUserId, thread]
    let extraWhere = ''
    if (beforeId) {
      qParams.push(beforeId)
      extraWhere = ` AND m.id < $${qParams.length}`
    }
    qParams.push(limit + 1)

    const { rows } = await pool.query(`
      SELECT m.*, u.first_name AS sender_name
      FROM client_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.client_id = $1 AND m.thread_type = $2 AND m.deleted_at IS NULL${extraWhere}
      ORDER BY m.id DESC
      LIMIT $${qParams.length}
    `, qParams)

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()
    rows.reverse()

    // Mark staff-sent messages as read
    await pool.query(`
      UPDATE client_messages
      SET read_at = NOW()
      WHERE client_id = $1 AND thread_type = $2
        AND read_at IS NULL AND sender_id != $1
    `, [ctx.dbUserId, thread])

    res.json({
      messages: rows,
      hasMore,
      nextBeforeId: hasMore ? rows[0].id : null,
    })
  } catch (err) { next(err) }
})

// POST /api/messages/thread/:threadType
// body: { message_body, image_url, audio_url }
router.post('/thread/:threadType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const thread = req.params.threadType
    const { message_body = '', image_url, audio_url } = req.body
    if (!message_body?.trim() && !image_url && !audio_url) {
      return res.status(400).json({ error: 'message_body, image, or audio required' })
    }

    // All human/team threads are two-way — clients may reply to any of them.
    if (!['admin_private', 'coach_thread', 'ai_admin'].includes(thread)) {
      return res.status(400).json({ error: 'Invalid message thread' })
    }
    if (thread === 'ai_admin' && ctx.coaching_type === 'vip') {
      return res.status(403).json({ error: 'Not available for VIP clients' })
    }
    if (thread === 'coach_thread' && ctx.coaching_type !== 'vip') {
      return res.status(403).json({ error: 'Not available for non-VIP clients' })
    }

    const visibility = 'client_and_staff'

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url, audio_url)
      VALUES ($1, $2, 'client', $3, $4, $5, $6, $7)
      RETURNING *
    `, [ctx.dbUserId, ctx.dbUserId, message_body.trim(), thread, visibility, image_url ?? null, audio_url ?? null])

    // Auto-restore archived conversations when client sends a new message
    await pool.query(`
      UPDATE staff_inbox_states
      SET archived = FALSE, archived_at = NULL
      WHERE client_id = $1 AND thread_type = $2 AND archived = TRUE
    `, [ctx.dbUserId, thread])

    // Push: notify assigned coach (or admins if no coach assigned) — fire-and-forget
    pool.query(
      `SELECT COALESCE(assigned_coach_id, NULL) AS coach_id FROM users WHERE id = $1`,
      [ctx.dbUserId],
    ).then(async ({ rows: [u] }) => {
      if (u?.coach_id) {
        await notifyNewDirectMessage(u.coach_id).catch(() => {})
      } else {
        const { rows: admins } = await pool.query(
          `SELECT id FROM users WHERE role = 'admin'`,
        )
        for (const a of admins) await notifyNewDirectMessage(a.id).catch(() => {})
      }
    }).catch(() => {})

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/messages/:id
// Soft-delete: only the original sender (this client) may delete their own message.
// The row is retained with deleted_at set so history/threads stay consistent.
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const id = parseInt(req.params.id, 10)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id' })

    const { rows } = await pool.query(
      'SELECT client_id, sender_id, sender_role, deleted_at FROM client_messages WHERE id = $1',
      [id],
    )
    const msg = rows[0]
    if (!msg) return res.status(404).json({ error: 'Message not found' })

    // Sender identity check: must be a client message the requester sent, in their own thread.
    if (msg.sender_role !== 'client' || msg.sender_id !== ctx.dbUserId || msg.client_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'You can only delete your own messages' })
    }

    if (!msg.deleted_at) {
      await pool.query('UPDATE client_messages SET deleted_at = NOW() WHERE id = $1', [id])
    }
    res.json({ ok: true, id })
  } catch (err) { next(err) }
})

export default router
