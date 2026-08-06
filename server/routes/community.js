import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail } from '../db.js'
import { notifyNewCommunityPost } from '../services/pushService.js'

const router = Router()

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping. Same pattern as coachAdmin.js / messages.js (commits bf7addf, dbc3f60).
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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
      { folder: 'metacoach/community' },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkAdmin(req, res) {
  const userId = req.effectiveClerkUserId
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
  if (rows[0]?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' })
    return null
  }
  return dbUserId
}

// Verifies the post belongs to the requester's org before a sub-resource (likers,
// reactions, comments, poll) is returned. 404 (not 403) so cross-org callers can't
// distinguish "not your org" from "doesn't exist".
//
// No super-admin bypass here, deliberately — this gates reads of another org's
// content (who liked/reacted, comment threads, poll results), not a moderation
// action. The platform super admin should only read their own org's community,
// same as every other org. (The mutation-side bypasses further down this file —
// delete post/comment, pin — are intentional moderation actions and untouched.)
async function checkPostOrgAccess(req, res, postId) {
  const ctx = { orgId: req.orgId, email: req.internalUser?.email }
  const { rows } = await pool.query('SELECT org_id FROM community_posts WHERE id = $1', [postId])
  if (!rows.length || rows[0].org_id !== ctx.orgId) {
    res.status(404).json({ error: 'Not found' })
    return false
  }
  return true
}

// Same as checkPostOrgAccess but for a comment, via its parent post's org.
// Also no super-admin bypass — see note above.
async function checkCommentOrgAccess(req, res, commentId) {
  const ctx = { orgId: req.orgId, email: req.internalUser?.email }
  const { rows } = await pool.query(
    `SELECT cp.org_id FROM post_comments pc JOIN community_posts cp ON cp.id = pc.post_id WHERE pc.id = $1`,
    [commentId],
  )
  if (!rows.length || rows[0].org_id !== ctx.orgId) {
    res.status(404).json({ error: 'Not found' })
    return false
  }
  return true
}

function normalizeChannel(_ct) {
  return 'vip'  // one shared community for all coaching types
}

async function getUserContext(userId) {
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT role, coaching_type FROM users WHERE id = $1', [dbUserId])
  const row = rows[0] ?? {}
  const isStaff = row.role === 'admin' || row.role === 'coach'
  const channel = normalizeChannel(row.coaching_type)
  return { dbUserId, isStaff, channel, role: row.role, coaching_type: row.coaching_type }
}


// Block Basic-tier clients from all community endpoints.
// Staff/admin are always allowed through.
router.use(async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    if (!userId) return next() // unauthenticated — let requireAuth() handle it per-route
    const dbUserId = await getOrCreateUser(userId)
    const { rows } = await pool.query('SELECT role, coaching_type FROM users WHERE id = $1', [dbUserId])
    const row = rows[0] ?? {}
    const isStaff = row.role === 'admin' || row.role === 'coach'
    if (!isStaff && row.coaching_type === 'basic') {
      return res.status(403).json({ error: 'Community is not available on your plan.' })
    }
    next()
  } catch (err) { next(err) }
})

// Whether a client (non-staff) may post into this category. Backed by
// community_groups so org admins can add/rename/retire categories without a
// code deploy — 'private' groups are staff-only (e.g. an Announcements group).
async function isClientPostableCategory(orgId, category) {
  const { rows } = await pool.query(
    `SELECT 1 FROM community_groups WHERE org_id = $1 AND name = $2 AND is_active = TRUE AND type = 'public' LIMIT 1`,
    [orgId, category],
  )
  return rows.length > 0
}

function isAdminRole(role) {
  return role === 'admin' || role === 'account_owner'
}

// Membership gate for group-scoped content. Super admin (ADMIN_EMAILS) and
// org admins always pass — an org admin has no group_members row (see
// GET /my-groups) but still needs to read/post into every group in their org.
// Reuses isAdminEmail instead of re-parsing process.env so the allowlist
// can't drift between the two.
async function isGroupMember(groupId, userId, orgId) {
  const { rows } = await pool.query('SELECT email, role FROM users WHERE id = $1', [userId])
  if (isAdminEmail(rows[0]?.email)) return true
  if (rows[0]?.role === 'admin') return true

  const { rows: member } = await pool.query(
    `SELECT gm.id
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1
       AND gm.user_id = $2
       AND gm.org_id = $3
       AND u.client_status = 'active'`,
    [groupId, userId, orgId],
  )
  return member.length > 0
}

// Post-level gate used by every sub-resource route (likes, reactions, comments,
// polls). Main-feed posts (group_id IS NULL) stay open to the whole org exactly
// as before; only group posts require membership. Returns true when the caller
// may proceed, and has already sent the 403 when it returns false.
async function checkPostGroupAccess(req, res, postId, dbUserId) {
  const { rows } = await pool.query('SELECT group_id FROM community_posts WHERE id = $1', [postId])
  const groupId = rows[0]?.group_id
  if (!groupId) return true
  if (await isGroupMember(groupId, dbUserId, req.orgId)) return true
  res.status(403).json({ error: 'Not a member of this group' })
  return false
}

// Same gate, reached via a comment's parent post.
async function checkCommentGroupAccess(req, res, commentId, dbUserId) {
  const { rows } = await pool.query(
    `SELECT cp.group_id FROM post_comments pc JOIN community_posts cp ON cp.id = pc.post_id WHERE pc.id = $1`,
    [commentId],
  )
  const groupId = rows[0]?.group_id
  if (!groupId) return true
  if (await isGroupMember(groupId, dbUserId, req.orgId)) return true
  res.status(403).json({ error: 'Not a member of this group' })
  return false
}

// Org admin/owner, or the platform super admin (writes still land in
// req.orgId only — see isSuperAdmin above). Mirrors isOrgOwnerOrAdmin in
// server/routes/organizations.js.
async function isOrgOwnerOrAdmin(req) {
  const u = req.internalUser
  if (!u) return false
  if (isSuperAdmin({ email: u.email })) return true
  if (isAdminRole(u.role)) return true
  const { rows } = await pool.query('SELECT owner_user_id FROM organizations WHERE id = $1', [req.orgId])
  return rows.length > 0 && rows[0].owner_user_id === u.id
}

async function requireOrgAdminOrOwner(req, res) {
  if (!await isOrgOwnerOrAdmin(req)) {
    res.status(403).json({ error: 'Admin only' })
    return false
  }
  return true
}

