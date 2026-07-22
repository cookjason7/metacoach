import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { pool, isAdminEmail } from '../db.js'
import { notifyNewTeamMessage } from '../services/pushService.js'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const uploadAudioMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, !!file.mimetype?.startsWith('audio/')),
})

const uploadAttachmentMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

function uploadAudioToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'staff-audio', resource_type: 'video' },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

function uploadAttachmentToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'staff-attachments', resource_type: 'auto', use_filename: true, filename_override: filename },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

// Runs after clerkMiddleware() + blockDeactivatedClients + orgContext (mounted
// in server/index.js) — orgContext already resolved req.internalUser for us.
export function requireStaffMiddleware(req, res, next) {
  const role = req.internalUser?.role
  if (!(role === 'admin' || role === 'account_owner' || role === 'coach' || role === 'staff')) {
    return res.status(403).json({ error: 'Staff only' })
  }
  next()
}

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCtx(req) {
  return {
    dbUserId:  req.internalUser.id,
    role:      req.internalUser.role ?? 'client',
    orgId:     req.orgId ?? req.internalUser.org_id ?? 1,
    email:     req.internalUser.email ?? null,
    firstName: req.internalUser.first_name ?? null,
  }
}

function isAdminRole(role) {
  return role === 'admin' || role === 'account_owner'
}

// Super admin (platform owner accounts in ADMIN_EMAILS) bypasses org scoping
// entirely — same distinction as coachAdmin.js/messages.js: 'admin' role alone
// is not enough since every org gets its own admin user under multi-tenancy.
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

const STAFF_ROLES = ['admin', 'coach', 'staff', 'account_owner']

// Membership alone isn't enough to gate access — the org_id seed bug fixed in
// db.js's migrate() could (and did, on staging) leave staff_channel_members
// rows pointing at another org's channel. Requiring the channel's org_id to
// match ctx here means messages/read stay locked out even if a stale (or
// future) bad membership row exists.
async function isChannelMember(channelId, userId, ctx) {
  const { rows } = await pool.query(
    `SELECT 1 FROM staff_channel_members cm
     JOIN staff_channels c ON c.id = cm.channel_id
     WHERE cm.channel_id = $1 AND cm.user_id = $2 AND ($3::boolean OR c.org_id = $4)`,
    [channelId, userId, isSuperAdmin(ctx), ctx.orgId],
  )
  return rows.length > 0
}

// True when the given channel belongs to ctx's org, or ctx is a platform
// super admin (who manages channels across every org). Every route that
// deletes a channel, changes its membership, or pins its messages must gate
// on this — channel_id alone is guessable, and none of those actions were
// previously scoped, letting an org admin who knew another org's channel id
// add themselves as a member (or delete/pin in it) with no isolation check.
async function channelInOrg(channelId, ctx) {
  if (isSuperAdmin(ctx)) return true
  const { rows } = await pool.query(
    'SELECT 1 FROM staff_channels WHERE id = $1 AND org_id = $2',
    [channelId, ctx.orgId],
  )
  return rows.length > 0
}

// First 80 chars of the text body, or a generic label for audio/attachment-only messages.
function teamMessagePreview(messageBody, audioUrl, attachmentUrl) {
  if (messageBody?.trim()) return messageBody.trim().slice(0, 80)
  if (audioUrl) return 'Sent a voice message'
  if (attachmentUrl) return 'Sent an attachment'
  return 'New message'
}

// ─── Channel routes ─────────────────────────────────────────────────────────

