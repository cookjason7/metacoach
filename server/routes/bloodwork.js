import { createRequire } from 'module'
import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { bloodworkUploadLimit } from '../middleware/rateLimits.js'

// pdf-parse is CJS; createRequire lets us load it from ESM without the exports-field restriction
const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const router = Router()

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIMES.has(file.mimetype)),
})

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const anthropic = new Anthropic()

const clientEnabled = () => process.env.BLOODWORK_CLIENT_ENABLED === 'true'

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getCtx(req) {
  const { userId } = getAuth(req)
  const dbUserId = await getOrCreateUser(userId)
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [dbUserId])
  return { dbUserId, role: rows[0]?.role ?? 'client' }
}

function isPrivileged(role) {
  return ['admin', 'staff', 'coach'].includes(role)
}

async function canAccessClient(ctx, clientId) {
  if (ctx.role === 'admin') return true
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE id = $1 AND assigned_coach_id = $2',
    [clientId, ctx.dbUserId],
  )
  return rows.length > 0
}

function uploadToCloud(buffer, mimetype) {
  const resourceType = mimetype === 'application/pdf' ? 'raw' : 'image'
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: 'metacoach/bloodwork', resource_type: resourceType },
      (err, result) => (err ? reject(err) : resolve(result)),
    ).end(buffer)
  })
}

async function extractText(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    try {
      const data = await pdfParse(buffer)
      const text = data.text?.trim()
      return text?.length > 30 ? text : null
    } catch { return null }
  }
  if (mimetype.startsWith('image/')) {
    try {
      const safeType = mimetype === 'image/jpg' ? 'image/jpeg' : mimetype
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: safeType, data: buffer.toString('base64') },
            },
            {
              type: 'text',
              text: 'Transcribe all text from this lab report exactly as shown — test names, values, units, and reference ranges. Output only the extracted text, no commentary.',
            },
          ],
        }],
      })
      const text = msg.content[0]?.text?.trim()
      return text?.length > 30 ? text : null
    } catch { return null }
  }
  return null
}

const SUMMARY_PROMPT = `You are a functional health education assistant reviewing lab results for a woman, typically 40-60 years old, who may be navigating perimenopause or menopause.

Your role is educational interpretation only. This is not medical advice.

Guidelines:
- Write in plain English. Explain any medical terms used.
- Distinguish functional/optimal ranges from conventional lab reference ranges where relevant.
- Note missing reference ranges or limited context.
- Mention patterns commonly associated with hormonal transitions (perimenopause/menopause) where clinically relevant.
- Supplements: if potentially relevant, use only "may support..." or "commonly used for..." language. Explain why it may be relevant. Do not include exact dosages. Always add: consult your provider before starting any supplement, especially if you take medications or have health conditions.

Hard limits. Never cross these:
- No diagnosis of any condition.
- No instruction to change or stop any medication.
- No claims that any supplement treats, cures, or prevents any disease.
- Encourage the client to review results with a qualified doctor or provider, ideally a hormone specialist or functional medicine provider.

End every summary with this disclaimer verbatim:
"This summary is for educational purposes only. It is not medical advice, a diagnosis, or a treatment plan. Do not change any medication or supplement without speaking with your healthcare provider. Review your results with a qualified doctor or provider, ideally a hormone specialist or functional medicine provider."

Summarize the following lab results:
`

// ── Client routes (feature-flag gated) ────────────────────────────────────────

