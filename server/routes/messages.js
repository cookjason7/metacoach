import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getClientContext(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query(
    'SELECT id, coaching_type, assigned_coach_id FROM users WHERE id = $1',
    [dbUserId],
  )
  return { dbUserId, ...(rows[0] ?? {}) }
}

// Which threads should this client see? Clients see all their own messages.
// Coaches see admin_private messages, but those messages are visible
// to the *recipient* client too — admin_private is private from OTHER staff,
// not from the client they're addressed to.
async function listThreadsForClient(dbUserId, coachingType) {
  const { rows } = await pool.query(`
    SELECT
      thread_type,
      COUNT(*) FILTER (WHERE read_at IS NULL AND sender_id != $1) AS unread,
      MAX(created_at) AS last_message_at,
      (SELECT message_body FROM client_messages
        WHERE client_id = $1 AND thread_type = m.thread_type
        ORDER BY created_at DESC LIMIT 1) AS last_message_body
    FROM client_messages m
    WHERE client_id = $1
    GROUP BY thread_type
    ORDER BY MAX(created_at) DESC
  `, [dbUserId])

  // Inject available threads even if no messages yet so UI can show them
  const existing = new Set(rows.map(r => r.thread_type))
  const all = []
  if (coachingType === 'ai') {
    if (!existing.has('ai_admin')) all.push({ thread_type: 'ai_admin', unread: 0, last_message_at: null, last_message_body: null })
  } else {
    if (!existing.has('coach_thread')) all.push({ thread_type: 'coach_thread', unread: 0, last_message_at: null, last_message_body: null })
  }
  return [...rows, ...all]
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/messages/threads
router.get('/threads', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    res.json(await listThreadsForClient(ctx.dbUserId, ctx.coaching_type))
  } catch (err) { next(err) }
})

// GET /api/messages/unread-count
router.get('/unread-count', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS unread
       FROM client_messages
       WHERE client_id = $1 AND read_at IS NULL AND sender_id != $1`,
      [ctx.dbUserId],
    )
    res.json({ unread: rows[0]?.unread ?? 0 })
  } catch (err) { next(err) }
})

// GET /api/messages/thread/:threadType
router.get('/thread/:threadType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const thread = req.params.threadType

    // AI thread only for AI clients; coach_thread only for VIP
    if (thread === 'ai_admin' && ctx.coaching_type !== 'ai') {
      return res.status(403).json({ error: 'Not an AI coaching client' })
    }
    if (thread === 'coach_thread' && ctx.coaching_type === 'ai') {
      return res.status(403).json({ error: 'Not available for AI coaching clients' })
    }

    const { rows } = await pool.query(`
      SELECT m.*, u.first_name AS sender_name
      FROM client_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.client_id = $1 AND m.thread_type = $2
      ORDER BY m.created_at ASC
    `, [ctx.dbUserId, thread])

    // Mark staff-sent messages as read
    await pool.query(`
      UPDATE client_messages
      SET read_at = NOW()
      WHERE client_id = $1 AND thread_type = $2
        AND read_at IS NULL AND sender_id != $1
    `, [ctx.dbUserId, thread])

    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/messages/thread/:threadType
// body: { message_body }
router.post('/thread/:threadType', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getClientContext(req)
    const thread = req.params.threadType
    const { message_body } = req.body
    if (!message_body?.trim()) {
      return res.status(400).json({ error: 'message_body required' })
    }

    // Clients can only reply in their assigned thread (coach_thread for VIP,
    // ai_admin for AI). admin_private is admin→client only; client replies
    // there are NOT supported (would risk staff confusion).
    if (thread === 'admin_private') {
      return res.status(403).json({ error: 'This is a one-way thread from staff' })
    }
    if (thread === 'ai_admin' && ctx.coaching_type !== 'ai') {
      return res.status(403).json({ error: 'Not an AI coaching client' })
    }
    if (thread === 'coach_thread' && ctx.coaching_type === 'ai') {
      return res.status(403).json({ error: 'Not available for AI coaching clients' })
    }

    const visibility = thread === 'ai_admin' ? 'client_and_admin_only' : 'client_and_staff'

    const { rows } = await pool.query(`
      INSERT INTO client_messages
        (client_id, sender_id, sender_role, message_body, thread_type, visibility)
      VALUES ($1, $2, 'client', $3, $4, $5)
      RETURNING *
    `, [ctx.dbUserId, ctx.dbUserId, message_body.trim(), thread, visibility])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

export default router