// orgId scopes the @mention lookup to the poster's own org — without it, a name
// match in a different org would both leak that user's existence and misdirect
// a notification cross-tenant.
// groupId (when the post lives in a group) further restricts matches to that
// group's members — otherwise a mention would notify someone who then gets a
// 403 opening the post, and would leak that the post exists at all.
async function createMentionNotifications(content, postId, fromUserId, orgId, groupId = null) {
  const names = [...new Set((content.match(/(?<!\w)@([A-Za-z]\w*)/g) ?? []).map(m => m.slice(1)))]
  const memberFilter = groupId
    ? ` AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = users.id AND gm.group_id = $4)`
    : ''
  for (const name of names) {
    try {
      const { rows } = await pool.query(
        `SELECT id FROM users WHERE first_name ILIKE $1 AND id != $2 AND org_id = $3${memberFilter} LIMIT 1`,
        groupId ? [name, fromUserId, orgId, groupId] : [name, fromUserId, orgId],
      )
      if (rows.length) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, post_id, from_user_id, org_id) VALUES ($1, 'mention', $2, $3, $4)`,
          [rows[0].id, postId, fromUserId, orgId],
        )
      }
    } catch {}
  }
}

// In-app badge notification for clients when a coach/admin creates a new community post.
// Never fires for client-authored posts — only notifies about the other clients' own
// mentions/comments, not every new post from peers.
async function createNewPostNotifications(postId, fromUserId, orgId) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE role = 'client' AND COALESCE(coaching_type, '') != 'basic' AND id != $1 AND org_id = $2`,
      [fromUserId, orgId],
    )
    for (const u of rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, post_id, from_user_id, org_id) VALUES ($1, 'new_post', $2, $3, $4)`,
        [u.id, postId, fromUserId, orgId],
      ).catch(() => {})
    }
  } catch {}
}
// Group posts notify only that group's members — the whole point of a private
// feed is that non-members never learn it was posted in. Direction mirrors the
// main feed's intent: a client's post reaches the staff in the group, a staff
// post reaches the group's clients. Handles both the in-app badge row and the
// push, since the audience query is the same for both.
async function notifyGroupPost({ postId, groupId, authorUserId, authorIsStaff, orgId }) {
  try {
    // Admins (admin, account_owner) deliberately have no group_members row
    // (see db.js:2065-2069, community.js:1345) — they administer every group
    // without being a "member" of any, so the members-picker can exclude them.
    // That means a plain membership JOIN can never surface them: union them in
    // by role, org-wide, independent of group_members. Coach/staff still need
    // an actual membership row since they aren't auto-admins of every group.
    const { rows } = authorIsStaff
      ? await pool.query(
          `SELECT u.id
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
           WHERE gm.group_id = $1 AND gm.org_id = $2 AND u.id != $3
             AND u.role = 'client' AND COALESCE(u.coaching_type, '') != 'basic'`,
          [groupId, orgId, authorUserId],
        )
      : await pool.query(
          `SELECT gm.user_id AS id
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
           WHERE gm.group_id = $1 AND gm.org_id = $2 AND u.id != $3
             AND u.role IN ('coach', 'staff')
           UNION
           SELECT u.id
           FROM users u
           WHERE u.org_id = $2 AND u.id != $3
             AND u.role IN ('admin', 'account_owner')`,
          [groupId, orgId, authorUserId],
        )

    for (const u of rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, post_id, from_user_id, org_id) VALUES ($1, 'new_post', $2, $3, $4)`,
        [u.id, postId, authorUserId, orgId],
      ).catch(() => {})
      await notifyNewCommunityPost(u.id, postId).catch(() => {})
    }
  } catch (err) {
    console.warn('[push] notifyGroupPost error:', err.message)
  }
}

async function notifyTopLevelCommunityPost({ authorUserId, authorIsStaff, postChannel, postId, orgId }) {
  try {
    if (authorIsStaff) {
      if (postChannel !== 'vip') {
        console.log('[push] community post skipped for clients - channel=%s has no client-visible audience', postChannel)
        return
      }
      const { rows: clients } = await pool.query(
        `SELECT id
         FROM users
         WHERE role = 'client'
           AND COALESCE(coaching_type, '') != 'basic'
           AND id != $1
           AND org_id = $2`,
        [authorUserId, orgId],
      )
      for (const client of clients) await notifyNewCommunityPost(client.id, postId).catch(() => {})
      return
    }

    const { rows: [author] } = await pool.query(
      `SELECT assigned_coach_id AS coach_id FROM users WHERE id = $1`,
      [authorUserId],
    )
    if (author?.coach_id) {
      await notifyNewCommunityPost(author.coach_id, postId).catch(() => {})
      return
    }

    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND id != $1 AND org_id = $2`,
      [authorUserId, orgId],
    )
    for (const admin of admins) await notifyNewCommunityPost(admin.id, postId).catch(() => {})
  } catch (err) {
    console.warn('[push] notifyTopLevelCommunityPost error:', err.message)
  }
}
// -- Delete -------------------------------------------------------------------

router.delete('/posts/:id', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const { dbUserId, isStaff } = await getUserContext(userId)
    const postId = parseInt(req.params.id, 10)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    if (!isStaff) {
      // clients can only delete their own posts
      const { rows } = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [postId])
      if (!rows[0]) return res.status(404).json({ error: 'Not found' })
      if (rows[0].user_id !== dbUserId) return res.status(403).json({ error: 'Forbidden' })
      await pool.query('DELETE FROM community_posts WHERE id = $1', [postId])
    } else {
      // Staff bypass — but only within their own org unless true super admin.
      // Previously any org's staff could delete any other org's post.
      const bypassOrg = isSuperAdmin(ctx)
      const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
      const { rowCount } = await pool.query(
        `DELETE FROM community_posts WHERE id = $1${orgFilter}`,
        bypassOrg ? [postId] : [postId, ctx.orgId],
      )
      if (!rowCount) return res.status(404).json({ error: 'Not found' })
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})
router.delete('/comments/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await checkAdmin(req, res) === null) return
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    const { rowCount } = await pool.query(
      `DELETE FROM post_comments WHERE id = $1${orgFilter}`,
      bypassOrg ? [parseInt(req.params.id, 10)] : [parseInt(req.params.id, 10), ctx.orgId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── Leaderboard ───────────────────────────────────────────────────────────────

router.get('/leaderboard', requireAuth(), async (req, res, next) => {
  try {
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    // Always org-scoped, super admin included. This is a member-facing surface,
    // not a console — an unscoped leaderboard blends every tenant's clients into
    // one ranked list with no org label.
    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, COUNT(DISTINCT DATE(m.logged_at))::int AS streak
      FROM users u
      JOIN meals m ON m.user_id = u.id
      WHERE m.logged_at >= DATE_TRUNC('week', NOW()) AND u.org_id = $1
      GROUP BY u.id, u.first_name
      ORDER BY streak DESC, u.first_name ASC
      LIMIT 10
    `, [ctx.orgId])
    res.json(rows)
  } catch (err) { next(err) }
})

