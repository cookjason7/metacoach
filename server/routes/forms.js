import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { parseFormWithAI } from '../services/formParser.js'

const router = Router()

const SUBMITTABLE_ASSIGNMENT_TYPES = new Set(['manual', 'scheduled', 'recurring_occurrence'])
const SUBMITTABLE_ASSIGNMENT_STATUSES = new Set(['sent', 'pending', 'active'])

// ── Auth helpers (mirrors coachAdmin.js pattern) ──────────────────────────────

async function getCurrentUser(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [dbUserId])
  return { dbUserId, role: rows[0]?.role ?? 'client' }
}

function isAdmin(role)  { return role === 'admin' }
function isStaff(role)  { return role === 'admin' || role === 'coach' }

// ── Admin: Forms Library ───────────────────────────────────────────────────────

// GET /api/forms — list all form templates (staff only)
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isStaff(ctx.role)) return res.status(403).json({ error: 'Staff only' })

    const { rows } = await pool.query(`
      SELECT
        ft.id, ft.title, ft.description, ft.status,
        ft.current_version_id, ft.created_by,
        ft.created_at, ft.updated_at,
        (SELECT COUNT(*) FROM form_submissions fs WHERE fs.template_id = ft.id)::int AS submission_count
      FROM form_templates ft
      ORDER BY ft.updated_at DESC
    `)
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/forms — create a new draft form (admin only)
router.post('/', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isAdmin(ctx.role)) return res.status(403).json({ error: 'Admin only' })

    const { title, description } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' })

    const { rows } = await pool.query(`
      INSERT INTO form_templates (title, description, status, draft_schema, created_by)
      VALUES ($1, $2, 'draft', '[]', $3)
      RETURNING *
    `, [title.trim(), description?.trim() ?? null, ctx.dbUserId])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/forms/ai-import — admin only; paste raw form text, AI returns a new draft
router.post('/ai-import', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isAdmin(ctx.role)) return res.status(403).json({ error: 'Admin only' })

    const { raw_text } = req.body
    if (!raw_text?.trim()) return res.status(400).json({ error: 'raw_text is required.' })
    if (raw_text.length > 20000) return res.status(400).json({ error: 'Input text is too long (max 20,000 characters).' })

    const { title, description, fields } = await parseFormWithAI(raw_text.trim())

    const { rows: [newForm] } = await pool.query(`
      INSERT INTO form_templates (title, description, status, draft_schema, created_by)
      VALUES ($1, $2, 'draft', $3::jsonb, $4)
      RETURNING id, title
    `, [title, description ?? null, JSON.stringify(fields), ctx.dbUserId])

    res.status(201).json({ id: newForm.id, title: newForm.title, field_count: fields.length })
  } catch (err) { next(err) }
})