// GET /api/bloodwork — list own uploads
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role) && !clientEnabled()) {
      return res.status(403).json({ error: 'Bloodwork feature not yet available.' })
    }
    const { rows } = await pool.query(
      `SELECT id, original_filename, mime_type, lab_date, notes,
              extracted_text IS NOT NULL AS has_text,
              ai_summary IS NOT NULL AS has_summary,
              status, created_at
       FROM bloodwork_uploads
       WHERE user_id = $1 AND deleted = FALSE
       ORDER BY COALESCE(lab_date, created_at::date) DESC, created_at DESC`,
      [ctx.dbUserId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/bloodwork — upload new file
router.post('/', requireAuth(), bloodworkUploadLimit, upload.single('file'), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role) && !clientEnabled()) {
      return res.status(403).json({ error: 'Bloodwork feature not yet available.' })
    }
    if (!req.file) return res.status(400).json({ error: 'File required (PDF, JPG, PNG, or WEBP).' })
    if (!ALLOWED_MIMES.has(req.file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF, JPG, PNG, or WEBP.' })
    }
    const { lab_date, notes } = req.body
    const cloud = await uploadToCloud(req.file.buffer, req.file.mimetype)
    const extracted = await extractText(req.file.buffer, req.file.mimetype)
    const { rows } = await pool.query(
      `INSERT INTO bloodwork_uploads
         (user_id, cloudinary_public_id, original_filename, mime_type, lab_date, notes, extracted_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, original_filename, mime_type, lab_date, notes,
                 extracted_text IS NOT NULL AS has_text,
                 ai_summary IS NOT NULL AS has_summary,
                 status, created_at`,
      [ctx.dbUserId, cloud.public_id, req.file.originalname, req.file.mimetype,
       lab_date || null, notes?.trim() || null, extracted || null],
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// ── Staff routes ───────────────────────────────────────────────────────────────

// GET /api/bloodwork/staff/:clientId — list a client's uploads
router.get('/staff/:clientId', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const clientId = Number(req.params.clientId)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied.' })
    const { rows } = await pool.query(
      `SELECT id, original_filename, mime_type, lab_date, notes,
              extracted_text IS NOT NULL AS has_text,
              ai_summary, status, created_at
       FROM bloodwork_uploads
       WHERE user_id = $1 AND deleted = FALSE
       ORDER BY COALESCE(lab_date, created_at::date) DESC, created_at DESC`,
      [clientId],
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/bloodwork/:id/file — return authorized Cloudinary URL
router.get('/:id/file', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    const { rows } = await pool.query(
      'SELECT id, user_id, cloudinary_public_id, mime_type, deleted FROM bloodwork_uploads WHERE id = $1',
      [Number(req.params.id)],
    )
    if (!rows[0] || rows[0].deleted) return res.status(404).json({ error: 'Not found.' })
    const rec = rows[0]
    const isOwner = rec.user_id === ctx.dbUserId
    const staffAccess = isPrivileged(ctx.role) && (await canAccessClient(ctx, rec.user_id))
    if (!isOwner && !staffAccess) return res.status(403).json({ error: 'Access denied.' })
    const resourceType = rec.mime_type === 'application/pdf' ? 'raw' : 'image'
    const url = cloudinary.url(rec.cloudinary_public_id, { resource_type: resourceType, secure: true })
    res.json({ url })
  } catch (err) { next(err) }
})

// POST /api/bloodwork/:id/summarize — staff generates AI summary
router.post('/:id/summarize', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const { rows } = await pool.query(
      'SELECT id, user_id, extracted_text, deleted FROM bloodwork_uploads WHERE id = $1',
      [Number(req.params.id)],
    )
    if (!rows[0] || rows[0].deleted) return res.status(404).json({ error: 'Not found.' })
    if (!(await canAccessClient(ctx, rows[0].user_id))) return res.status(403).json({ error: 'Access denied.' })
    if (!rows[0].extracted_text) {
      return res.status(422).json({
        error: 'Could not extract readable lab text from this file. Please upload a clearer image or text-based PDF.',
      })
    }
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: SUMMARY_PROMPT + rows[0].extracted_text }],
    })
    const summary = msg.content[0]?.text?.trim()
    if (!summary) return res.status(500).json({ error: 'AI did not return a summary.' })
    await pool.query(
      'UPDATE bloodwork_uploads SET ai_summary = $1, updated_at = NOW() WHERE id = $2',
      [summary, rows[0].id],
    )
    res.json({ ai_summary: summary })
  } catch (err) { next(err) }
})

// DELETE /api/bloodwork/:id — staff soft delete
router.delete('/:id', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const { rows } = await pool.query(
      'SELECT id, user_id FROM bloodwork_uploads WHERE id = $1 AND deleted = FALSE',
      [Number(req.params.id)],
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found.' })
    if (!(await canAccessClient(ctx, rows[0].user_id))) return res.status(403).json({ error: 'Access denied.' })
    await pool.query(
      "UPDATE bloodwork_uploads SET deleted = TRUE, status = 'deleted', updated_at = NOW() WHERE id = $1",
      [rows[0].id],
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router