// ── Members directory ─────────────────────────────────────────────────────────

router.get('/members', requireAuth(), async (req, res, next) => {
  try {
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    // Always org-scoped, super admin included — see the leaderboard note above.
    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, u.identity_anchors, u.created_at,
             ARRAY_REMOVE(
               ARRAY_AGG(DISTINCT CASE
                 WHEN m.logged_at >= CURRENT_DATE - INTERVAL '365 days'
                 THEN DATE(m.logged_at)::text
               END), NULL
             ) AS log_dates
      FROM users u
      LEFT JOIN meals m ON m.user_id = u.id
      WHERE u.onboarding_complete = TRUE AND u.org_id = $1
      GROUP BY u.id, u.first_name, u.identity_anchors, u.created_at
      ORDER BY u.first_name ASC NULLS LAST
    `, [ctx.orgId])

    function computeStreak(logDates) {
      if (!logDates?.length) return 0
      const days = new Set(logDates)
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const yday  = new Date(today); yday.setDate(yday.getDate() - 1)
      const todayStr = today.toISOString().slice(0, 10)
      const ydayStr  = yday.toISOString().slice(0, 10)
      if (!days.has(todayStr) && !days.has(ydayStr)) return 0
      const start = days.has(todayStr) ? today : yday
      let streak = 0
      for (let i = 0; i < 365; i++) {
        const d = new Date(start); d.setDate(d.getDate() - i)
        if (days.has(d.toISOString().slice(0, 10))) streak++
        else break
      }
      return streak
    }

    res.json(rows.map(u => ({
      id:               u.id,
      first_name:       u.first_name,
      identity_anchors: u.identity_anchors ?? [],
      created_at:       u.created_at,
      streak:           computeStreak(u.log_dates),
    })))
  } catch (err) { next(err) }
})

// ── Notifications ─────────────────────────────────────────────────────────────

router.get('/notifications/count', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND cp.org_id = $2`
    // Single last_read_at cursor per user, replacing per-notification-row counting.
    // NULL cursor falls back to the user's own created_at (see db.js migration note)
    // so existing users aren't shown their whole posting history as unread.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM community_posts cp
       WHERE cp.user_id != $1
         AND cp.created_at > (SELECT COALESCE(community_last_read_at, created_at) FROM users WHERE id = $1)${orgFilter}`,
      bypassOrg ? [dbUserId] : [dbUserId, ctx.orgId],
    )
    res.json({ count: rows[0].count })
  } catch (err) { next(err) }
})

router.post('/notifications/mark-community-read', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    await pool.query('UPDATE users SET community_last_read_at = NOW() WHERE id = $1', [dbUserId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.post('/notifications/read', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    await pool.query(
      `UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE${orgFilter}`,
      bypassOrg ? [dbUserId] : [dbUserId, ctx.orgId],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// Individual unread community notifications for the sidebar bell dropdown — the
// count endpoint above only gives a number, this gives enough per-row context
// (post_id + a rendered label) to deep-link to /community?post_id=X. Scoped to
// the post-bearing notification types; other types (e.g. coachAdmin's
// title/message-based rows) share this table but have no post to link to.
router.get('/notifications', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND n.org_id = $2`
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.post_id, n.created_at,
              u.first_name AS from_first_name,
              cp.content AS post_content
       FROM notifications n
       LEFT JOIN users u ON u.id = n.from_user_id
       LEFT JOIN community_posts cp ON cp.id = n.post_id
       WHERE n.user_id = $1 AND n.read = FALSE
         AND n.post_id IS NOT NULL AND n.type IN ('mention', 'new_post', 'comment')${orgFilter}
       ORDER BY n.created_at DESC
       LIMIT 20`,
      bypassOrg ? [dbUserId] : [dbUserId, ctx.orgId],
    )
    const notifications = rows.map(r => {
      const from = r.from_first_name ?? 'Someone'
      const verb = r.type === 'mention'
        ? 'mentioned you in a post'
        : r.type === 'comment'
          ? 'commented on your post'
          : 'posted in Community'
      const raw = (r.post_content ?? '').trim()
      const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
      return {
        id:         r.id,
        type:       r.type,
        post_id:    r.post_id,
        created_at: r.created_at,
        label:      `${from} ${verb}${snippet ? `: "${snippet}"` : ''}`,
      }
    })
    res.json({ notifications })
  } catch (err) { next(err) }
})

// ── Posts ─────────────────────────────────────────────────────────────────────

router.get('/posts', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const { dbUserId, isStaff, channel } = await getUserContext(userId)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }

    // Clients always see their own channel; staff filter by ?channel= param when provided
    const requested   = ['vip', 'ai'].includes(req.query.channel) ? req.query.channel : null
    const filterChannel = isStaff ? requested : channel   // null = no filter (staff, all channels)

    const limit = Math.min(parseInt(req.query.limit) || 30, 100)
    const beforeId = req.query.before_id ? parseInt(req.query.before_id) : null

    // The org filter is unconditional — super admin included. The feed is a
    // member-facing surface; an unscoped feed interleaves every tenant's posts
    // into one timeline. Moderation actions (delete/pin/edit) keep their
    // super-admin bypass further down this file.
    // Group feeds are membership-scoped. No group_id (or the literal 'main')
    // means the main feed — every ungrouped post in the org — which keeps this
    // endpoint's shape for callers that predate groups.
    const rawGroup = req.query.group_id
    let groupId = null
    if (rawGroup !== undefined && rawGroup !== '' && rawGroup !== 'main') {
      groupId = parseInt(rawGroup, 10)
      if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group_id' })
      if (!await isGroupMember(groupId, dbUserId, ctx.orgId)) {
        return res.status(403).json({ error: 'Not a member of this group' })
      }
    }

    const qParams = [dbUserId, filterChannel, ctx.orgId]
    let extraWhere = ' AND cp.org_id = $3'
    if (groupId === null) {
      extraWhere += ' AND cp.group_id IS NULL'
    } else {
      qParams.push(groupId)
      extraWhere += ` AND cp.group_id = $${qParams.length}`
    }
    if (beforeId) {
      qParams.push(beforeId)
      extraWhere += ` AND cp.id < $${qParams.length}`
    }
    qParams.push(limit + 1)

    const { rows } = await pool.query(
      `SELECT
         cp.id,
         cp.user_id,
         cp.content,
         cp.photo_url,
         cp.created_at,
         cp.category,
         cp.channel,
         cp.pinned,
         cp.group_id,
         u.first_name,
         COUNT(DISTINCT pl.id)::int AS like_count,
         COUNT(DISTINCT pc.id)::int AS comment_count,
         EXISTS(
           SELECT 1 FROM post_likes WHERE post_id = cp.id AND user_id = $1
         ) AS liked_by_me,
         (
           SELECT COUNT(*) >= 5
           FROM post_reactions pr2
           WHERE pr2.post_id = cp.id
             AND pr2.created_at > NOW() - INTERVAL '24 hours'
         ) AS hot,
         EXISTS(SELECT 1 FROM community_polls WHERE post_id = cp.id) AS has_poll
       FROM community_posts cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN post_likes    pl ON pl.post_id = cp.id
       LEFT JOIN post_comments pc ON pc.post_id = cp.id
       WHERE ($2::text IS NULL OR cp.channel = $2)${extraWhere}
       GROUP BY cp.id, u.first_name
       ORDER BY cp.pinned DESC, cp.created_at DESC
       LIMIT $${qParams.length}`,
      qParams,
    )

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    res.json({
      posts: rows,
      hasMore,
      nextBeforeId: hasMore ? rows[rows.length - 1].id : null,
    })
  } catch (err) { next(err) }
})

// GET /api/community/posts/:id/group — resolves which feed a post lives in, for
// push-notification deep links (/community?post_id=X). The client needs this
// before it knows which group_id to pass to GET /posts, so it can't reuse the
// membership-gated sub-resource pattern here — this route is deliberately
// org-scoped only, no group membership check. It leaks nothing a non-member
// doesn't already learn from a 403 on the group feed itself, and the frontend
// still can't read the post's content without passing that membership check.
router.get('/posts/:id/group', requireAuth(), async (req, res, next) => {
  try {
    const postId = parseInt(req.params.id, 10)
    const { rows } = await pool.query(
      'SELECT id, group_id FROM community_posts WHERE id = $1 AND org_id = $2',
      [postId, req.orgId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json({ post_id: rows[0].id, group_id: rows[0].group_id })
  } catch (err) { next(err) }
})

router.post('/posts', requireAuth(), upload.single('photo'), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const { dbUserId, isStaff, channel } = await getUserContext(userId)
    const content   = req.body?.content
    let   category  = req.body?.category ?? 'General Discussion'

    if (!content?.trim()) return res.status(400).json({ error: 'Content required' })

    // A group post is membership-gated and takes its category label from the
    // group itself, so the label can't drift from the group the post lives in.
    // No group_id => main feed (group_id NULL) and the category rules below.
    const rawGroup = req.body?.group_id
    let groupId = null
    if (rawGroup !== undefined && rawGroup !== null && rawGroup !== '' && rawGroup !== 'main') {
      groupId = parseInt(rawGroup, 10)
      if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group_id' })

      const { rows: g } = await pool.query(
        'SELECT name, org_id, is_active FROM community_groups WHERE id = $1',
        [groupId],
      )
      if (!g.length || g[0].org_id !== req.orgId) return res.status(404).json({ error: 'Not found' })
      if (!g[0].is_active) return res.status(400).json({ error: 'This group is no longer active.' })
      if (!await isGroupMember(groupId, dbUserId, req.orgId)) {
        return res.status(403).json({ error: 'Not a member of this group' })
      }
      category = g[0].name
    } else {
      // No group specified — every post must belong to a group, so fall back
      // to the org's first active group rather than leaving group_id NULL.
      const { rows: defaultGroup } = await pool.query(
        `SELECT id, name FROM community_groups
         WHERE org_id = $1 AND is_active = TRUE
         ORDER BY display_order ASC, id ASC LIMIT 1`,
        [req.orgId],
      )
      if (defaultGroup.length) {
        groupId  = defaultGroup[0].id
        category = defaultGroup[0].name
      } else if (!isStaff && !(await isClientPostableCategory(req.orgId, category))) {
        // Clients may only post into an active, public group in their own org
        category = 'General Discussion'
      }
    }

    // Clients always post into their own channel; staff may specify a channel in body
    const postChannel = isStaff
      ? (['vip', 'ai'].includes(req.body?.channel) ? req.body.channel : channel)
      : channel

    let photo_url = null
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer)
      photo_url = result.secure_url
    }

    const { rows } = await pool.query(
      `INSERT INTO community_posts (user_id, content, photo_url, category, channel, org_id, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, content, photo_url, created_at, category, channel, pinned, group_id`,
      [dbUserId, content.trim(), photo_url, category, postChannel, req.orgId, groupId],
    )
    const post = rows[0]

    // Create poll if included
    const pollQuestion = req.body?.poll_question
    if (pollQuestion?.trim()) {
      try {
        const pollOptions = JSON.parse(req.body?.poll_options ?? '[]')
        const validOptions = pollOptions.filter(o => o?.trim()).slice(0, 4)
        if (validOptions.length >= 2) {
          const { rows: pollRows } = await pool.query(
            'INSERT INTO community_polls (post_id, question, org_id) VALUES ($1, $2, $3) RETURNING id',
            [post.id, pollQuestion.trim(), req.orgId],
          )
          const pollId = pollRows[0].id
          for (let i = 0; i < validOptions.length; i++) {
            await pool.query(
              'INSERT INTO poll_options (poll_id, option_text, display_order, org_id) VALUES ($1, $2, $3, $4)',
              [pollId, validOptions[i].trim(), i, req.orgId],
            )
          }
        }
      } catch {}
    }

    await createMentionNotifications(content.trim(), post.id, dbUserId, req.orgId, groupId)

    if (groupId) {
      // Group post: one membership-scoped pass covers both badge and push.
      notifyGroupPost({
        postId: post.id,
        groupId,
        authorUserId: dbUserId,
        authorIsStaff: isStaff,
        orgId: req.orgId,
      }).catch(() => {})
    } else {
      // Main feed — unchanged.
      // Staff post -> clients get an in-app badge notification too (fire-and-forget)
      if (isStaff) createNewPostNotifications(post.id, dbUserId, req.orgId).catch(() => {})

      // Push only for top-level post creation. Comments intentionally do not dispatch push.
      notifyTopLevelCommunityPost({
        authorUserId: dbUserId,
        authorIsStaff: isStaff,
        postChannel,
        postId: post.id,
        orgId: req.orgId,
      }).catch(() => {})
    }
    const { rows: userRows } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1', [dbUserId],
    )

    res.status(201).json({
      ...post,
      first_name:    userRows[0]?.first_name ?? null,
      like_count:    0,
      comment_count: 0,
      liked_by_me:   false,
      hot:           false,
      has_poll:      !!(pollQuestion?.trim() && JSON.parse(req.body?.poll_options ?? '[]').filter(o => o?.trim()).length >= 2),
    })
  } catch (err) { next(err) }
})

// PATCH /api/community/posts/:id  (own post or admin)
router.patch('/posts/:id', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    const { content, category } = req.body

    const { rows: cur } = await pool.query(
      'SELECT user_id FROM community_posts WHERE id = $1', [postId],
    )
    if (!cur[0]) return res.status(404).json({ error: 'Not found' })

    const { rows: roleRow } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const isAdmin = roleRow[0]?.role === 'admin'
    if (cur[0].user_id !== dbUserId && !isAdmin) {
      return res.status(403).json({ error: 'Not your post' })
    }

    // Own-post edits are already ownership-scoped above; the admin-bypass path needs
    // its own org boundary — otherwise any org's admin could edit any other org's post.
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = cur[0].user_id === dbUserId || isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $4`
    const { rows } = await pool.query(
      `UPDATE community_posts
       SET content  = COALESCE($1, content),
           category = COALESCE($2, category)
       WHERE id = $3${orgFilter}
       RETURNING id, content, category`,
      bypassOrg ? [content ?? null, category ?? null, postId] : [content ?? null, category ?? null, postId, ctx.orgId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/community/posts/:id/pin  (admin)
router.post('/posts/:id/pin', requireAuth(), async (req, res, next) => {
  try {
    if (await checkAdmin(req, res) === null) return
    const postId = parseInt(req.params.id, 10)
    const ctx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $1`
    const { rows: cur } = await pool.query(
      `SELECT pinned FROM community_posts WHERE id = $1${bypassOrg ? '' : ' AND org_id = $2'}`,
      bypassOrg ? [postId] : [postId, ctx.orgId],
    )
    if (!cur.length) return res.status(404).json({ error: 'Not found' })
    const willPin = !cur[0]?.pinned
    if (willPin) {
      // Unpinning is scoped to this org only — pinning a post in one org must not
      // unpin a different org's pinned post.
      await pool.query(`UPDATE community_posts SET pinned = FALSE WHERE pinned = TRUE${orgFilter}`, bypassOrg ? [] : [ctx.orgId])
      await pool.query(`UPDATE community_posts SET pinned = TRUE WHERE id = $1`, [postId])
    } else {
      await pool.query('UPDATE community_posts SET pinned = FALSE WHERE id = $1', [postId])
    }
    res.json({ pinned: willPin })
  } catch (err) { next(err) }
})

// POST /api/community/posts/:id/like  (toggle)
router.post('/posts/:id/like', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, dbUserId) === false) return

    const { rows: existing } = await pool.query(
      'SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2',
      [postId, dbUserId],
    )

    let liked
    if (existing.length > 0) {
      await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, dbUserId])
      liked = false
    } else {
      await pool.query('INSERT INTO post_likes (post_id, user_id, org_id) VALUES ($1, $2, $3)', [postId, dbUserId, req.orgId])
      liked = true
    }

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS like_count FROM post_likes WHERE post_id = $1', [postId],
    )
    res.json({ liked, like_count: rows[0].like_count })
  } catch (err) { next(err) }
})

// GET /api/community/posts/:id/likers — who liked this post, most recent first.
// Visible to any community member regardless of role — names only, no profile data.
router.get('/posts/:id/likers', requireAuth(), async (req, res, next) => {
  try {
    const postId = parseInt(req.params.id, 10)
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, await getOrCreateUser(req.effectiveClerkUserId)) === false) return
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name
       FROM post_likes pl
       JOIN users u ON u.id = pl.user_id
       WHERE pl.post_id = $1
       ORDER BY pl.created_at DESC`,
      [postId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET/POST /api/community/posts/:id/reactions
router.get('/posts/:id/reactions', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, dbUserId) === false) return

    const { rows } = await pool.query(
      `SELECT
         COUNT(CASE WHEN reaction_type = 'like'  THEN 1 END)::int AS "like",
         COUNT(CASE WHEN reaction_type = 'love'  THEN 1 END)::int AS love,
         COUNT(CASE WHEN reaction_type = 'laugh' THEN 1 END)::int AS laugh,
         COUNT(CASE WHEN reaction_type = 'care'  THEN 1 END)::int AS care,
         ARRAY_REMOVE(ARRAY_AGG(CASE WHEN user_id = $2 THEN reaction_type END), NULL) AS "userReactions"
       FROM post_reactions WHERE post_id = $1`,
      [postId, dbUserId],
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.post('/posts/:id/reactions', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    const { reaction_type } = req.body

    if (!['like', 'love', 'laugh', 'care'].includes(reaction_type)) {
      return res.status(400).json({ error: 'Invalid reaction_type' })
    }
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, dbUserId) === false) return

    const { rows: existing } = await pool.query(
      'SELECT id FROM post_reactions WHERE post_id = $1 AND user_id = $2 AND reaction_type = $3',
      [postId, dbUserId, reaction_type],
    )

    let active
    if (existing.length > 0) {
      await pool.query(
        'DELETE FROM post_reactions WHERE post_id = $1 AND user_id = $2 AND reaction_type = $3',
        [postId, dbUserId, reaction_type],
      )
      active = false
    } else {
      await pool.query(
        'INSERT INTO post_reactions (post_id, user_id, reaction_type, org_id) VALUES ($1, $2, $3, $4)',
        [postId, dbUserId, reaction_type, req.orgId],
      )
      active = true
    }

    const { rows } = await pool.query(
      `SELECT
         COUNT(CASE WHEN reaction_type = 'like'  THEN 1 END)::int AS like_count,
         COUNT(CASE WHEN reaction_type = 'love'  THEN 1 END)::int AS love_count,
         COUNT(CASE WHEN reaction_type = 'laugh' THEN 1 END)::int AS laugh_count,
         COUNT(CASE WHEN reaction_type = 'care'  THEN 1 END)::int AS care_count
       FROM post_reactions WHERE post_id = $1`,
      [postId],
    )
    res.json({ reaction_type, active, ...rows[0] })
  } catch (err) { next(err) }
})

// GET /api/community/posts/:id/reactors — who reacted to this post, grouped by reaction_type.
// Visible to any community member regardless of role — names only, no profile data.
router.get('/posts/:id/reactors', requireAuth(), async (req, res, next) => {
  try {
    const postId = parseInt(req.params.id, 10)
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, await getOrCreateUser(req.effectiveClerkUserId)) === false) return
    const { rows } = await pool.query(
      `SELECT pr.reaction_type, u.id, u.first_name, u.last_name
       FROM post_reactions pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.post_id = $1
       ORDER BY pr.created_at DESC`,
      [postId],
    )
    const grouped = {}
    for (const { reaction_type, id, first_name, last_name } of rows) {
      (grouped[reaction_type] ??= []).push({ id, first_name, last_name })
    }
    res.json(grouped)
  } catch (err) { next(err) }
})

// GET/POST /api/community/posts/:id/comments
//
// Comments come back as a FLAT list carrying parent_comment_id (NULL = top-level),
// not server-nested — the client groups replies under their parent. Chosen over a
// nested shape because it leaves the existing reaction-aggregation query and the
// client's comment_count/append logic untouched.
//
// ORDER BY COALESCE(parent_comment_id, id) keeps each reply adjacent to its parent,
// so the LIMIT 200 truncates whole threads rather than orphaning replies from
// parents that fell outside the window.
router.get('/posts/:id/comments', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, dbUserId) === false) return

    const { rows } = await pool.query(
      `SELECT pc.id, pc.parent_comment_id, pc.content, pc.created_at, u.first_name,
              COUNT(CASE WHEN cr.reaction_type = 'like'  THEN 1 END)::int  AS like_count,
              COUNT(CASE WHEN cr.reaction_type = 'love'  THEN 1 END)::int  AS love_count,
              COUNT(CASE WHEN cr.reaction_type = 'laugh' THEN 1 END)::int  AS laugh_count,
              COALESCE(BOOL_OR(cr.reaction_type = 'like'  AND cr.user_id = $2), false) AS my_like,
              COALESCE(BOOL_OR(cr.reaction_type = 'love'  AND cr.user_id = $2), false) AS my_love,
              COALESCE(BOOL_OR(cr.reaction_type = 'laugh' AND cr.user_id = $2), false) AS my_laugh
       FROM post_comments pc
       JOIN users u ON u.id = pc.user_id
       LEFT JOIN comment_reactions cr ON cr.comment_id = pc.id
       WHERE pc.post_id = $1
       GROUP BY pc.id, pc.content, pc.created_at, u.first_name
       ORDER BY COALESCE(pc.parent_comment_id, pc.id) ASC,
                (pc.parent_comment_id IS NOT NULL) ASC,
                pc.created_at ASC, pc.id ASC
       LIMIT 200`,
      [postId, dbUserId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/posts/:id/comments', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    const { content } = req.body
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' })
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, dbUserId) === false) return

    // Optional reply target. Threading is capped at one level: you may reply to a
    // top-level comment, never to a reply.
    let parentCommentId = null
    if (req.body.parent_comment_id !== undefined && req.body.parent_comment_id !== null) {
      parentCommentId = parseInt(req.body.parent_comment_id, 10)
      if (!Number.isInteger(parentCommentId)) {
        return res.status(400).json({ error: 'Invalid parent_comment_id' })
      }
      const { rows: parent } = await pool.query(
        'SELECT post_id, parent_comment_id FROM post_comments WHERE id = $1',
        [parentCommentId],
      )
      if (!parent.length || parent[0].post_id !== postId) {
        return res.status(404).json({ error: 'Parent comment not found on this post' })
      }
      if (parent[0].parent_comment_id !== null) {
        return res.status(400).json({ error: 'Cannot reply to a reply — replies are one level deep' })
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, content, org_id, parent_comment_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, parent_comment_id, content, created_at`,
      [postId, dbUserId, content.trim(), req.orgId, parentCommentId],
    )

    // Notify post owner (unless commenting on own post)
    const { rows: postOwner } = await pool.query(
      'SELECT user_id, group_id FROM community_posts WHERE id = $1', [postId],
    )
    if (postOwner[0]?.user_id && postOwner[0].user_id !== dbUserId) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, post_id, from_user_id, org_id) VALUES ($1, 'comment', $2, $3, $4)`,
        [postOwner[0].user_id, postId, dbUserId, req.orgId],
      ).catch(() => {})
    }

    await createMentionNotifications(content.trim(), postId, dbUserId, req.orgId, postOwner[0]?.group_id ?? null)

    const { rows: userRows } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1', [dbUserId],
    )
    res.status(201).json({ ...rows[0], first_name: userRows[0]?.first_name ?? null })
  } catch (err) { next(err) }
})