// GET /api/staff-chat/channels — channels the current user is a member of
router.get('/channels', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.description, c.is_private, c.created_at,
        (SELECT COUNT(*)::int FROM staff_messages sm
          WHERE sm.channel_id = c.id AND sm.sender_id != $1
            AND NOT EXISTS (
              SELECT 1 FROM staff_message_reads r
              WHERE r.message_id = sm.id AND r.user_id = $1
            )
        ) AS unread,
        (SELECT MAX(created_at) FROM staff_messages WHERE channel_id = c.id) AS last_message_at,
        (SELECT CASE
            WHEN message_body IS NOT NULL AND message_body != '' THEN message_body
            WHEN audio_url IS NOT NULL THEN 'Voice message'
            WHEN attachment_url IS NOT NULL THEN attachment_name
            ELSE ''
          END
          FROM staff_messages WHERE channel_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_body
      FROM staff_channels c
      JOIN staff_channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
      WHERE c.org_id = $2
      ORDER BY c.name
    `, [ctx.dbUserId, ctx.orgId])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/staff-chat/channels — admin only. Optional member_ids array adds
// additional staff members alongside the creator (who is always a member).
router.post('/channels', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    if (!isAdminRole(ctx.role)) return res.status(403).json({ error: 'Admin only' })
    const { name, is_private = false, description = null, member_ids = [] } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' })

    const { rows } = await pool.query(
      `INSERT INTO staff_channels (name, description, is_private, created_by, org_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), description ?? null, !!is_private, ctx.dbUserId, ctx.orgId],
    )
    const channel = rows[0]
    await pool.query(
      `INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1, $2)
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [channel.id, ctx.dbUserId],
    )

    const extraIds = Array.isArray(member_ids)
      ? [...new Set(member_ids.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id !== ctx.dbUserId))]
      : []
    if (extraIds.length) {
      const { rows: validUsers } = await pool.query(
        `SELECT id FROM users
         WHERE id = ANY($1::int[])
           AND role = ANY($2::text[])
           AND ($3::boolean OR org_id = $4)`,
        [extraIds, STAFF_ROLES, isSuperAdmin(ctx), ctx.orgId],
      )
      for (const u of validUsers) {
        await pool.query(
          `INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1, $2)
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channel.id, u.id],
        )
      }
    }

    res.status(201).json(channel)
  } catch (err) { next(err) }
})

// DELETE /api/staff-chat/channels/:id — admin only. Refuses to delete the
// last remaining channel so staff always have somewhere to talk.
router.delete('/channels/:id', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    if (!isAdminRole(ctx.role)) return res.status(403).json({ error: 'Admin only' })
    const channelId = parseInt(req.params.id, 10)
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: 'Invalid channel id' })

    const { rows } = await pool.query('SELECT id, org_id FROM staff_channels WHERE id = $1', [channelId])
    if (!rows.length) return res.status(404).json({ error: 'Channel not found' })
    if (!isSuperAdmin(ctx) && rows[0].org_id !== ctx.orgId) {
      return res.status(403).json({ error: 'Cannot delete a channel from another organization' })
    }

    // Scoped to the channel's own org — a global count would let an org with
    // few channels get blocked by every other org's channel total instead of
    // their own, or (worse) let them delete their last channel unblocked
    // whenever some other org happens to have more than one.
    const { rows: [{ cnt }] } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM staff_channels WHERE org_id = $1',
      [rows[0].org_id],
    )
    if (cnt <= 1) return res.status(400).json({ error: 'Cannot delete the only channel' })

    await pool.query('DELETE FROM staff_channels WHERE id = $1', [channelId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// GET /api/staff-chat/channels/:id/members — current channel members
router.get('/channels/:id/members', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const channelId = parseInt(req.params.id, 10)
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: 'Invalid channel id' })
    if (!(await isChannelMember(channelId, ctx.dbUserId, ctx))) {
      return res.status(403).json({ error: 'Not a member of this channel' })
    }

    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.role
      FROM staff_channel_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.channel_id = $1
      ORDER BY u.first_name
    `, [channelId])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/staff-chat/channels/:id/members — admin only. body: { user_ids: [...] }
router.post('/channels/:id/members', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    if (!isAdminRole(ctx.role)) return res.status(403).json({ error: 'Admin only' })
    const channelId = parseInt(req.params.id, 10)
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: 'Invalid channel id' })
    const { user_ids } = req.body
    if (!Array.isArray(user_ids) || !user_ids.length) return res.status(400).json({ error: 'user_ids is required' })

    const { rows: channelRows } = await pool.query('SELECT id, org_id FROM staff_channels WHERE id = $1', [channelId])
    if (!channelRows.length) return res.status(404).json({ error: 'Channel not found' })
    if (!isSuperAdmin(ctx) && channelRows[0].org_id !== ctx.orgId) {
      return res.status(403).json({ error: 'Cannot modify a channel from another organization' })
    }

    const ids = [...new Set(user_ids.map(id => parseInt(id, 10)).filter(Number.isInteger))]
    const { rows: validUsers } = await pool.query(
      `SELECT id FROM users
       WHERE id = ANY($1::int[])
         AND role = ANY($2::text[])
         AND ($3::boolean OR org_id = $4)`,
      [ids, STAFF_ROLES, isSuperAdmin(ctx), ctx.orgId],
    )
    for (const u of validUsers) {
      await pool.query(
        `INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1, $2)
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channelId, u.id],
      )
    }
    res.json({ ok: true, added: validUsers.length })
  } catch (err) { next(err) }
})

