import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail } from '../db.js'
import { parseFormWithAI } from '../services/formParser.js'
const router = Router()

const SUBMITTABLE_ASSIGNMENT_TYPES = new Set(['manual', 'scheduled', 'recurring_occurrence'])
const SUBMITTABLE_ASSIGNMENT_STATUSES = new Set(['sent', 'pending', 'active'])

function localDateString(date, timezoneOffsetMinutes = 0) {
  const offsetMs = Number(timezoneOffsetMinutes || 0) * 60 * 1000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

// Mirrors FormFill.jsx's client-side visibility check: a conditional question
// only counts toward "required" validation when its controlling answer is
// actually present. Without this, a hidden required question would block
// submission since the client never collected (or explicitly cleared) it.
// Values are compared as strings since rating answers are numeric.
function isFieldVisible(field, answers) {
  if (!field.condition) return true
  const { questionId, value } = field.condition
  const actual = answers[questionId]
  if (actual === undefined || actual === null) return false
  return String(actual) === String(value)
}

// ── Auth helpers (mirrors coachAdmin.js pattern) ──────────────────────────────

async function getCurrentUser(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [dbUserId])
  return { dbUserId, role: rows[0]?.role ?? 'client' }
}

function isAdmin(role)  { return role === 'admin' }
function isStaff(role)  { return role === 'admin' || role === 'coach' }

// Super admin (platform owner accounts in ADMIN_EMAILS, e.g. Jason) bypasses org
// scoping. Same pattern as coachAdmin.js / community.js (commits bf7addf, dbc3f60).
function isSuperAdmin(ctx) {
  return isAdminEmail(ctx.email)
}

// ── Admin: Forms Library ───────────────────────────────────────────────────────