// ── Polls ─────────────────────────────────────────────────────────────────────

router.get('/posts/:id/poll', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    if (await checkPostOrgAccess(req, res, postId) === false) return
    if (await checkPostGroupAccess(req, res, postId, dbUserId) === false) return

    const { rows: polls } = await pool.query(
      'SELECT id, question FROM community_polls WHERE post_id = $1', [postId],
    )
    if (!polls[0]) return res.json(null)
    const poll = polls[0]

    const { rows: options } = await pool.query(
      `SELECT po.id, po.option_text, po.display_order,
              COUNT(pv.id)::int AS vote_count
       FROM poll_options po
       LEFT JOIN poll_votes pv ON pv.option_id = po.id
       WHERE po.poll_id = $1
       GROUP BY po.id, po.option_text, po.display_order
       ORDER BY po.display_order`,
      [poll.id],
    )

    const { rows: myVoteRow } = await pool.query(
      'SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2',
      [poll.id, dbUserId],
    )

    res.json({
      id:          poll.id,
      question:    poll.question,
      options,
      totalVotes:  options.reduce((s, o) => s + o.vote_count, 0),
      myVote:      myVoteRow[0]?.option_id ?? null,
    })
  } catch (err) { next(err) }
})

router.post('/polls/:id/vote', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const pollId   = parseInt(req.params.id, 10)
    const { option_id } = req.body

    // Reached by poll id rather than post id, so the post is resolved first to
    // apply the same group gate as every other sub-resource.
    const { rows: pollPost } = await pool.query(
      'SELECT post_id FROM community_polls WHERE id = $1', [pollId],
    )
    if (!pollPost.length) return res.status(404).json({ error: 'Not found' })
    if (await checkPostOrgAccess(req, res, pollPost[0].post_id) === false) return
    if (await checkPostGroupAccess(req, res, pollPost[0].post_id, dbUserId) === false) return

    await pool.query(
      `INSERT INTO poll_votes (poll_id, option_id, user_id, org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = $2`,
      [pollId, option_id, dbUserId, req.orgId],
    )

    const { rows: options } = await pool.query(
      `SELECT po.id, po.option_text, po.display_order,
              COUNT(pv.id)::int AS vote_count
       FROM poll_options po
       LEFT JOIN poll_votes pv ON pv.option_id = po.id
       WHERE po.poll_id = $1
       GROUP BY po.id, po.option_text, po.display_order
       ORDER BY po.display_order`,
      [pollId],
    )

    res.json({
      options,
      totalVotes: options.reduce((s, o) => s + o.vote_count, 0),
      myVote:     option_id,
    })
  } catch (err) { next(err) }
})

