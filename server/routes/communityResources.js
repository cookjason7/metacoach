import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail } from '../db.js'

const router = Router()

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping. Same pattern as coachAdmin.js / mindsetVideos.js (commits bf7addf, dbc3f60).
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

function getCtx(req) {
  return { orgId: req.orgId, email: req.internalUser?.email }
}

// Org-scoping note: community_resources had no org_id column at all and none of
// the five routes filtered by org — every client saw every org's published
// resources, and any org's staff could reorder, edit or delete another org's.
// The column is added + backfilled to org 1 via TENANT_TABLES in
// migrations/001_multi_tenancy.js; all five routes are scoped below. requireStaff
// still gates on role only — org isolation is layered on top of it, not into it,
// because an org-role 'admin' is NOT a platform super admin (see isSuperAdmin).

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype
    const ok = mime.startsWith('image/') ||
               mime === 'application/pdf' ||
               mime.startsWith('application/msword') ||
               mime.startsWith('application/vnd.openxmlformats-officedocument') ||
               mime.startsWith('application/vnd.ms-')
    cb(null, ok)
  },
})

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'metacoach/resources', resource_type: 'auto' },
      (err, result) => (err ? reject(err) : resolve(result)),
    )
    stream.end(buffer)
  })
}

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

// Resolve URL: file upload takes priority over body.url
async function resolveUrl(req) {
  if (req.file) {
    const result = await uploadToCloudinary(req.file.buffer)
    return result.secure_url
  }
  return req.body.url?.trim() ?? null
}

// Normalise resource_type to 'link' or 'file'
function normaliseType(raw) {
  return raw === 'file' ? 'file' : 'link'
}

// Parse published from JSON boolean or FormData string
function parseBool(v) {
  if (typeof v === 'boolean') return v
  return v === 'true' || v === '1'
}

// GET /api/community-resources — staff gets all, clients get published only
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
    const role = userRows[0]?.role
    const isStaff = role === 'admin' || role === 'coach'

    const ctx = getCtx(req)
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    const { rows } = await pool.query(
      `SELECT * FROM community_resources
       WHERE ($1 OR published = TRUE)${orgFilter}
       ORDER BY display_order ASC, created_at ASC`,
      bypassOrg ? [isStaff] : [isStaff, ctx.orgId],
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/community-resources/reorder — staff only
// Body: { ids: [3, 1, 2, ...] } — full set of resource ids in the desired
// display order. Reassigns display_order sequentially (10, 20, 30, ...) so
// there's always room to insert between existing positions later.
router.patch('/reorder', requireAuth(), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' })
    }

    const ctx = getCtx(req)
    const bypassOrg = isSuperAdmin(ctx)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < ids.length; i++) {
        // Ids from another org simply match no row rather than erroring — a
        // caller can't tell a foreign id from one that has since been deleted.
        await client.query(
          bypassOrg
            ? 'UPDATE community_resources SET display_order = $1, updated_at = NOW() WHERE id = $2'
            : 'UPDATE community_resources SET display_order = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3',
          bypassOrg ? [(i + 1) * 10, ids[i]] : [(i + 1) * 10, ids[i], ctx.orgId],
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    const orgFilter = bypassOrg ? '' : ' WHERE org_id = $1'
    const { rows } = await pool.query(
      `SELECT * FROM community_resources${orgFilter} ORDER BY display_order ASC, created_at ASC`,
      bypassOrg ? [] : [ctx.orgId],
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/community-resources — staff only; accepts JSON or multipart
router.post('/', requireAuth(), upload.single('file'), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { title, description, resource_type, category, display_order, published } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' })

    const rtype = normaliseType(resource_type)
    const finalUrl = await resolveUrl(req)
    if (!finalUrl) return res.status(400).json({ error: 'url or file is required' })

    const { rows } = await pool.query(
      `INSERT INTO community_resources
         (title, description, resource_type, url, category, display_order, published, org_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [title.trim(), description?.trim() ?? null, rtype, finalUrl,
       category?.trim() ?? null, Number(display_order ?? 0), parseBool(published), req.orgId],
    )
    res.status(201).json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT /api/community-resources/:id — staff only; accepts JSON or multipart
router.put('/:id', requireAuth(), upload.single('file'), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { id } = req.params
    const { title, description, resource_type, category, display_order, published } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' })

    const rtype = normaliseType(resource_type)
    const finalUrl = await resolveUrl(req)
    if (!finalUrl) return res.status(400).json({ error: 'url or file is required' })

    const ctx = getCtx(req)
    const bypassOrg = isSuperAdmin(ctx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $9`
    const params = [title.trim(), description?.trim() ?? null, rtype, finalUrl,
      category?.trim() ?? null, Number(display_order ?? 0), parseBool(published), id]
    const { rows } = await pool.query(
      `UPDATE community_resources
       SET title=$1, description=$2, resource_type=$3, url=$4, category=$5,
           display_order=$6, published=$7, updated_at=NOW()
       WHERE id=$8${orgFilter}
       RETURNING *`,
      bypassOrg ? params : [...params, ctx.orgId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/community-resources/:id — staff only
router.delete('/:id', requireAuth(), async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return
    const { id } = req.params
    const ctx = getCtx(req)
    const bypassOrg = isSuperAdmin(ctx)
    const { rowCount } = await pool.query(
      bypassOrg
        ? 'DELETE FROM community_resources WHERE id = $1'
        : 'DELETE FROM community_resources WHERE id = $1 AND org_id = $2',
      bypassOrg ? [id] : [id, ctx.orgId],
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
