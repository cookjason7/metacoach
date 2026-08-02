import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail } from '../db.js'
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

// Kept in sync with the CHECK constraint on message_reactions.reaction_type (server/db.js)
// and with community post_reactions' emoji set, for visual consistency.
const REACTION_TYPES = ['like', 'love', 'laugh', 'care']

// Batch-attach a { reactions: [{reaction_type, count, mine}] } summary to each message
// row, for a thread listing. `mine` reflects whether viewerId reacted with that type.
async function attachReactions(rows, viewerId) {
  if (!rows.length) return rows
  const { rows: summary } = await pool.query(
    `SELECT message_id, reaction_type, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS mine
     FROM message_reactions
     WHERE message_id = ANY($1::int[])
     GROUP BY message_id, reaction_type`,
    [rows.map(r => r.id), viewerId],
  )
  const byMessage = new Map()
  for (const r of summary) {
    const list = byMessage.get(r.message_id) ?? []
    list.push({ reaction_type: r.reaction_type, count: r.count, mine: r.mine })
    byMessage.set(r.message_id, list)
  }
  return rows.map(r => ({ ...r, reactions: byMessage.get(r.id) ?? [] }))
}

async function reactionsForMessage(messageId, viewerId) {
  const { rows } = await pool.query(
    `SELECT reaction_type, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS mine
     FROM message_reactions WHERE message_id = $1 GROUP BY reaction_type`,
    [messageId, viewerId],
  )
  return rows
}

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
    `SELECT u.id, u.org_id, u.email, u.coaching_type, u.assigned_coach_id,
            coach.first_name AS assigned_coach_name,
            coach.role AS assigned_coach_role
     FROM users u
     LEFT JOIN users coach ON coach.id = u.assigned_coach_id
     WHERE u.id = $1`,
    [dbUserId],
  )
  const row = rows[0] ?? {}
  return { dbUserId, orgId: row.org_id ?? 1, ...row }
}

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping. Same distinction as coachAdmin.js: isAdminRole()/'admin' role is NOT
// enough here since every org gets its own admin user under multi-tenancy — only
// the hardcoded platform-owner allowlist should see across orgs.
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

// Org-scoping note: every route below already filters client_messages by
// `client_id = ctx.dbUserId` — the requesting client's own row id, which is a
// strictly stronger and already-correct boundary than org_id (a user belongs to
// exactly one org, so scoping by their own id can never cross an org boundary).
// Those reads/updates are deliberately NOT given an additional `org_id = ...`
// filter: client_messages.org_id isn't set on INSERT by every write path in the
// app yet (e.g. staff-sent replies via coachAdmin.js), so filtering reads by it
// would silently hide legitimate messages instead of adding real isolation. New
// rows inserted from this file DO set org_id (see POST /thread/:threadType)
// so future org-scoped reporting has correct data to work from. The one place
// this file queries across users (the admin-notification fallback below) is
// scoped to org_id explicitly, since that's a genuine cross-tenant read.

// True when the client's assigned coach IS an admin — in that case coach_thread and
// admin_private point at the same person, so they should present as one thread instead
// of two (previously a client reply could land in whichever tab they happened to use,
// leaving staff staring at the other tab wondering why nothing arrived).
function isCoachAdminMerge(ctx) {
  return ctx.coaching_type === 'vip'
    && ctx.assigned_coach_id != null
    && (ctx.assigned_coach_role === 'admin' || ctx.assigned_coach_role === 'account_owner')
}