// ── Comment reactions ─────────────────────────────────────────────────────────

router.get('/comments/:id/reactions', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId  = await getOrCreateUser(userId)
    const commentId = parseInt(req.params.id, 10)
    if (await checkCommentOrgAccess(req, res, commentId) === false) return
    if (await checkCommentGroupAccess(req, res, commentId, dbUserId) === false) return

    const { rows } = await pool.query(
      `SELECT
         COUNT(CASE WHEN reaction_type = 'like'  THEN 1 END)::int AS "like",
         COUNT(CASE WHEN reaction_type = 'love'  THEN 1 END)::int AS love,
         COUNT(CASE WHEN reaction_type = 'laugh' THEN 1 END)::int AS laugh,
         COUNT(CASE WHEN reaction_type = 'care'  THEN 1 END)::int AS care,
         ARRAY_REMOVE(ARRAY_AGG(CASE WHEN user_id = $2 THEN reaction_type END), NULL) AS "userReactions"
       FROM comment_reactions WHERE comment_id = $1`,
      [commentId, dbUserId],
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.post('/comments/:id/reactions', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId  = await getOrCreateUser(userId)
    const commentId = parseInt(req.params.id, 10)
    const { reaction_type } = req.body

    if (!['like', 'love', 'laugh', 'care'].includes(reaction_type)) {
      return res.status(400).json({ error: 'Invalid reaction_type' })
    }
    if (await checkCommentOrgAccess(req, res, commentId) === false) return
    if (await checkCommentGroupAccess(req, res, commentId, dbUserId) === false) return

    const { rows: existing } = await pool.query(
      'SELECT id FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND reaction_type = $3',
      [commentId, dbUserId, reaction_type],
    )

    let active
    if (existing.length > 0) {
      await pool.query(
        'DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND reaction_type = $3',
        [commentId, dbUserId, reaction_type],
      )
      active = false
    } else {
      await pool.query(
        'INSERT INTO comment_reactions (comment_id, user_id, reaction_type, org_id) VALUES ($1, $2, $3, $4)',
        [commentId, dbUserId, reaction_type, req.orgId],
      )
      active = true
    }

    const { rows } = await pool.query(
      `SELECT
         COUNT(CASE WHEN reaction_type = 'like'  THEN 1 END)::int AS like_count,
         COUNT(CASE WHEN reaction_type = 'love'  THEN 1 END)::int AS love_count,
         COUNT(CASE WHEN reaction_type = 'laugh' THEN 1 END)::int AS laugh_count,
         COUNT(CASE WHEN reaction_type = 'care'  THEN 1 END)::int AS care_count
       FROM comment_reactions WHERE comment_id = $1`,
      [commentId],
    )
    res.json({ reaction_type, active, ...rows[0] })
  } catch (err) { next(err) }
})

