import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { notifyNewCommunityPost } from '../services/pushService.js'

const router = Router()

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
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
  if (rows[0]?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' })
    return null
  }
  return dbUserId
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
    const { userId } = getAuth(req)
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

const CLIENT_CATEGORIES = new Set(['General Discussion', 'Non-Scale Victories'])

async function createMentionNotifications(content, postId, fromUserId) {
  const names = [...new Set((content.match(/(?<!\w)@([A-Za-z]\w*)/g) ?? []).map(m => m.slice(1)))]
  for (const name of names) {
    try {
      const { rows } = await pool.query(
        `SELECT id FROM users WHERE first_name ILIKE $1 AND id != $2 LIMIT 1`,
        [name, fromUserId],
      )
      if (rows.length) {
        await pool.query(
          `INSERT INTO notifications (user_id, type, post_id, from_user_id) VALUES ($1, 'mention', $2, $3)`,
          [rows[0].id, postId, fromUserId],
        )
      }
    } catch {}
  }
}

// In-app badge notification for clients when a coach/admin creates a new community post.
// Never fires for client-authored posts — only notifies about the other clients' own
// mentions/comments, not every new post from peers.
async function createNewPostNotifications(postId, fromUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE role = 'client' AND COALESCE(coaching_type, '') != 'basic' AND id != $1`,
      [fromUserId],
    )
    for (const u of rows) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, post_id, from_user_id) VALUES ($1, 'new_post', $2, $3)`,
        [u.id, postId, fromUserId],
      ).catch(() => {})
    }
  } catch {}
}
async function notifyTopLevelCommunityPost({ authorUserId, authorIsStaff, postChannel }) {
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
           AND id != $1`,
        [authorUserId],
      )
      for (const client of clients) await notifyNewCommunityPost(client.id).catch(() => {})
      return
    }

    const { rows: [author] } = await pool.query(
      `SELECT assigned_coach_id AS coach_id FROM users WHERE id = $1`,
      [authorUserId],
    )
    if (author?.coach_id) {
      await notifyNewCommunityPost(author.coach_id).catch(() => {})
      return
    }

    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND id != $1`,
      [authorUserId],
    )
    for (const admin of admins) await notifyNewCommunityPost(admin.id).catch(() => {})
  } catch (err) {
    console.warn('[push] notifyTopLevelCommunityPost error:', err.message)
  }
}
// -- Delete -------------------------------------------------------------------