// GET /api/forms/:id — get template with draft_schema (staff only)
router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isStaff(ctx.role)) return res.status(403).json({ error: 'Staff only' })

    const id = parseInt(req.params.id, 10)
    const { rows } = await pool.query(`
      SELECT ft.*,
        fv.version_num AS current_version_num,
        fv.schema AS current_version_schema
      FROM form_templates ft
      LEFT JOIN form_versions fv ON fv.id = ft.current_version_id
      WHERE ft.id = $1
    `, [id])

    if (!rows.length) return res.status(404).json({ error: 'Form not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/forms/:id — update title/description/draft_schema (admin only)
router.patch('/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isAdmin(ctx.role)) return res.status(403).json({ error: 'Admin only' })

    const id = parseInt(req.params.id, 10)
    const { title, description, draft_schema } = req.body

    const setClauses = ['updated_at = NOW()']
    const params = []

    if (title !== undefined) {
      params.push(title?.trim() || null)
      setClauses.push(`title = $${params.length}`)
    }
    if (description !== undefined) {
      params.push(description?.trim() ?? null)
      setClauses.push(`description = $${params.length}`)
    }
    if (draft_schema !== undefined) {
      params.push(JSON.stringify(draft_schema))
      setClauses.push(`draft_schema = $${params.length}::jsonb`)
    }

    if (params.length === 0) return res.status(400).json({ error: 'Nothing to update' })

    params.push(id)
    const { rows } = await pool.query(
      `UPDATE form_templates SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    )
    if (!rows.length) return res.status(404).json({ error: 'Form not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/forms/:id/publish — snapshot draft_schema into a new version (admin only)
router.post('/:id/publish', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isAdmin(ctx.role)) return res.status(403).json({ error: 'Admin only' })

    const id = parseInt(req.params.id, 10)
    const { rows: [tpl] } = await pool.query(
      'SELECT * FROM form_templates WHERE id = $1', [id],
    )
    if (!tpl) return res.status(404).json({ error: 'Form not found' })
    if (tpl.status === 'archived') return res.status(400).json({ error: 'Cannot publish an archived form.' })

    const schema = tpl.draft_schema
    if (!Array.isArray(schema) || schema.length === 0) {
      return res.status(400).json({ error: 'Add at least one field before publishing.' })
    }

    // Determine next version number
    const { rows: [{ max_ver }] } = await pool.query(
      'SELECT COALESCE(MAX(version_num), 0) AS max_ver FROM form_versions WHERE template_id = $1',
      [id],
    )
    const newVersionNum = Number(max_ver) + 1

    // Create immutable version snapshot
    const { rows: [version] } = await pool.query(`
      INSERT INTO form_versions (template_id, version_num, schema, published_by)
      VALUES ($1, $2, $3::jsonb, $4)
      RETURNING *
    `, [id, newVersionNum, JSON.stringify(schema), ctx.dbUserId])

    // Update template: point to new version, set status=published
    const { rows: [updated] } = await pool.query(`
      UPDATE form_templates
      SET status = 'published',
          current_version_id = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [version.id, id])

    res.json({ template: updated, version })
  } catch (err) { next(err) }
})