// Which threads should this client see? Clients see all their own messages.
// Coaches see admin_private messages, but those messages are visible
// to the *recipient* client too — admin_private is private from OTHER staff,
// not from the client they're addressed to.
async function listThreadsForClient(ctx) {
  const { dbUserId, coaching_type: coachingType } = ctx
  const merged = isCoachAdminMerge(ctx)
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

  let list = rows
  if (merged) {
    const coachRow = rows.find(r => r.thread_type === 'coach_thread')
    const adminRow = rows.find(r => r.thread_type === 'admin_private')
    if (coachRow || adminRow) {
      const coachTime = coachRow?.last_message_at ? new Date(coachRow.last_message_at).getTime() : -1
      const adminTime = adminRow?.last_message_at ? new Date(adminRow.last_message_at).getTime() : -1
      const mostRecent = adminTime > coachTime ? adminRow : (coachRow ?? adminRow)
      list = rows
        .filter(r => r.thread_type !== 'coach_thread' && r.thread_type !== 'admin_private')
        .concat([{
          thread_type: 'coach_thread',
          unread: (Number(coachRow?.unread) || 0) + (Number(adminRow?.unread) || 0),
          last_message_at: mostRecent.last_message_at,
          last_message_body: mostRecent.last_message_body,
        }])
    }
  }

  // Inject available threads even if no messages yet so UI can show them
  const existing = new Set(list.map(r => r.thread_type))
  const all = []
  if (coachingType !== 'vip') {
    if (!existing.has('ai_admin')) all.push({ thread_type: 'ai_admin', unread: 0, last_message_at: null, last_message_body: null })
  } else {
    if (!existing.has('coach_thread')) all.push({ thread_type: 'coach_thread', unread: 0, last_message_at: null, last_message_body: null })
  }
  return [...list, ...all]
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
    const threads = await listThreadsForClient(ctx)
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

    // When the assigned coach is an admin, coach_thread and admin_private are the
    // same person — fetch and mark-read across both so no message can hide in the
    // tab the client isn't currently viewing (see isCoachAdminMerge).
    const threadTypes = (thread === 'coach_thread' || thread === 'admin_private') && isCoachAdminMerge(ctx)
      ? ['coach_thread', 'admin_private']
      : [thread]

    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const beforeId = req.query.before_id ? parseInt(req.query.before_id) : null

    const qParams = [ctx.dbUserId, threadTypes]
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
      WHERE m.client_id = $1 AND m.thread_type = ANY($2::text[]) AND m.deleted_at IS NULL${extraWhere}
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
      WHERE client_id = $1 AND thread_type = ANY($2::text[])
        AND read_at IS NULL AND sender_id != $1
    `, [ctx.dbUserId, threadTypes])

    const messagesWithReactions = await attachReactions(rows, ctx.dbUserId)

    res.json({
      messages: messagesWithReactions,
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

    // Canonicalize to coach_thread when the assigned coach is an admin, so new
    // messages never re-fragment across the two thread_types (see isCoachAdminMerge).
    const canonicalThread = (thread === 'coach_thread' || thread === 'admin_private') && isCoachAdminMerge(ctx)
      ? 'coach_thread'
      : thread

    const visibility = 'client_and_staff'

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility, image_url, audio_url, org_id)
      VALUES ($1, $2, 'client', $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [ctx.dbUserId, ctx.dbUserId, message_body.trim(), canonicalThread, visibility, image_url ?? null, audio_url ?? null, ctx.orgId])

    // Auto-restore archived conversations when client sends a new message
    await pool.query(`
      UPDATE staff_inbox_states
      SET archived = FALSE, archived_at = NULL
      WHERE client_id = $1 AND thread_type = $2 AND archived = TRUE
    `, [ctx.dbUserId, canonicalThread])

    // Push: notify assigned coach (or admins if no coach assigned) — fire-and-forget
    pool.query(
      `SELECT COALESCE(assigned_coach_id, NULL) AS coach_id FROM users WHERE id = $1`,
      [ctx.dbUserId],
    ).then(async ({ rows: [u] }) => {
      if (u?.coach_id) {
        await notifyNewDirectMessage(u.coach_id, ctx.dbUserId).catch(() => {})
      } else {
        // Notify admins in this client's own org only — a client with no assigned
        // coach shouldn't page every admin across every other org on the platform.
        // Super admin (Jason) is exempt from this org filter, matching coachAdmin.js.
        const { rows: admins } = isSuperAdmin(ctx)
          ? await pool.query(`SELECT id FROM users WHERE role = 'admin'`)
          : await pool.query(`SELECT id FROM users WHERE role = 'admin' AND org_id = $1`, [ctx.orgId])
        for (const a of admins) await notifyNewDirectMessage(a.id, ctx.dbUserId).catch(() => {})
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

// POST /api/messages/:id/reactions  body: { reaction_type }
// A client may react to any message in their own thread — theirs or staff's.
router.post('/:id/reactions', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const id = parseInt(req.params.id, 10)
    const { reaction_type } = req.body
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id' })
    if (!REACTION_TYPES.includes(reaction_type)) return res.status(400).json({ error: 'Invalid reaction_type' })

    const { rows } = await pool.query(
      'SELECT client_id FROM client_messages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    )
    if (!rows.length || rows[0].client_id !== ctx.dbUserId) {
      return res.status(404).json({ error: 'Message not found' })
    }

    await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, reaction_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, reaction_type) DO NOTHING`,
      [id, ctx.dbUserId, reaction_type],
    )

    res.status(201).json({ reactions: await reactionsForMessage(id, ctx.dbUserId) })
  } catch (err) { next(err) }
})

// DELETE /api/messages/:id/reactions/:reactionType
router.delete('/:id/reactions/:reactionType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const id = parseInt(req.params.id, 10)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid message id' })

    const { rows } = await pool.query(
      'SELECT client_id FROM client_messages WHERE id = $1 AND deleted_at IS NULL',
      [id],
    )
    if (!rows.length || rows[0].client_id !== ctx.dbUserId) {
      return res.status(404).json({ error: 'Message not found' })
    }

    await pool.query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND reaction_type = $3',
      [id, ctx.dbUserId, req.params.reactionType],
    )

    res.json({ reactions: await reactionsForMessage(id, ctx.dbUserId) })
  } catch (err) { next(err) }
})

export default router