// GET /api/forms — list all form templates (staff only)
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isStaff(ctx.role)) return res.status(403).json({ error: 'Staff only' })

    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND ft.org_id = $1`
    const qParams = bypassOrg ? [] : [req.orgId]

    const { rows } = await pool.query(`
      SELECT
        ft.id, ft.title, ft.description, ft.status,
        ft.current_version_id, ft.created_by,
        ft.created_at, ft.updated_at,
        (SELECT COUNT(*) FROM form_submissions fs WHERE fs.template_id = ft.id)::int AS submission_count
      FROM form_templates ft
      WHERE 1=1${orgFilter}
      ORDER BY ft.updated_at DESC
    `, qParams)
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
      INSERT INTO form_templates (title, description, status, draft_schema, created_by, org_id)
      VALUES ($1, $2, 'draft', '[]', $3, $4)
      RETURNING *
    `, [title.trim(), description?.trim() ?? null, ctx.dbUserId, req.orgId])

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
      INSERT INTO form_templates (title, description, status, draft_schema, created_by, org_id)
      VALUES ($1, $2, 'draft', $3::jsonb, $4, $5)
      RETURNING id, title
    `, [title, description ?? null, JSON.stringify(fields), ctx.dbUserId, req.orgId])

    res.status(201).json({ id: newForm.id, title: newForm.title, field_count: fields.length })
  } catch (err) { next(err) }
})

// GET /api/forms/:id — get template with draft_schema (staff only)
router.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCurrentUser(req)
    if (!isStaff(ctx.role)) return res.status(403).json({ error: 'Staff only' })

    const id = parseInt(req.params.id, 10)
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND ft.org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows } = await pool.query(`
      SELECT ft.*,
        fv.version_num AS current_version_num,
        fv.schema AS current_version_schema
      FROM form_templates ft
      LEFT JOIN form_versions fv ON fv.id = ft.current_version_id
      WHERE ft.id = $1${orgFilter}
    `, qParams)

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

    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $${params.length + 1}`
    params.push(id)
    if (!bypassOrg) params.push(req.orgId)

    const { rows } = await pool.query(
      `UPDATE form_templates SET ${setClauses.join(', ')} WHERE id = $${params.length - (bypassOrg ? 0 : 1)}${orgFilter} RETURNING *`,
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
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows: [tpl] } = await pool.query(
      `SELECT * FROM form_templates WHERE id = $1${orgFilter}`, qParams,
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

    // Create immutable version snapshot (include org_id for data isolation)
    const { rows: [version] } = await pool.query(`
      INSERT INTO form_versions (template_id, version_num, schema, published_by, org_id)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      RETURNING *
    `, [id, newVersionNum, JSON.stringify(schema), ctx.dbUserId, req.orgId])

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
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows } = await pool.query(`
      UPDATE form_templates SET status = 'archived', updated_at = NOW()
      WHERE id = $1${orgFilter} RETURNING *
    `, qParams)
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
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows: [src] } = await pool.query(`
      SELECT * FROM form_templates WHERE id = $1${orgFilter}
    `, qParams)
    if (!src) return res.status(404).json({ error: 'Form not found' })

    const { rows: [copy] } = await pool.query(`
      INSERT INTO form_templates (title, description, status, draft_schema, created_by, org_id)
      VALUES ($1, $2, 'draft', $3::jsonb, $4, $5)
      RETURNING *
    `, [`${src.title} (copy)`, src.description, JSON.stringify(src.draft_schema), ctx.dbUserId, req.orgId])

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
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND ft.org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows: [tpl] } = await pool.query(`
      SELECT ft.id, ft.title, ft.description, ft.status,
             ft.draft_schema, ft.current_version_id,
             fv.version_num, fv.schema AS published_schema
      FROM form_templates ft
      LEFT JOIN form_versions fv ON fv.id = ft.current_version_id
      WHERE ft.id = $1${orgFilter}
    `, qParams)

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
    const ctx = await getCurrentUser(req)
    const id = parseInt(req.params.id, 10)

    // For client fill, check if the form is published and accessible from this org
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND ft.org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows: [tpl] } = await pool.query(`
      SELECT ft.id, ft.title, ft.description, ft.status, ft.current_version_id,
             fv.version_num, fv.schema
      FROM form_templates ft
      LEFT JOIN form_versions fv ON fv.id = ft.current_version_id
      WHERE ft.id = $1${orgFilter}
    `, qParams)

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

    // Check that form exists in this org and is published
    const adminCtx = { orgId: req.orgId, email: req.internalUser?.email }
    const bypassOrg = isSuperAdmin(adminCtx)
    const orgFilter = bypassOrg ? '' : ` AND org_id = $2`
    const qParams = bypassOrg ? [id] : [id, req.orgId]

    const { rows: [tpl] } = await pool.query(
      `SELECT id, status, current_version_id FROM form_templates WHERE id = $1${orgFilter}`, qParams,
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
    let dueAt = null
    let isLate = false
    if (assignment_id !== undefined && assignment_id !== null && assignment_id !== '') {
      assignId = Number.parseInt(assignment_id, 10)
      if (!Number.isInteger(assignId) || assignId <= 0) {
        return res.status(400).json({ error: 'Invalid form assignment.' })
      }

      const { rows: [assignment] } = await pool.query(
        `SELECT fa.id, fa.template_id, fa.client_id, fa.assignment_type, fa.status,
                fa.send_at, fa.sent_at, fa.next_send_at, fa.recurring_rule,
                parent.recurring_rule AS parent_recurring_rule
         FROM form_assignments fa
         LEFT JOIN form_assignments parent ON parent.id = fa.parent_assignment_id
         WHERE fa.id = $1 AND (fa.org_id = $2 OR fa.org_id IS NULL)`,
        [assignId, req.orgId],
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

      dueAt = assignment.send_at ?? assignment.sent_at ?? assignment.next_send_at ?? null
      if (dueAt) {
        const rule = assignment.recurring_rule ?? assignment.parent_recurring_rule ?? {}
        const offset = Number.isFinite(Number(rule.timezone_offset_minutes))
          ? Number(rule.timezone_offset_minutes)
          : new Date().getTimezoneOffset()
        const dueLocalDate = localDateString(new Date(dueAt), offset)
        const submittedLocalDate = localDateString(new Date(), offset)
        isLate = submittedLocalDate > dueLocalDate
        console.log('[forms submit] assignment timing', {
          assignment_id: assignId,
          assignment_type: assignment.assignment_type,
          due_at: new Date(dueAt).toISOString(),
          submitted_local_date: submittedLocalDate,
          due_local_date: dueLocalDate,
          timezone_offset_minutes: offset,
          is_late: isLate,
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
      .filter(f => isFieldVisible(f, answers))
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
      INSERT INTO form_submissions (template_id, version_id, user_id, answers, assignment_id, due_at, is_late, org_id)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      RETURNING *
    `, [id, tpl.current_version_id, ctx.dbUserId, JSON.stringify(answers), assignId, dueAt, isLate, req.orgId])

    console.log('[forms submit] submission created for staff review', {
      submission_id: submission.id,
      user_id: ctx.dbUserId,
      template_id: id,
      assignment_id: assignId,
      is_late: submission.is_late,
      due_at: submission.due_at,
    })
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
