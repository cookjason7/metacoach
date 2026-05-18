import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

async function requireStaff(req, res) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
  const role = rows[0]?.role
  if (role !== 'admin' && role !== 'coach') {
    res.status(403).json({ error: 'Staff only' })
    return null
  }
  return dbUserId
}

// GET /api/mindset-videos/my-progress — progress map keyed by video_id for current user
router.get('/my-progress', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows } = await pool.query(
      'SELECT video_id, started, highest_pct, completed FROM video_watch_progress WHERE user_id=$1',
      [dbUserId],
    )
    const map = {}
    for (const r of rows) {
      map[r.video_id] = { started: r.started, highest_pct: parseFloat(r.highest_pct), completed: r.completed }
    }
    res.json(map)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/mindset-videos — staff gets all, clients get published only
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const role = userRows[0]?.role
    const isStaff = role === 'admin' || role === 'coach'

    const { rows } = await pool.query(
      `SELECT * FROM mindset_videos
       WHERE ($1 OR published = TRUE)
       ORDER BY display_order ASC, created_at ASC`,
      [isStaff],
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mindset-videos — staff only
router.post('/', requireAuth(), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { title, description, youtube_url, module_name, display_order, published } = req.body
    if (!title?.trim() || !youtube_url?.trim()) {
      return res.status(400).json({ error: 'title and youtube_url are required' })
    }
    const { rows } = await pool.query(
      `INSERT INTO mindset_videos (title, description, youtube_url, module_name, display_order, published)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title.trim(), description?.trim() ?? null, youtube_url.trim(),
       module_name?.trim() ?? null, display_order ?? 0, published ?? false],
    )
    res.status(201).json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT /api/mindset-videos/:id — staff only
router.put('/:id', requireAuth(), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { id } = req.params
    const { title, description, youtube_url, module_name, display_order, published } = req.body
    if (!title?.trim() || !youtube_url?.trim()) {
      return res.status(400).json({ error: 'title and youtube_url are required' })
    }
    const { rows } = await pool.query(
      `UPDATE mindset_videos
       SET title=$1, description=$2, youtube_url=$3, module_name=$4,
           display_order=$5, published=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING *`,
      [title.trim(), description?.trim() ?? null, youtube_url.trim(),
       module_name?.trim() ?? null, display_order ?? 0, published ?? false, id],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/mindset-videos/:id/progress — upsert watch progress for current user
router.post('/:id/progress', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const videoId = parseInt(req.params.id, 10)
    const pct = parseFloat(req.body.pct)
    if (isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'pct must be 0–100' })
    }
    const { rows } = await pool.query(`
      INSERT INTO video_watch_progress
        (user_id, video_id, started, highest_pct, completed, first_watched_at, last_watched_at)
      VALUES ($1, $2, TRUE, $3, $3 >= 90, NOW(), NOW())
      ON CONFLICT (user_id, video_id) DO UPDATE SET
        started          = TRUE,
        highest_pct      = GREATEST(video_watch_progress.highest_pct, EXCLUDED.highest_pct),
        completed        = video_watch_progress.completed OR (GREATEST(video_watch_progress.highest_pct, EXCLUDED.highest_pct) >= 90),
        last_watched_at  = NOW()
      RETURNING started, highest_pct, completed
    `, [dbUserId, videoId, pct])
    const r = rows[0]
    res.json({ success: true, highest_pct: parseFloat(r.highest_pct), completed: r.completed })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/mindset-videos/:id — staff only
router.delete('/:id', requireAuth(), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { id } = req.params
    const { rowCount } = await pool.query('DELETE FROM mindset_videos WHERE id = $1', [id])
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
