import { createRequire } from 'module'
import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { bloodworkUploadLimit } from '../middleware/rateLimits.js'

// createRequire is set up at module level but pdf-parse is loaded lazily inside extractText
// so a missing package can never crash startup.
const require = createRequire(import.meta.url)

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

// Returns true if this client user should see their own Bloodwork panel.
// Privileged staff always bypass this check via isPrivileged() separately.
async function isBloodworkEnabled(dbUserId) {
  if (process.env.BLOODWORK_CLIENT_ENABLED === 'true') return true
  const { rows } = await pool.query('SELECT bloodwork_enabled FROM users WHERE id = $1', [dbUserId])
  return rows[0]?.bloodwork_enabled === true
}

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
    let parser
    try {
      // pdf-parse v2 exports a PDFParse class, not a function.
      // Previous code called require('pdf-parse')(buffer) which throws
      // "not a function" — silently caught, giving every PDF "No text extracted."
      const { PDFParse } = require('pdf-parse')
      parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      const text = result.text?.trim()
      return text?.length > 30 ? text : null
    } catch (err) {
      console.error('[bloodwork] PDF text extraction failed:', err?.message ?? err)
      return null
    } finally {
      try { await parser?.destroy() } catch { /* ignore cleanup errors */ }
    }
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

const SUMMARY_PROMPT = `You are a functional-health and longevity lab interpretation assistant. You use systems-level thinking and root-cause pattern recognition to help clients understand their labs in context. You respect conventional lab reference ranges and also discuss functional/optimal ranges where meaningful — always clearly labeling which is which. You do not diagnose, prescribe, or replace medical care.

══════════════════════════════════════════════════
STEP 1 — READ CLIENT CONTEXT BEFORE INTERPRETING
══════════════════════════════════════════════════
Before interpreting any lab value, identify and use any available client context in the notes or surrounding text:
• Age, sex, height, weight, BMI
• Diagnoses / medical history
• Medications and hormones (current)
• Supplement stack (current)
• Diet and nutrition patterns
• Symptoms the client is experiencing
• Previous lab values / trends
• Lifestyle: sleep, stress, exercise level

Never interpret values in isolation. If key context is missing, state clearly what is missing and how it could meaningfully change the interpretation.

══════════════════════════════════════════════════
STEP 2 — IDENTIFY PATTERNS, NOT JUST FLAGS
══════════════════════════════════════════════════
Do not list abnormal labs like a receipt. Group related markers into patterns and explain upstream causes and downstream effects. Use these groupings where applicable:
• Thyroid axis (TSH, Free T4, Free T3, Reverse T3, antibodies)
• Glucose / insulin / metabolic (fasting glucose, A1c, insulin, HOMA-IR)
• Inflammation (CRP, ESR, homocysteine, ferritin as acute-phase reactant)
• Iron / oxygen transport (iron, ferritin, TIBC, saturation, CBC)
• Hormones (estrogen, progesterone, testosterone, DHEA-S, cortisol, SHBG)
• Lipids / cardiovascular (LDL, HDL, triglycerides, LDL:HDL, TG:HDL, ApoB if present)
• Liver / detox (ALT, AST, GGT, bilirubin, alkaline phosphatase)
• Kidney (creatinine, BUN, BUN:creatinine, eGFR, uric acid)
• Nutrients (B12, folate, vitamin D, magnesium, zinc, ferritin)
• Adrenal / stress markers where available

Connect markers clearly. Explain what may be driving what.

SPECIAL CALCULATION RULES:
• HOMA-IR: Do NOT calculate or report HOMA-IR for any client with Type 1 diabetes, documented beta cell failure, or any condition that makes endogenous insulin measurement invalid. If the client context mentions T1D or beta cell failure, skip HOMA-IR entirely and explain why.
• Hormone/medication effects: If the client is on hormones (e.g., testosterone, estrogen, progesterone, thyroid hormone) or medications known to affect lab values, flag this BEFORE interpreting any affected marker. State clearly: "Interpretation is limited because this marker is significantly affected by [hormone/medication] and the current dose and draw timing are not available." Do not interpret affected markers as if the client were unmedicated.
• Medications not collected: Client medication data is not collected in this app version. If any lab pattern strongly suggests a medication effect (e.g., suppressed LH/FSH with high testosterone, unusual thyroid pattern), note the possibility and recommend confirming medication list with a provider before drawing conclusions.

══════════════════════════════════════════════════
STEP 3 — GENERATE THE REPORT IN TWO LAYERS
══════════════════════════════════════════════════

--- LAYER 1: SIMPLE SUMMARY ---
Write at a 5th-grade reading level. No jargon. Follow this structure:
1. What is going well — celebrate genuine positives, be specific.
2. What needs attention — explain what it means for daily life and energy, not just what the number is.
3. What seems managed well already — acknowledge efforts that are working.
4. Top 1–2 focus areas — what to work on first and why.

Avoid these terms in Layer 1: biomarker, aromatization, exogenous, suppressed, etiology, pathophysiology, hepatic, renal, endogenous, and similar heavy clinical language.

--- LAYER 2: CLINICAL DETAIL ---
Write for a health-literate adult. Include:
• Specific lab values and their reference ranges (conventional and functional/optimal where relevant — label each clearly)
• When citing a non-standard or functional medicine range, always label it exactly as: "Functional Medicine Target (not universally standardized)" — never present it as an established lab standard.
• Trends: improving / worsening / stable (when previous values are available)
• Connected marker patterns and what they suggest together
• What may be driving the pattern (upstream causes)
• What to watch at the next lab draw

══════════════════════════════════════════════════
STEP 4 — RECOMMENDATIONS TABLE
══════════════════════════════════════════════════
After the two layers, add a recommendations table with exactly these columns:

| Finding | Recommendation | Why It Matters | Confidence |

Rules for the table:
• Prioritize the top 3–5 highest-leverage actions only.
• Food, lifestyle, sleep, stress management, timing, and movement recommendations come before supplements when equally appropriate.
• Cross-reference any supplement stack mentioned in context — do not recommend supplements the client is already taking.
• Do not recommend anything that may conflict with current medications or hormones without flagging: "Discuss with your provider before adding this."
• Supplement language must use "may support" or "commonly used for." No exact dosages.
• Confidence labels (use exactly one per row):
  - Widely Supported
  - Based on Available Evidence
  - Emerging / Limited Evidence

══════════════════════════════════════════════════
STEP 5 — PROACTIVE FLAGS
══════════════════════════════════════════════════
After the table, add a "Proactive Flags" section. For each flag:
• State what the concern is in plain language.
• Explain why it matters.
• State what type of provider should review it (e.g., primary care, endocrinologist, cardiologist, functional medicine provider).
• Do not create fear — explain, don't alarm.
• If any marker is severely out of range or potentially urgent, recommend timely provider evaluation without delay.

══════════════════════════════════════════════════
STEP 6 — COMPLETION CHECK (internal — do not print this section header)
══════════════════════════════════════════════════
Before submitting the report, silently verify all of the following. If any check fails, fix it before outputting:
□ Layer 1 simple summary is present and written at a 5th-grade reading level.
□ Layer 2 clinical detail is present with specific values, reference ranges, and trend notes where available.
□ Recommendations table is complete — all four columns filled for every row.
□ Every table row has exactly one Confidence label (Widely Supported / Based on Available Evidence / Emerging / Limited Evidence).
□ No supplement in the table is already listed in the client's supplement stack from context.
□ The verbatim disclaimer is the absolute final line of the report.
□ The report does not end mid-sentence, mid-table, or mid-section.
□ No section is duplicated.

══════════════════════════════════════════════════
ACCURACY RULES (apply throughout)
══════════════════════════════════════════════════
• Be explicit when uncertain. Label evidence strength.
• Never present a guess as a fact.
• If markers conflict, explain possible reasons.
• If missing context would meaningfully change the interpretation, say so explicitly.
• Do not overclaim or underclaim.
• Do not just repeat lab values without interpretation — explain what they mean and why.

══════════════════════════════════════════════════
SAFETY — END EVERY REPORT WITH THIS DISCLAIMER VERBATIM
══════════════════════════════════════════════════
"This summary is for educational purposes only. It is not medical advice, a diagnosis, or a treatment plan. Do not change any medication, hormone, or supplement without speaking with your healthcare provider. Review your results with a qualified doctor or provider, ideally a hormone specialist or functional medicine provider."

`