// ── Groups (org-manageable post categories/channels) ───────────────────────────

// GET /api/community/groups — active groups for the caller's org. Admins/owners
// may pass ?all=true to also see deactivated groups (for the manage-groups panel).
router.get('/groups', requireAuth(), async (req, res, next) => {
  try {
    const wantAll = req.query.all === 'true' && await isOrgOwnerOrAdmin(req)
    const { rows } = await pool.query(
      `SELECT cg.id, cg.name, cg.description, cg.type, cg.display_order, cg.is_active, cg.created_at,
              (SELECT COUNT(*)::int FROM community_posts cp
               WHERE cp.org_id = cg.org_id AND cp.category = cg.name) AS post_count
       FROM community_groups cg
       WHERE cg.org_id = $1 AND ($2::boolean OR cg.is_active = TRUE)
       ORDER BY cg.display_order ASC, cg.name ASC`,
      [req.orgId, wantAll],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/community/groups — create a group/category for the caller's org.
router.post('/groups', requireAuth(), async (req, res, next) => {
  try {
    if (!await requireOrgAdminOrOwner(req, res)) return
    const name        = req.body?.name?.trim()
    const description = req.body?.description?.trim() || null
    const type         = req.body?.type === 'private' ? 'private' : 'public'
    if (!name) return res.status(400).json({ error: 'Name is required' })

    const { rows } = await pool.query(
      `INSERT INTO community_groups (org_id, name, description, type, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, type, display_order, is_active, created_at`,
      [req.orgId, name, description, type, req.internalUser?.id ?? null],
    )
    res.status(201).json({ ...rows[0], post_count: 0 })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A group with that name already exists.' })
    next(err)
  }
})

// PATCH /api/community/groups/:id — rename / edit description, type, or active state.
router.patch('/groups/:id', requireAuth(), async (req, res, next) => {
  try {
    if (!await requireOrgAdminOrOwner(req, res)) return
    const groupId = parseInt(req.params.id, 10)

    const { rows: cur } = await pool.query('SELECT org_id FROM community_groups WHERE id = $1', [groupId])
    if (!cur.length || cur[0].org_id !== req.orgId) return res.status(404).json({ error: 'Not found' })

    const name = req.body?.name?.trim()
    if (!name) return res.status(400).json({ error: 'Name is required' })
    const description = req.body?.description?.trim() || null
    const type       = req.body?.type === 'private' ? 'private' : 'public'
    const is_active  = req.body?.is_active === undefined ? true : !!req.body.is_active

    const { rows } = await pool.query(
      `UPDATE community_groups
       SET name = $1, description = $2, type = $3, is_active = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, description, type, display_order, is_active, created_at`,
      [name, description, type, is_active, groupId],
    )

    await pool.query(
      `UPDATE community_posts
       SET category = $1
       WHERE group_id = $2 AND org_id = $3`,
      [name, groupId, req.orgId],
    )

    res.json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A group with that name already exists.' })
    next(err)
  }
})

// DELETE /api/community/groups/:id — soft delete (deactivate). Existing posts
// keep their category label; the group just stops appearing as a choice.
router.delete('/groups/:id', requireAuth(), async (req, res, next) => {
  try {
    if (!await requireOrgAdminOrOwner(req, res)) return
    const groupId = parseInt(req.params.id, 10)

    const { rows: cur } = await pool.query('SELECT org_id FROM community_groups WHERE id = $1', [groupId])
    if (!cur.length || cur[0].org_id !== req.orgId) return res.status(404).json({ error: 'Not found' })

    await pool.query('UPDATE community_groups SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [groupId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── Group membership ──────────────────────────────────────────────────────────

// Loads a group and confirms it belongs to the caller's org. 404 (not 403) for
// another org's group, matching checkPostOrgAccess — callers can't probe which
// group ids exist elsewhere. Returns null after responding when not found.
async function loadOrgGroup(req, res, groupId) {
  const { rows } = await pool.query(
    'SELECT id, org_id, name, description, type, is_active FROM community_groups WHERE id = $1',
    [groupId],
  )
  if (!rows.length || rows[0].org_id !== req.orgId) {
    res.status(404).json({ error: 'Not found' })
    return null
  }
  return rows[0]
}

// GET /api/community/groups/:id/members — roster for one group.
// Readable by any member of the group, plus org admins/owners (and the super
// admin, via requireOrgAdminOrOwner) so the manage-members UI works for an
// admin who isn't themselves a member of the group they administer.
router.get('/groups/:id/members', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)
    const groupId  = parseInt(req.params.id, 10)
    if (!await loadOrgGroup(req, res, groupId)) return

    const allowed = await isGroupMember(groupId, dbUserId, req.orgId) || await isOrgOwnerOrAdmin(req)
    if (!allowed) return res.status(403).json({ error: 'Not a member of this group' })

    // client_status only gates clients — staff rows carry their own lifecycle
    // column, so filtering them on it would hide every coach from the roster.
    const { rows } = await pool.query(
      `SELECT gm.user_id, u.first_name, u.last_name, u.email, u.role, gm.created_at AS added_at
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.org_id = $2
         AND (u.role != 'client' OR COALESCE(u.client_status, 'active') = 'active')
       ORDER BY u.first_name ASC NULLS LAST`,
      [groupId, req.orgId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/community/groups/:id/members — add one user to a group.
router.post('/groups/:id/members', requireAuth(), async (req, res, next) => {
  try {
    if (!await requireOrgAdminOrOwner(req, res)) return
    const groupId = parseInt(req.params.id, 10)
    if (!await loadOrgGroup(req, res, groupId)) return

    const targetId = parseInt(req.body?.user_id, 10)
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'user_id is required' })

    // The target must live in the caller's own org — without this an admin could
    // pull another tenant's user into their group and expose the feed to them.
    const { rows: target } = await pool.query('SELECT id, org_id FROM users WHERE id = $1', [targetId])
    if (!target.length || target[0].org_id !== req.orgId) {
      return res.status(404).json({ error: 'User not found in this organization' })
    }

    await pool.query(
      `INSERT INTO group_members (group_id, user_id, org_id, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, targetId, req.orgId, req.internalUser?.id ?? null],
    )

    // Re-selected rather than RETURNINGed: ON CONFLICT DO NOTHING returns no row
    // when the user was already a member, and that case should still be a 200.
    const { rows } = await pool.query(
      `SELECT gm.user_id, u.first_name, u.last_name, u.email, u.role, gm.created_at AS added_at
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.user_id = $2`,
      [groupId, targetId],
    )
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// DELETE /api/community/groups/:id/members/:userId — remove one user from a group.
router.delete('/groups/:id/members/:userId', requireAuth(), async (req, res, next) => {
  try {
    if (!await requireOrgAdminOrOwner(req, res)) return
    const groupId  = parseInt(req.params.id, 10)
    const targetId = parseInt(req.params.userId, 10)
    if (!await loadOrgGroup(req, res, groupId)) return

    const callerRes = await pool.query('SELECT id FROM users WHERE clerk_user_id = $1', [req.effectiveClerkUserId])
    const callerId = callerRes.rows[0]?.id
    if (callerId && callerId === parseInt(req.params.userId)) {
      return res.status(400).json({ error: 'You cannot remove yourself from a group.' })
    }

    await pool.query(
      'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 AND org_id = $3',
      [groupId, targetId, req.orgId],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// GET /api/community/groups/:id/eligible-members — active org users not yet in
// the group, for the "add member" picker.
router.get('/groups/:id/eligible-members', requireAuth(), async (req, res, next) => {
  try {
    if (!await requireOrgAdminOrOwner(req, res)) return
    const groupId = parseInt(req.params.id, 10)
    if (!await loadOrgGroup(req, res, groupId)) return

    // client_status only gates clients — staff rows carry their own lifecycle
    // column, so filtering them on it would hide every coach from the picker.
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.role
       FROM users u
       WHERE u.org_id = $1
         AND (u.role != 'client' OR COALESCE(u.client_status, 'active') = 'active')
         AND NOT EXISTS (
           SELECT 1 FROM group_members gm
           WHERE gm.group_id = $2 AND gm.user_id = u.id
         )
       ORDER BY u.first_name ASC NULLS LAST`,
      [req.orgId, groupId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/community/my-groups — the group switcher for the caller: every
// active group this user is a member of. No Main Feed entry — every post
// belongs to a real group now, so the caller's own membership list is the
// complete set of feeds they can see.
//
// Admins are the exception: they administer every group in their org but
// have no group_members row of their own (adding one would put them in the
// members list of every group, which isOrgOwnerOrAdmin already makes
// redundant everywhere else). Without this bypass an admin's my-groups call
// returns nothing and the pill row is empty.
router.get('/my-groups', requireAuth(), async (req, res, next) => {
  try {
    const userId = req.effectiveClerkUserId
    const dbUserId = await getOrCreateUser(userId)

    const { rows: callerRows } = await pool.query('SELECT role, email FROM users WHERE id = $1', [dbUserId])
    const isAdmin = isAdminRole(callerRows[0]?.role) || isAdminEmail(callerRows[0]?.email)

    const { rows } = isAdmin
      ? await pool.query(
          `SELECT id, name, description, type, org_id
           FROM community_groups
           WHERE org_id = $1 AND is_active = TRUE
           ORDER BY display_order ASC, id ASC`,
          [req.orgId],
        )
      : await pool.query(
          `SELECT cg.id, cg.name, cg.description, cg.type, cg.org_id
           FROM group_members gm
           JOIN community_groups cg ON cg.id = gm.group_id
           WHERE gm.user_id = $1 AND gm.org_id = $2 AND cg.is_active = TRUE
           ORDER BY cg.display_order ASC, cg.name ASC`,
          [dbUserId, req.orgId],
        )

    res.json(rows)
  } catch (err) { next(err) }
})

export default router
