import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail } from '../db.js'

const router = Router()

const REACTION_TYPES = ['like', 'love', 'fire']

// GET /api/brain-mapping-comments/:videoId — list comments with reaction counts + current user's reactions
router.get('/:videoId', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const videoId = parseInt(req.params.videoId, 10)
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id' })

    const { rows } = await pool.query(
      `SELECT c.id, c.video_id, c.user_id, c.comment_text, c.created_at,
              u.first_name AS user_name,
              COALESCE(
                json_object_agg(r.reaction_type, r.cnt) FILTER (WHERE r.reaction_type IS NOT NULL),
                '{}'
              ) AS reaction_counts,
              COALESCE(
                array_agg(r.reaction_type) FILTER (WHERE r.reacted_by_me),
                ARRAY[]::text[]
              ) AS my_reactions
       FROM brain_mapping_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN (
         SELECT comment_id, reaction_type, COUNT(*) AS cnt,
                bool_or(user_id = $2) AS reacted_by_me
         FROM brain_mapping_reactions
         GROUP BY comment_id, reaction_type
       ) r ON r.comment_id = c.id
       WHERE c.video_id = $1
       GROUP BY c.id, u.first_name
       ORDER BY c.created_at ASC`,
      [videoId, dbUserId],
    )
    res.json(rows)
  } catch (e) {
    console.error('[brain-mapping-comments:list]', e.message, e.stack)
    res.status(500).json({ error: e.message ?? 'Server error' })
  }
})

// GET /api/brain-mapping-comments/:videoId/video-reactions — reaction counts + current user's reactions for the video itself
router.get('/:videoId/video-reactions', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const videoId = parseInt(req.params.videoId, 10)
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id' })

    const { rows } = await pool.query(
      `SELECT reaction_type, COUNT(*) AS cnt, bool_or(user_id = $2) AS reacted_by_me
       FROM brain_mapping_video_reactions
       WHERE video_id = $1
       GROUP BY reaction_type`,
      [videoId, dbUserId],
    )
    const reaction_counts = {}
    const my_reactions = []
    for (const r of rows) {
      reaction_counts[r.reaction_type] = parseInt(r.cnt, 10)
      if (r.reacted_by_me) my_reactions.push(r.reaction_type)
    }
    res.json({ reaction_counts, my_reactions })
  } catch (e) {
    console.error('[brain-mapping-comments:video-reactions:list]', e.message, e.stack)
    res.status(500).json({ error: e.message ?? 'Server error' })
  }
})

// POST /api/brain-mapping-comments/:videoId/video-reactions — toggle a video-level reaction
router.post('/:videoId/video-reactions', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const videoId = parseInt(req.params.videoId, 10)
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id' })
    const { reaction_type } = req.body
    if (!REACTION_TYPES.includes(reaction_type)) {
      return res.status(400).json({ error: `reaction_type must be one of ${REACTION_TYPES.join(', ')}` })
    }

    const { rowCount } = await pool.query(
      'DELETE FROM brain_mapping_video_reactions WHERE video_id = $1 AND user_id = $2 AND reaction_type = $3',
      [videoId, dbUserId, reaction_type],
    )
    let action = 'removed'
    if (!rowCount) {
      await pool.query(
        `INSERT INTO brain_mapping_video_reactions (video_id, user_id, reaction_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (video_id, user_id, reaction_type) DO NOTHING`,
        [videoId, dbUserId, reaction_type],
      )
      action = 'added'
    }
    res.json({ success: true, action })
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Video not found' })
    console.error('[brain-mapping-comments:video-reactions:react]', e.message, e.stack)
    res.status(500).json({ error: e.message ?? 'Server error' })
  }
})

// POST /api/brain-mapping-comments — create a comment
router.post('/', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { video_id, comment_text } = req.body
    const videoId = parseInt(video_id, 10)
    if (isNaN(videoId)) return res.status(400).json({ error: 'Invalid video id' })
    const text = comment_text?.trim()
    if (!text) return res.status(400).json({ error: 'comment_text is required' })
    if (text.length > 500) return res.status(400).json({ error: 'comment_text must be 500 characters or fewer' })

    const { rows } = await pool.query(
      `INSERT INTO brain_mapping_comments (video_id, user_id, comment_text)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [videoId, dbUserId, text],
    )
    const { rows: userRows } = await pool.query('SELECT first_name FROM users WHERE id = $1', [dbUserId])
    res.status(201).json({ ...rows[0], user_name: userRows[0]?.first_name ?? null, reaction_counts: {}, my_reactions: [] })
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Video not found' })
    console.error('[brain-mapping-comments:create]', e.message, e.stack)
    res.status(500).json({ error: e.message ?? 'Server error' })
  }
})

// DELETE /api/brain-mapping-comments/:commentId — delete own comment, or any if admin
router.delete('/:commentId', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const commentId = parseInt(req.params.commentId, 10)
    if (isNaN(commentId)) return res.status(400).json({ error: 'Invalid comment id' })

    const isAdmin = isAdminEmail(req.internalUser?.email)
    const { rowCount } = await pool.query(
      isAdmin
        ? 'DELETE FROM brain_mapping_comments WHERE id = $1'
        : 'DELETE FROM brain_mapping_comments WHERE id = $1 AND user_id = $2',
      isAdmin ? [commentId] : [commentId, dbUserId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (e) {
    console.error('[brain-mapping-comments:delete]', e.message, e.stack)
    res.status(500).json({ error: e.message ?? 'Server error' })
  }
})

// POST /api/brain-mapping-comments/:commentId/reactions — toggle a reaction
router.post('/:commentId/reactions', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const commentId = parseInt(req.params.commentId, 10)
    if (isNaN(commentId)) return res.status(400).json({ error: 'Invalid comment id' })
    const { reaction_type } = req.body
    if (!REACTION_TYPES.includes(reaction_type)) {
      return res.status(400).json({ error: `reaction_type must be one of ${REACTION_TYPES.join(', ')}` })
    }

    const { rowCount } = await pool.query(
      'DELETE FROM brain_mapping_reactions WHERE comment_id = $1 AND user_id = $2 AND reaction_type = $3',
      [commentId, dbUserId, reaction_type],
    )
    let action = 'removed'
    if (!rowCount) {
      await pool.query(
        `INSERT INTO brain_mapping_reactions (comment_id, user_id, reaction_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (comment_id, user_id, reaction_type) DO NOTHING`,
        [commentId, dbUserId, reaction_type],
      )
      action = 'added'
    }
    res.json({ success: true, action })
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'Comment not found' })
    console.error('[brain-mapping-comments:react]', e.message, e.stack)
    res.status(500).json({ error: e.message ?? 'Server error' })
  }
})

export default router
