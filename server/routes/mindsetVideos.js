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