// PATCH /api/forms/:id/archive — archive a form (admin only)
router.patch('/:id/archive', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isAdmin(ctx.role)) return res.status(403).json({ error: 'Admin only' })

    const id = parseInt(req.params.id, 10)
    const { rows } = await pool.query(`
      UPDATE form_templates SET status = 'archived', updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [id])
    if (!rows.length) return res.status(404).json({ error: 'Form not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/forms/:id/duplicate — copy as new draft (admin only)
router.post('/:id/duplicate', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isAdmin(ctx.role)) return res.status(403).json({ error: 'Admin only' })

    const id = parseInt(req.params.id, 10)
    const { rows: [src] } = await pool.query('SELECT * FROM form_templates WHERE id = $1', [id])
    if (!src) return res.status(404).json({ error: 'Form not found' })

    const { rows: [copy] } = await pool.query(`
      INSERT INTO form_templates (title, description, status, draft_schema, created_by)
      VALUES ($1, $2, 'draft', $3::jsonb, $4)
      RETURNING *
    `, [`${src.title} (copy)`, src.description, JSON.stringify(src.draft_schema), ctx.dbUserId])

    res.status(201).json(copy)
  } catch (err) { next(err) }
})

// ── Staff: preview (no submission) ───────────────────────────────────────────

// GET /api/forms/:id/preview — staff only; returns schema for preview without requiring published status
router.get('/:id/preview', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isStaff(ctx.role)) return res.status(403).json({ error: 'Staff only' })

    const id = parseInt(req.params.id, 10)
    const { rows: [tpl] } = await pool.query(`
      SELECT ft.id, ft.title, ft.description, ft.status,
             ft.draft_schema, ft.current_version_id,
             fv.version_num, fv.schema AS published_schema
      FROM form_templates ft
      LEFT JOIN form_versions fv ON fv.id = ft.current_version_id
      WHERE ft.id = $1
    `, [id])

    if (!tpl) return res.status(404).json({ error: 'Form not found' })

    const hasPublished = !!tpl.current_version_id
    const schema = hasPublished ? tpl.published_schema : tpl.draft_schema

    res.json({
      id:           tpl.id,
      title:        tpl.title,
      description:  tpl.description,
      status:       tpl.status,
      version_id:   tpl.current_version_id ?? null,
      version_num:  tpl.version_num ?? null,
      schema:       Array.isArray(schema) ? schema : [],
      is_preview:   true,
      is_draft:     !hasPublished,
    })
  } catch (err) { next(err) }
})

// ── Client: fill & submit ─────────────────────────────────────────────────────

// GET /api/forms/:id/fill — get the published version for a client to fill
router.get('/:id/fill', requireAuth(), async (req, res, next) => {
  try {
    await getCurrentUser(req) // just confirms auth
    const id = parseInt(req.params.id, 10)

    const { rows: [tpl] } = await pool.query(`
      SELECT ft.id, ft.title, ft.description, ft.status, ft.current_version_id,
             fv.version_num, fv.schema
      FROM form_templates ft
      LEFT JOIN form_versions fv ON fv.id = ft.current_version_id
      WHERE ft.id = $1
    `, [id])

    if (!tpl) return res.status(404).json({ error: 'Form not found' })
    if (tpl.status !== 'published') {
      return res.status(400).json({ error: 'This form is not currently published.' })
    }
    if (!tpl.current_version_id) {
      return res.status(400).json({ error: 'Form has no published version yet.' })
    }

    res.json({
      id:          tpl.id,
      title:       tpl.title,
      description: tpl.description,
      version_id:  tpl.current_version_id,
      version_num: tpl.version_num,
      schema:      tpl.schema,   // array of field objects
    })
  } catch (err) { next(err) }
})

// POST /api/forms/:id/submit — client submits answers
router.post('/:id/submit', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    const id  = parseInt(req.params.id, 10)

    const { rows: [tpl] } = await pool.query(
      'SELECT id, status, current_version_id FROM form_templates WHERE id = $1', [id],
    )
    if (!tpl) return res.status(404).json({ error: 'Form not found' })
    if (tpl.status !== 'published' || !tpl.current_version_id) {
      return res.status(400).json({ error: 'This form is not currently accepting submissions.' })
    }

    const { answers, assignment_id } = req.body
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers must be an object.' })
    }

    let assignId = null
    if (assignment_id !== undefined && assignment_id !== null && assignment_id !== '') {
      assignId = Number.parseInt(assignment_id, 10)
      if (!Number.isInteger(assignId) || assignId <= 0) {
        return res.status(400).json({ error: 'Invalid form assignment.' })
      }

      const { rows: [assignment] } = await pool.query(
        `SELECT id, template_id, client_id, assignment_type, status
         FROM form_assignments
         WHERE id = $1`,
        [assignId],
      )
      if (!assignment) {
        return res.status(400).json({ error: 'Form assignment not found.' })
      }
      if (assignment.client_id !== ctx.dbUserId) {
        return res.status(403).json({ error: 'This form assignment does not belong to you.' })
      }
      if (assignment.template_id !== id) {
        return res.status(400).json({ error: 'This assignment is for a different form.' })
      }
      if (!SUBMITTABLE_ASSIGNMENT_STATUSES.has(assignment.status)) {
        return res.status(400).json({ error: 'This form assignment is no longer active.' })
      }
      if (!SUBMITTABLE_ASSIGNMENT_TYPES.has(assignment.assignment_type)) {
        return res.status(400).json({ error: 'This form link is not a submission occurrence. Please use the latest form link.' })
      }

      const { rows: [existing] } = await pool.query(
        'SELECT id FROM form_submissions WHERE assignment_id = $1 AND user_id = $2 LIMIT 1',
        [assignId, ctx.dbUserId],
      )
      if (existing) {
        return res.status(409).json({
          error: 'You already submitted this form.',
          already_submitted: true,
        })
      }
    }

    // Validate required fields against the published version schema
    const { rows: [ver] } = await pool.query(
      'SELECT schema FROM form_versions WHERE id = $1', [tpl.current_version_id],
    )
    const schema = ver?.schema ?? []
    const missing = schema
      .filter(f => f.required)
      .filter(f => {
        const val = answers[f.id]
        return val === undefined || val === null || val === '' ||
               (Array.isArray(val) && val.length === 0)
      })
      .map(f => f.label)

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Please answer all required questions: ${missing.join(', ')}`,
      })
    }

    const { rows: [submission] } = await pool.query(`
      INSERT INTO form_submissions (template_id, version_id, user_id, answers, assignment_id)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      RETURNING *
    `, [id, tpl.current_version_id, ctx.dbUserId, JSON.stringify(answers), assignId])

    res.status(201).json(submission)
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'idx_form_submissions_assignment_user_unique') {
      return res.status(409).json({
        error: 'You already submitted this form.',
        already_submitted: true,
      })
    }
    next(err)
  }
})

export default router