// DELETE /api/staff-chat/channels/:id/members/:userId — admin only
router.delete('/channels/:id/members/:userId', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    if (!isAdminRole(ctx.role)) return res.status(403).json({ error: 'Admin only' })
    const channelId = parseInt(req.params.id, 10)
    const userId = parseInt(req.params.userId, 10)
    if (!Number.isInteger(channelId) || !Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid channel or user id' })
    }
    if (!(await channelInOrg(channelId, ctx))) {
      return res.status(403).json({ error: 'Cannot modify a channel from another organization' })
    }
    await pool.query(
      'DELETE FROM staff_channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /api/staff-chat/channels/:id/join — admin only, adds a user to a channel
router.post('/channels/:id/join', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    if (!isAdminRole(ctx.role)) return res.status(403).json({ error: 'Admin only' })
    const channelId = parseInt(req.params.id, 10)
    const { user_id } = req.body
    if (!Number.isInteger(channelId) || !user_id) return res.status(400).json({ error: 'user_id is required' })

    const { rows: channelRows } = await pool.query('SELECT id, org_id FROM staff_channels WHERE id = $1', [channelId])
    if (!channelRows.length) return res.status(404).json({ error: 'Channel not found' })
    if (!isSuperAdmin(ctx) && channelRows[0].org_id !== ctx.orgId) {
      return res.status(403).json({ error: 'Cannot modify a channel from another organization' })
    }

    const { rows: userRows } = await pool.query('SELECT id, role, org_id FROM users WHERE id = $1', [user_id])
    const target = userRows[0]
    if (!target || !STAFF_ROLES.includes(target.role)) return res.status(404).json({ error: 'Staff user not found' })
    if (!isSuperAdmin(ctx) && target.org_id !== ctx.orgId) {
      return res.status(403).json({ error: 'Cannot add a user from another organization' })
    }

    await pool.query(
      `INSERT INTO staff_channel_members (channel_id, user_id) VALUES ($1, $2)
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [channelId, user_id],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// GET /api/staff-chat/channels/:id/messages
router.get('/channels/:id/messages', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const channelId = parseInt(req.params.id, 10)
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: 'Invalid channel id' })
    if (!(await isChannelMember(channelId, ctx.dbUserId, ctx))) {
      return res.status(403).json({ error: 'Not a member of this channel' })
    }

    const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)

    const { rows } = await pool.query(`
      SELECT m.*, u.first_name AS sender_name, u.last_name AS sender_last_name
      FROM staff_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.channel_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `, [channelId, limit, offset])
    rows.reverse()
    res.json({ messages: rows })
  } catch (err) { next(err) }
})

// POST /api/staff-chat/channels/:id/messages
router.post('/channels/:id/messages', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const channelId = parseInt(req.params.id, 10)
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: 'Invalid channel id' })
    if (!(await isChannelMember(channelId, ctx.dbUserId, ctx))) {
      return res.status(403).json({ error: 'Not a member of this channel' })
    }

    const { message_body = null, audio_url = null, attachment_url = null, attachment_name = null } = req.body
    const trimmedBody = message_body?.trim() || null
    if (!trimmedBody && !audio_url && !attachment_url) {
      return res.status(400).json({ error: 'message_body, audio, or attachment required' })
    }

    const { rows } = await pool.query(`
      INSERT INTO staff_messages (channel_id, sender_id, message_body, audio_url, attachment_url, attachment_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [channelId, ctx.dbUserId, trimmedBody, audio_url, attachment_url, attachment_name])
    const msg = rows[0]

    // Sender has implicitly "read" their own message
    await pool.query(
      `INSERT INTO staff_message_reads (message_id, user_id) VALUES ($1, $2)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [msg.id, ctx.dbUserId],
    )

    // Push notify other channel members — fire-and-forget
    pool.query(
      'SELECT user_id FROM staff_channel_members WHERE channel_id = $1 AND user_id != $2',
      [channelId, ctx.dbUserId],
    ).then(({ rows: members }) => {
      const preview = teamMessagePreview(trimmedBody, audio_url, attachment_url)
      for (const m of members) {
        notifyNewTeamMessage(m.user_id, preview, `/staff-chat?channel=${channelId}`).catch(() => {})
      }
    }).catch(() => {})

    res.status(201).json({ ...msg, sender_name: ctx.firstName })
  } catch (err) { next(err) }
})

// POST /api/staff-chat/channels/:id/messages/:msgId/pin — admin only, toggles
router.post('/channels/:id/messages/:msgId/pin', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    if (!isAdminRole(ctx.role)) return res.status(403).json({ error: 'Admin only' })
    const channelId = parseInt(req.params.id, 10)
    const msgId     = parseInt(req.params.msgId, 10)

    if (!(await channelInOrg(channelId, ctx))) {
      return res.status(403).json({ error: 'Cannot modify a channel from another organization' })
    }

    const { rows } = await pool.query(
      'SELECT is_pinned FROM staff_messages WHERE id = $1 AND channel_id = $2',
      [msgId, channelId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Message not found' })

    const nextPinned = !rows[0].is_pinned
    const { rows: updated } = await pool.query(`
      UPDATE staff_messages
      SET is_pinned = $1, pinned_by = $2, pinned_at = $3
      WHERE id = $4
      RETURNING *
    `, [nextPinned, nextPinned ? ctx.dbUserId : null, nextPinned ? new Date() : null, msgId])
    res.json(updated[0])
  } catch (err) { next(err) }
})

// POST /api/staff-chat/channels/:id/read — mark all messages in channel as read
router.post('/channels/:id/read', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const channelId = parseInt(req.params.id, 10)
    if (!(await isChannelMember(channelId, ctx.dbUserId, ctx))) {
      return res.status(403).json({ error: 'Not a member of this channel' })
    }
    await pool.query(`
      INSERT INTO staff_message_reads (message_id, user_id)
      SELECT id, $2 FROM staff_messages WHERE channel_id = $1
      ON CONFLICT (message_id, user_id) DO NOTHING
    `, [channelId, ctx.dbUserId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── DM routes ──────────────────────────────────────────────────────────────

// GET /api/staff-chat/dms — ALL staff users (except self), regardless of
// whether a DM thread already exists. last_message_*/unread come from LEFT-
// style correlated subqueries so a staff member with no message history yet
// still appears, with last_message_body/at = null and unread = 0.
router.get('/dms', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.role,
        (SELECT message_body FROM staff_direct_messages
          WHERE (sender_id = $1 AND recipient_id = u.id) OR (sender_id = u.id AND recipient_id = $1)
          ORDER BY created_at DESC LIMIT 1) AS last_message_body,
        (SELECT created_at FROM staff_direct_messages
          WHERE (sender_id = $1 AND recipient_id = u.id) OR (sender_id = u.id AND recipient_id = $1)
          ORDER BY created_at DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*)::int FROM staff_direct_messages
          WHERE sender_id = u.id AND recipient_id = $1 AND read_at IS NULL) AS unread
      FROM users u
      WHERE u.id != $1
        AND u.role = ANY($2::text[])
        AND (u.staff_status IS NULL OR u.staff_status != 'archived')
        AND u.org_id = $3
      ORDER BY u.first_name
    `, [ctx.dbUserId, STAFF_ROLES, ctx.orgId])
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/staff-chat/dms/:userId — thread with a specific staff user
router.get('/dms/:userId', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const otherId = parseInt(req.params.userId, 10)
    if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'Invalid user id' })
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)

    const { rows } = await pool.query(`
      SELECT dm.*, u.first_name AS sender_name, u.last_name AS sender_last_name
      FROM staff_direct_messages dm
      LEFT JOIN users u ON u.id = dm.sender_id
      WHERE (dm.sender_id = $1 AND dm.recipient_id = $2) OR (dm.sender_id = $2 AND dm.recipient_id = $1)
      ORDER BY dm.created_at DESC
      LIMIT $3
    `, [ctx.dbUserId, otherId, limit])
    rows.reverse()
    res.json({ messages: rows })
  } catch (err) { next(err) }
})