// ── Client routes (feature-flag gated) ────────────────────────────────────────

// GET /api/bloodwork — list own uploads
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role) && !(await isBloodworkEnabled(ctx.dbUserId))) {
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
    if (!isPrivileged(ctx.role) && !(await isBloodworkEnabled(ctx.dbUserId))) {
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

// ── Client intake routes ──────────────────────────────────────────────────────
// Registered before /:id wildcards so "intake" is never treated as an upload id.

// GET /api/bloodwork/intake — load own intake
router.get('/intake', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role) && !(await isBloodworkEnabled(ctx.dbUserId))) {
      return res.status(403).json({ error: 'Bloodwork feature not yet available.' })
    }
    const { rows } = await pool.query(
      `SELECT conditions, medication_categories, confirmed_age, confirmed_sex,
              confirmed_height_inches, confirmed_weight_lbs, notes, updated_at
       FROM bloodwork_intake WHERE user_id = $1`,
      [ctx.dbUserId],
    )
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// PUT /api/bloodwork/intake — upsert own intake
router.put('/intake', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role) && !(await isBloodworkEnabled(ctx.dbUserId))) {
      return res.status(403).json({ error: 'Bloodwork feature not yet available.' })
    }
    const { conditions, medication_categories, confirmed_age, confirmed_sex,
            confirmed_height_inches, confirmed_weight_lbs, notes } = req.body ?? {}
    const { rows } = await pool.query(
      `INSERT INTO bloodwork_intake
         (user_id, conditions, medication_categories, confirmed_age, confirmed_sex,
          confirmed_height_inches, confirmed_weight_lbs, notes, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         conditions              = EXCLUDED.conditions,
         medication_categories   = EXCLUDED.medication_categories,
         confirmed_age           = EXCLUDED.confirmed_age,
         confirmed_sex           = EXCLUDED.confirmed_sex,
         confirmed_height_inches = EXCLUDED.confirmed_height_inches,
         confirmed_weight_lbs    = EXCLUDED.confirmed_weight_lbs,
         notes                   = EXCLUDED.notes,
         updated_at              = NOW()
       RETURNING conditions, medication_categories, confirmed_age, confirmed_sex,
                 confirmed_height_inches, confirmed_weight_lbs, notes, updated_at`,
      [
        ctx.dbUserId,
        JSON.stringify(conditions ?? []),
        JSON.stringify(medication_categories ?? []),
        confirmed_age || null,
        confirmed_sex?.trim() || null,
        confirmed_height_inches || null,
        confirmed_weight_lbs || null,
        notes?.trim() || null,
      ],
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ── Client context helper for AI summarize ────────────────────────────────────

async function buildClientContext(userId) {
  try {
    const [uR, haR, weightR, prevR, intakeR] = await Promise.all([
      pool.query(
        `SELECT gender, coaching_type, start_date,
                height_inches, age, starting_weight_lbs, goal_weight_lbs
         FROM users WHERE id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT date_of_birth, supplements, goals_6_months, injuries_limitations,
                energy_level, sleep_hours, stress_management, sleep_quality,
                activity_level, alcohol_weekdays, alcohol_weekends
         FROM health_assessments WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT weight_lbs, logged_date FROM daily_logs
         WHERE user_id = $1 AND weight_lbs IS NOT NULL
         ORDER BY logged_date DESC LIMIT 1`,
        [userId],
      ),
      pool.query(
        `SELECT lab_date, ai_summary, created_at FROM bloodwork_uploads
         WHERE user_id = $1 AND deleted = FALSE AND ai_summary IS NOT NULL
         ORDER BY COALESCE(lab_date, created_at::date) DESC LIMIT 3`,
        [userId],
      ),
      pool.query(
        `SELECT conditions, medication_categories, confirmed_age, confirmed_sex,
                confirmed_height_inches, confirmed_weight_lbs, notes
         FROM bloodwork_intake WHERE user_id = $1`,
        [userId],
      ),
    ])

    const u      = uR.rows[0]     ?? {}
    const ha     = haR.rows[0]    ?? {}
    const wt     = weightR.rows[0]
    const prev   = prevR.rows
    const intake = intakeR.rows[0] ?? null

    const lines = []

    // ── Age — intake confirmed value takes priority ──────────────────────────
    if (intake?.confirmed_age) {
      lines.push(`Age (client confirmed): ${intake.confirmed_age}`)
    } else if (ha.date_of_birth) {
      const age = Math.floor((Date.now() - new Date(ha.date_of_birth)) / 31_557_600_000)
      lines.push(`Age: ${age}`)
    } else if (u.age) {
      lines.push(`Age: ${u.age}`)
    } else {
      lines.push('Age: not provided')
    }

    // ── Biological sex ───────────────────────────────────────────────────────
    if (intake?.confirmed_sex) {
      lines.push(`Biological sex (client confirmed): ${intake.confirmed_sex}`)
    } else {
      lines.push(`Sex/Gender: ${u.gender ?? 'not provided'}`)
    }

    // ── Height ───────────────────────────────────────────────────────────────
    const heightIn = Number(intake?.confirmed_height_inches ?? u.height_inches ?? 0) || null
    if (heightIn) {
      const ft = Math.floor(heightIn / 12)
      const inch = Math.round(heightIn % 12)
      const src = intake?.confirmed_height_inches ? ' (client confirmed)' : ''
      lines.push(`Height${src}: ${ft}'${inch}" (${heightIn} inches)`)
    } else {
      lines.push('Height: not provided')
    }

    // ── Weight + BMI — intake confirmed weight takes priority ────────────────
    const intakeWeight  = intake?.confirmed_weight_lbs  ? Number(intake.confirmed_weight_lbs)  : null
    const recentWeight  = wt?.weight_lbs                ? Number(wt.weight_lbs)                : null
    const effectiveWeight = intakeWeight ?? recentWeight

    if (intakeWeight) {
      lines.push(`Weight (client confirmed): ${intakeWeight} lbs`)
    } else if (recentWeight) {
      lines.push(`Recent weight: ${recentWeight} lbs (${String(wt.logged_date).slice(0, 10)})`)
    } else if (u.starting_weight_lbs) {
      lines.push(`Starting weight (no recent log): ${u.starting_weight_lbs} lbs`)
    } else {
      lines.push('Weight: not provided')
    }

    if (effectiveWeight && heightIn) {
      const bmi = ((effectiveWeight / (heightIn ** 2)) * 703).toFixed(1)
      lines.push(`Calculated BMI: ${bmi}`)
    }

    if (u.starting_weight_lbs && !intakeWeight) lines.push(`Starting weight: ${u.starting_weight_lbs} lbs`)
    if (u.goal_weight_lbs)  lines.push(`Goal weight: ${u.goal_weight_lbs} lbs`)
    if (u.coaching_type)    lines.push(`Coaching type: ${u.coaching_type}`)
    if (u.start_date)       lines.push(`Program start: ${String(u.start_date).slice(0, 10)}`)

    lines.push(`Goals (6-month): ${ha.goals_6_months ?? 'not provided'}`)
    if (ha.injuries_limitations) lines.push(`Health history / limitations (self-reported): ${ha.injuries_limitations}`)

    // ── Intake questionnaire: conditions + medications ───────────────────────
    if (intake) {
      const conds = Array.isArray(intake.conditions) ? intake.conditions : []
      const hasRealConditions = conds.some(c => c !== 'none')
      if (hasRealConditions) {
        lines.push(`Medical conditions (client confirmed): ${conds.filter(c => c !== 'none').join(', ')}`)
      } else if (conds.includes('none')) {
        lines.push('Medical conditions (client confirmed): None of the above')
      }

      const meds = Array.isArray(intake.medication_categories) ? intake.medication_categories : []
      const hasRealMeds = meds.some(m => m !== 'none')
      if (hasRealMeds) {
        lines.push(`Prescription medication categories (client confirmed): ${meds.filter(m => m !== 'none').join(', ')}`)
      } else if (meds.includes('none')) {
        lines.push('Prescription medications (client confirmed): None')
      } else {
        lines.push('Prescription medications: client has not specified')
      }

      if (intake.notes?.trim()) lines.push(`Additional client notes: ${intake.notes.trim()}`)
    } else {
      lines.push('Medical conditions: intake questionnaire not completed — do not assume absence of conditions or medications')
      lines.push('Prescription medications: NOT COLLECTED — client has not completed intake questionnaire')
    }

    lines.push(`Current supplements (self-reported): ${ha.supplements ?? 'not provided'}`)
    if (ha.activity_level)         lines.push(`Activity level: ${ha.activity_level}`)
    if (ha.sleep_hours)            lines.push(`Typical sleep: ${ha.sleep_hours} hrs/night`)
    if (ha.sleep_quality  != null) lines.push(`Sleep quality (self-rated): ${ha.sleep_quality}/5`)
    if (ha.stress_management != null) lines.push(`Stress management (self-rated): ${ha.stress_management}/5`)
    if (ha.energy_level   != null) lines.push(`Energy level (self-rated): ${ha.energy_level}/5`)
    const wd = ha.alcohol_weekdays ?? 0
    const we = ha.alcohol_weekends ?? 0
    if (wd || we) lines.push(`Alcohol: ${wd} drinks/weekday avg, ${we} drinks/weekend day avg`)

    if (prev.length > 0) {
      lines.push('\nPrevious bloodwork summaries (most recent first — use for trend comparison):')
      for (const p of prev) {
        const d = p.lab_date ? String(p.lab_date).slice(0, 10) : String(p.created_at).slice(0, 10)
        const snippet = p.ai_summary.length > 600 ? p.ai_summary.slice(0, 600) + '…' : p.ai_summary
        lines.push(`[${d}] ${snippet}`)
      }
    }

    return lines.join('\n')
  } catch (err) {
    console.error('[bloodwork] buildClientContext failed:', err?.message)
    return null
  }
}

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

// POST /api/bloodwork/staff/:clientId — staff uploads on behalf of a client
router.post('/staff/:clientId', requireAuth(), bloodworkUploadLimit, upload.single('file'), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const clientId = Number(req.params.clientId)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied.' })
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
                 ai_summary, status, created_at`,
      [clientId, cloud.public_id, req.file.originalname, req.file.mimetype,
       lab_date || null, notes?.trim() || null, extracted || null],
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/bloodwork/staff/:clientId/access — toggle bloodwork_enabled for a client
router.patch('/staff/:clientId/access', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const clientId = Number(req.params.clientId)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied.' })
    const enabled = Boolean(req.body?.enabled)
    await pool.query('UPDATE users SET bloodwork_enabled = $1 WHERE id = $2', [enabled, clientId])
    res.json({ bloodwork_enabled: enabled })
  } catch (err) { next(err) }
})

// GET /api/bloodwork/staff/:clientId/intake — load client intake
router.get('/staff/:clientId/intake', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const clientId = Number(req.params.clientId)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied.' })
    const { rows } = await pool.query(
      `SELECT conditions, medication_categories, confirmed_age, confirmed_sex,
              confirmed_height_inches, confirmed_weight_lbs, notes, updated_at
       FROM bloodwork_intake WHERE user_id = $1`,
      [clientId],
    )
    res.json(rows[0] ?? null)
  } catch (err) { next(err) }
})

// PUT /api/bloodwork/staff/:clientId/intake — staff saves/updates client intake
router.put('/staff/:clientId/intake', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    if (!isPrivileged(ctx.role)) return res.status(403).json({ error: 'Staff only.' })
    const clientId = Number(req.params.clientId)
    if (!(await canAccessClient(ctx, clientId))) return res.status(403).json({ error: 'Access denied.' })
    const { conditions, medication_categories, confirmed_age, confirmed_sex,
            confirmed_height_inches, confirmed_weight_lbs, notes } = req.body ?? {}
    const { rows } = await pool.query(
      `INSERT INTO bloodwork_intake
         (user_id, conditions, medication_categories, confirmed_age, confirmed_sex,
          confirmed_height_inches, confirmed_weight_lbs, notes, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         conditions              = EXCLUDED.conditions,
         medication_categories   = EXCLUDED.medication_categories,
         confirmed_age           = EXCLUDED.confirmed_age,
         confirmed_sex           = EXCLUDED.confirmed_sex,
         confirmed_height_inches = EXCLUDED.confirmed_height_inches,
         confirmed_weight_lbs    = EXCLUDED.confirmed_weight_lbs,
         notes                   = EXCLUDED.notes,
         updated_at              = NOW()
       RETURNING conditions, medication_categories, confirmed_age, confirmed_sex,
                 confirmed_height_inches, confirmed_weight_lbs, notes, updated_at`,
      [
        clientId,
        JSON.stringify(conditions ?? []),
        JSON.stringify(medication_categories ?? []),
        confirmed_age || null,
        confirmed_sex?.trim() || null,
        confirmed_height_inches || null,
        confirmed_weight_lbs || null,
        notes?.trim() || null,
      ],
    )
    res.json(rows[0])
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
    const clientContext = await buildClientContext(rows[0].user_id)
    const contextBlock = clientContext
      ? `\n\n══════════════════════════════════════════════════\nCLIENT CONTEXT (provided by their coaching program):\n══════════════════════════════════════════════════\n${clientContext}\n\n`
      : ''
    const labBlock = `\n\n══════════════════════════════════════════════════\nLAB RESULTS TO INTERPRET:\n══════════════════════════════════════════════════\n${rows[0].extracted_text}`
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: SUMMARY_PROMPT + contextBlock + labBlock }],
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