router.delete('/posts/:id', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { dbUserId, isStaff } = await getUserContext(userId)
    const postId = parseInt(req.params.id, 10)
    if (!isStaff) {
      // clients can only delete their own posts
      const { rows } = await pool.query('SELECT user_id FROM community_posts WHERE id = $1', [postId])
      if (!rows[0]) return res.status(404).json({ error: 'Not found' })
      if (rows[0].user_id !== dbUserId) return res.status(403).json({ error: 'Forbidden' })
    }
    await pool.query('DELETE FROM community_posts WHERE id = $1', [postId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})
router.delete('/comments/:id', requireAuth(), async (req, res, next) => {
  try {
    if (await checkAdmin(req, res) === null) return
    await pool.query('DELETE FROM post_comments WHERE id = $1', [parseInt(req.params.id, 10)])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── Leaderboard ───────────────────────────────────────────────────────────────

router.get('/leaderboard', requireAuth(), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.first_name, COUNT(DISTINCT DATE(m.logged_at))::int AS streak
      FROM users u
      JOIN meals m ON m.user_id = u.id
      WHERE m.logged_at >= DATE_TRUNC('week', NOW())
      GROUP BY u.id, u.first_name
      ORDER BY streak DESC, u.first_name ASC
      LIMIT 10
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// ── Members directory ─────────────────────────────────────────────────────────

router.get('/members', requireAuth(), async (req, res, next) => {
  try {
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
      WHERE u.onboarding_complete = TRUE
      GROUP BY u.id, u.first_name, u.identity_anchors, u.created_at
      ORDER BY u.first_name ASC NULLS LAST
    `)

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
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = FALSE',
      [dbUserId],
    )
    res.json({ count: rows[0].count })
  } catch (err) { next(err) }
})

router.post('/notifications/read', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
      [dbUserId],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── Posts ─────────────────────────────────────────────────────────────────────

router.get('/posts', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { dbUserId, isStaff, channel } = await getUserContext(userId)

    // Clients always see their own channel; staff filter by ?channel= param when provided
    const requested   = ['vip', 'ai'].includes(req.query.channel) ? req.query.channel : null
    const filterChannel = isStaff ? requested : channel   // null = no filter (staff, all channels)

    const limit = Math.min(parseInt(req.query.limit) || 30, 100)
    const beforeId = req.query.before_id ? parseInt(req.query.before_id) : null

    const qParams = [dbUserId, filterChannel]
    let extraWhere = ''
    if (beforeId) {
      qParams.push(beforeId)
      extraWhere = ` AND cp.id < $${qParams.length}`
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

router.post('/posts', requireAuth(), upload.single('photo'), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const { dbUserId, isStaff, channel } = await getUserContext(userId)
    const content   = req.body?.content
    let   category  = req.body?.category ?? 'General Discussion'

    if (!content?.trim()) return res.status(400).json({ error: 'Content required' })

    // Clients may only post in General Discussion or Non-Scale Victories
    if (!isStaff && !CLIENT_CATEGORIES.has(category)) category = 'General Discussion'

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
      `INSERT INTO community_posts (user_id, content, photo_url, category, channel)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, content, photo_url, created_at, category, channel, pinned`,
      [dbUserId, content.trim(), photo_url, category, postChannel],
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
            'INSERT INTO community_polls (post_id, question) VALUES ($1, $2) RETURNING id',
            [post.id, pollQuestion.trim()],
          )
          const pollId = pollRows[0].id
          for (let i = 0; i < validOptions.length; i++) {
            await pool.query(
              'INSERT INTO poll_options (poll_id, option_text, display_order) VALUES ($1, $2, $3)',
              [pollId, validOptions[i].trim(), i],
            )
          }
        }
      } catch {}
    }

    await createMentionNotifications(content.trim(), post.id, dbUserId)

    // Staff post -> clients get an in-app badge notification too (fire-and-forget)
    if (isStaff) createNewPostNotifications(post.id, dbUserId).catch(() => {})

    // Push only for top-level post creation. Comments intentionally do not dispatch push.
    notifyTopLevelCommunityPost({
      authorUserId: dbUserId,
      authorIsStaff: isStaff,
      postChannel,
    }).catch(() => {})
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
    const { userId } = getAuth(req)
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

    const { rows } = await pool.query(
      `UPDATE community_posts
       SET content  = COALESCE($1, content),
           category = COALESCE($2, category)
       WHERE id = $3
       RETURNING id, content, category`,
      [content ?? null, category ?? null, postId],
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/community/posts/:id/pin  (admin)
router.post('/posts/:id/pin', requireAuth(), async (req, res, next) => {
  try {
    if (await checkAdmin(req, res) === null) return
    const postId = parseInt(req.params.id, 10)
    const { rows: cur } = await pool.query('SELECT pinned FROM community_posts WHERE id = $1', [postId])
    const willPin = !cur[0]?.pinned
    if (willPin) {
      await pool.query('UPDATE community_posts SET pinned = FALSE')
      await pool.query('UPDATE community_posts SET pinned = TRUE WHERE id = $1', [postId])
    } else {
      await pool.query('UPDATE community_posts SET pinned = FALSE WHERE id = $1', [postId])
    }
    res.json({ pinned: willPin })
  } catch (err) { next(err) }
})

// POST /api/community/posts/:id/like  (toggle)
router.post('/posts/:id/like', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)

    const { rows: existing } = await pool.query(
      'SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2',
      [postId, dbUserId],
    )

    let liked
    if (existing.length > 0) {
      await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, dbUserId])
      liked = false
    } else {
      await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)', [postId, dbUserId])
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
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)

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
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    const { reaction_type } = req.body

    if (!['like', 'love', 'laugh', 'care'].includes(reaction_type)) {
      return res.status(400).json({ error: 'Invalid reaction_type' })
    }

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
        'INSERT INTO post_reactions (post_id, user_id, reaction_type) VALUES ($1, $2, $3)',
        [postId, dbUserId, reaction_type],
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

// GET/POST /api/community/posts/:id/comments
router.get('/posts/:id/comments', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)

    const { rows } = await pool.query(
      `SELECT pc.id, pc.content, pc.created_at, u.first_name,
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
       ORDER BY pc.created_at ASC
       LIMIT 200`,
      [postId, dbUserId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/posts/:id/comments', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)
    const { content } = req.body
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' })

    const { rows } = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [postId, dbUserId, content.trim()],
    )

    // Notify post owner (unless commenting on own post)
    const { rows: postOwner } = await pool.query(
      'SELECT user_id FROM community_posts WHERE id = $1', [postId],
    )
    if (postOwner[0]?.user_id && postOwner[0].user_id !== dbUserId) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, post_id, from_user_id) VALUES ($1, 'comment', $2, $3)`,
        [postOwner[0].user_id, postId, dbUserId],
      ).catch(() => {})
    }

    await createMentionNotifications(content.trim(), postId, dbUserId)

    const { rows: userRows } = await pool.query(
      'SELECT first_name FROM users WHERE id = $1', [dbUserId],
    )
    res.status(201).json({ ...rows[0], first_name: userRows[0]?.first_name ?? null })
  } catch (err) { next(err) }
})

// ── Polls ─────────────────────────────────────────────────────────────────────

router.get('/posts/:id/poll', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const postId   = parseInt(req.params.id, 10)

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
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const pollId   = parseInt(req.params.id, 10)
    const { option_id } = req.body

    await pool.query(
      `INSERT INTO poll_votes (poll_id, option_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = $2`,
      [pollId, option_id, dbUserId],
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
    const { userId } = getAuth(req)
    const dbUserId  = await getOrCreateUser(userId)
    const commentId = parseInt(req.params.id, 10)

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
    const { userId } = getAuth(req)
    const dbUserId  = await getOrCreateUser(userId)
    const commentId = parseInt(req.params.id, 10)
    const { reaction_type } = req.body

    if (!['like', 'love', 'laugh', 'care'].includes(reaction_type)) {
      return res.status(400).json({ error: 'Invalid reaction_type' })
    }

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
        'INSERT INTO comment_reactions (comment_id, user_id, reaction_type) VALUES ($1, $2, $3)',
        [commentId, dbUserId, reaction_type],
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

export default router