// POST /api/staff-chat/dms/:userId
router.post('/dms/:userId', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const recipientId = parseInt(req.params.userId, 10)
    if (!Number.isInteger(recipientId)) return res.status(400).json({ error: 'Invalid user id' })
    if (recipientId === ctx.dbUserId) return res.status(400).json({ error: 'Cannot message yourself' })

    const { rows: recipRows } = await pool.query('SELECT id, role, org_id FROM users WHERE id = $1', [recipientId])
    const recipient = recipRows[0]
    if (!recipient || !STAFF_ROLES.includes(recipient.role)) return res.status(404).json({ error: 'Recipient not found' })
    if (!isSuperAdmin(ctx) && recipient.org_id !== ctx.orgId) {
      return res.status(403).json({ error: 'Cannot message a user outside your organization' })
    }

    const { message_body = null, audio_url = null, attachment_url = null, attachment_name = null } = req.body
    const trimmedBody = message_body?.trim() || null
    if (!trimmedBody && !audio_url && !attachment_url) {
      return res.status(400).json({ error: 'message_body, audio, or attachment required' })
    }

    const { rows } = await pool.query(`
      INSERT INTO staff_direct_messages (sender_id, recipient_id, message_body, audio_url, attachment_url, attachment_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [ctx.dbUserId, recipientId, trimmedBody, audio_url, attachment_url, attachment_name])
    const msg = rows[0]

    notifyNewTeamMessage(
      recipientId,
      teamMessagePreview(trimmedBody, audio_url, attachment_url),
      `/staff-chat?dm=${ctx.dbUserId}`,
    ).catch(() => {})

    res.status(201).json({ ...msg, sender_name: ctx.firstName })
  } catch (err) { next(err) }
})

// POST /api/staff-chat/dms/:userId/pin/:msgId — sender or admin may toggle
router.post('/dms/:userId/pin/:msgId', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const msgId = parseInt(req.params.msgId, 10)
    if (!Number.isInteger(msgId)) return res.status(400).json({ error: 'Invalid message id' })

    const { rows } = await pool.query(
      'SELECT sender_id, recipient_id, is_pinned FROM staff_direct_messages WHERE id = $1',
      [msgId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Message not found' })
    const msg = rows[0]
    if (msg.sender_id !== ctx.dbUserId && msg.recipient_id !== ctx.dbUserId) {
      return res.status(403).json({ error: 'Not part of this conversation' })
    }
    if (msg.sender_id !== ctx.dbUserId && !isAdminRole(ctx.role)) {
      return res.status(403).json({ error: 'Only the sender or an admin can pin this message' })
    }

    const nextPinned = !msg.is_pinned
    const { rows: updated } = await pool.query(`
      UPDATE staff_direct_messages
      SET is_pinned = $1, pinned_by = $2, pinned_at = $3
      WHERE id = $4
      RETURNING *
    `, [nextPinned, nextPinned ? ctx.dbUserId : null, nextPinned ? new Date() : null, msgId])
    res.json(updated[0])
  } catch (err) { next(err) }
})

// POST /api/staff-chat/dms/:userId/read — mark all DMs from this user as read
router.post('/dms/:userId/read', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const otherId = parseInt(req.params.userId, 10)
    if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'Invalid user id' })
    await pool.query(`
      UPDATE staff_direct_messages SET read_at = NOW()
      WHERE sender_id = $1 AND recipient_id = $2 AND read_at IS NULL
    `, [otherId, ctx.dbUserId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Unread ─────────────────────────────────────────────────────────────────

// GET /api/staff-chat/unread — total unread channel messages + DMs for current user
router.get('/unread', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const { rows: [chanRow] } = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM staff_messages sm
      JOIN staff_channel_members cm ON cm.channel_id = sm.channel_id AND cm.user_id = $1
      WHERE sm.sender_id != $1
        AND NOT EXISTS (
          SELECT 1 FROM staff_message_reads r WHERE r.message_id = sm.id AND r.user_id = $1
        )
    `, [ctx.dbUserId])
    const { rows: [dmRow] } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM staff_direct_messages WHERE recipient_id = $1 AND read_at IS NULL',
      [ctx.dbUserId],
    )
    res.json({ total: (chanRow?.cnt ?? 0) + (dmRow?.cnt ?? 0) })
  } catch (err) { next(err) }
})

// ─── Staff list ─────────────────────────────────────────────────────────────

// GET /api/staff-chat/staff-users
router.get('/staff-users', async (req, res, next) => {
  try {
    const ctx = getCtx(req)
    const { rows } = await pool.query(`
      SELECT id, first_name, last_name, role
      FROM users
      WHERE role = ANY($1::text[])
        AND (staff_status IS NULL OR staff_status != 'archived')
        AND ($2::boolean OR org_id = $3)
      ORDER BY first_name
    `, [STAFF_ROLES, isSuperAdmin(ctx), ctx.orgId])
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Uploads ────────────────────────────────────────────────────────────────

// POST /api/staff-chat/upload-audio
router.post('/upload-audio', uploadAudioMulter.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file received' })
    const result = await uploadAudioToCloudinary(req.file.buffer)
    res.json({ url: result.secure_url })
  } catch (err) { next(err) }
})

// POST /api/staff-chat/upload-attachment
router.post('/upload-attachment', uploadAttachmentMulter.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' })
    const result = await uploadAttachmentToCloudinary(req.file.buffer, req.file.originalname)
    res.json({ url: result.secure_url, original_name: req.file.originalname })
  } catch (err) { next(err) }
})

export default router
