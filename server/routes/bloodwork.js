import { createRequire } from 'module'
import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { bloodworkUploadLimit } from '../middleware/rateLimits.js'
import { trackEvent } from '../services/usageTracker.js'

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
      const ocrT0 = Date.now()
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
      // Track OCR call — actorUserId unknown here, will be set by caller wrapper
      _lastOcrEvent = {
        feature:      'bloodwork_ocr',
        action:       'ai_call',
        provider:     'anthropic',
        providerOp:   'messages.create',
        model:        'claude-haiku-4-5-20251001',
        inputTokens:  msg.usage?.input_tokens,
        outputTokens: msg.usage?.output_tokens,
        fileCount:    1,
        bytesIn:      buffer.length,
        durationMs:   Date.now() - ocrT0,
        metadata:     { mime_type: mimetype },
      }
      const text = msg.content[0]?.text?.trim()
      return text?.length > 30 ? text : null
    } catch { _lastOcrEvent = null; return null }
  }
  _lastOcrEvent = null
  return null
}
// Temp holder so the route handler can pick up OCR tracking data
let _lastOcrEvent = null

const SUMMARY_PROMPT = `You are a functional-health and longevity lab interpretation assistant. You use systems-level thinking and root-cause pattern recognition to help clients understand their labs in context. You respect conventional lab reference ranges and also discuss functional/optimal ranges where meaningful — always labeling which is which. You do not diagnose, prescribe, or replace medical care.

══════════════════════════════════════════════════
STEP 1 — READ CLIENT CONTEXT BEFORE INTERPRETING
══════════════════════════════════════════════════
Before interpreting any lab value, absorb all available client context:
• Age, sex, height, weight, BMI
• Diagnoses / medical history / confirmed conditions
• Medications and hormones (current — if not provided, note it; do not assume absent)
• Supplement stack (current)
• Diet and nutrition patterns
• Symptoms the client is experiencing
• Previous lab values / trends
• Lifestyle: sleep, stress, exercise level

Do NOT open the report with context warnings, disclaimers, or caveats. Use context silently to inform interpretation. State missing context only inline — at the specific marker where it changes interpretation — not as a preamble.

DISCLAIMER RULE: The legal disclaimer appears EXACTLY ONCE — as the absolute final block of the report, verbatim. Do not include disclaimer language or medical-advice caveats anywhere else in the report. Do not stack multiple caveat paragraphs.

HARD CUTOFF RULE: If approaching output length limits, complete the current sentence, write this exactly:

---
⚠ REPORT LENGTH LIMIT REACHED
Type "Continue report" to receive the remaining sections: [list what's missing]
---

Never end mid-sentence under any circumstances.

══════════════════════════════════════════════════
STEP 2 — IDENTIFY PATTERNS, NOT JUST FLAGS
══════════════════════════════════════════════════
Do not list abnormal labs like a receipt. Group related markers into patterns and explain upstream causes and downstream effects. Use these groupings where applicable:
• Thyroid axis (TSH, Free T4, Free T3, Reverse T3, antibodies)
• Glucose / insulin / metabolic (fasting glucose, A1c, insulin, HOMA-IR)
• Inflammation (CRP, ESR, homocysteine, ferritin as acute-phase reactant)
• Iron / oxygen transport (iron, ferritin, TIBC, saturation, CBC)
• Hormones (estrogen, progesterone, testosterone, DHEA-S, cortisol, SHBG, leptin)
• Lipids / cardiovascular (LDL, HDL, triglycerides, LDL:HDL, TG:HDL, ApoB if present, LDL particle size)
• Liver / detox (ALT, AST, GGT, bilirubin, alkaline phosphatase)
• Kidney (creatinine, BUN, BUN:creatinine, eGFR, uric acid)
• Nutrients (B12, folate, vitamin D, magnesium, zinc, ferritin)
• Adrenal / stress markers where available
• Heavy metals / environmental markers where present (mercury, lead, arsenic)

Connect markers clearly. Explain what may be driving what.

LEPTIN PATTERN: If leptin is present and very low — especially in a lean client or someone actively pursuing further weight loss — connect it to possible low energy availability or recovery strain. Look for and discuss the following related patterns where present: thyroid output (particularly Free T3 / Reverse T3 ratio), total cholesterol trending low, LDL peak size drop, cortisol patterns, HRV, recovery capacity, libido, mood, appetite signaling, and training stress. These co-occurring patterns can reinforce the low-energy-availability picture. Do not diagnose. Frame as a pattern worth addressing proactively.

LDL PEAK SIZE: If LDL peak size (particle size) is mentioned and has shifted smaller or dropped, identify and discuss possible contributing drivers: caloric deficit or low fat intake, elevated glucose or insulin load, thyroid suppression, hormone changes, or stress-related metabolic shifts. Connect to the broader lipid pattern and other co-occurring markers.

MERCURY / HEAVY METALS: If mercury or other heavy metals are present and elevated, flag it clearly. Suggest a specific, actionable next step (e.g., reduce high-mercury fish and replace with low-mercury options such as salmon, sardines, or tilapia). State whether the level warrants further workup or is likely manageable through dietary changes. Do not leave the finding unresolved.

SPECIAL CALCULATION RULES:
• HOMA-IR: Do NOT calculate or report HOMA-IR for any client with Type 1 diabetes, documented beta cell failure, or any condition that makes endogenous insulin measurement invalid. If Type 1 diabetes or beta cell failure appears in client context, skip HOMA-IR and state why.
• Hormone/medication effects: If the client is on hormones (testosterone, estrogen, progesterone, thyroid) or medications that affect lab values, note the limitation inline on the specific marker it affects. Do not interpret affected markers as if the client were unmedicated.
• Medications not collected: If any lab pattern strongly suggests a medication effect (e.g., suppressed LH/FSH with high testosterone, unusual thyroid pattern), note the possibility inline — do not open the report with this caveat.

eGFR/KIDNEY LANGUAGE: Soften eGFR language. Do not mention CKD staging unless the trend is worsening or clearly clinically relevant. Preferred phrasing when applicable: "eGFR of 70 is within the conventional normal range. This value is stable and consistent with prior results. For someone with Type 1 diabetes, ongoing annual monitoring is appropriate — no change indicated at this time."

══════════════════════════════════════════════════
STEP 3 — REPORT STRUCTURE (follow this order exactly)
══════════════════════════════════════════════════

The report must open and flow in this exact sequence. Do not deviate:
1. Executive Summary
2. Wins
3. What Needs Attention
4. Supplement and Action Table
5. Prescriber Flags
6. Clinical Detail
7. Disclaimer

--- SECTION 1: EXECUTIVE SUMMARY ---
Open every report with this exact header and structure. Maximum 8 lines total. Keep it simple, direct, and client-friendly.

## Executive Summary

### Your Top 3 Wins
- ...

### Your Top 2 Priorities
- ...

### Your 3 Action Items This Week
- ...

--- SECTION 2: WINS ---
Use this exact header:

## Wins

Plain language. No jargon.
Important wins each get their own clear sentence. Do not bury significant improvements inside long grouped paragraphs.
Examples of wins that deserve their own standalone sentence:
  • A1c improvement or reaching target range
  • CRP at optimal range — inflammation under control
  • Homocysteine improved or optimal — methylation on track
  • ApoB or LDL-P improvement
  • Vitamin D now in target range
  • LDL pattern improvement, particle size or ratio improvement
  • Any marker that meaningfully improved since the last draw
Celebrate real positives. Be specific. Keep it confidence-building. Do not manufacture wins that are not there.

--- SECTION 3: WHAT NEEDS ATTENTION ---
Use this exact header:

## What Needs Attention

Plain language (no jargon). Explain what each finding means for the client's daily life, energy, performance, and how they feel — not just what the number is. Top 1–2 priority areas. Be direct. State the actual recommendation, not a vague deferral.

--- SECTION 4: SUPPLEMENT AND ACTION TABLE ---
THE SUPPLEMENT AND ACTION TABLE IS MANDATORY OUTPUT.
It must appear before Prescriber Flags so it does not get cut off.
If this table is missing, the report is incomplete. Do not end the report without it.

Use exactly:

## Supplement and Action Table

| Finding | Recommended Action | Confidence Level |
|---|---|---|
| [specific marker or pattern] | [specific supplement, food, lifestyle, timing, sleep, stress, movement, or habit action] | [Widely Supported / Based on Available Evidence / Emerging Research] |

Rules:
• Maximum 6 rows.
• Include only client-actionable items.
• Include at least one non-supplement action.
• Do not recommend anything already in current supplement stack.
• No exact supplement dosages unless approved internal protocol exists.
• Use "may support" or "commonly used for" language for supplements.
• Do not put prescriber/medication review items in this table.
• Confidence Level must be exactly one of: Widely Supported / Based on Available Evidence / Emerging Research

FLAGGED MARKER RULE: Every marker or pattern that is flagged as a concern must include a clear next step. Choose the appropriate response:
  → Action to take (e.g., dietary change, lifestyle change, timing adjustment)
  → Monitor / no change needed (explain why)
  → Retest timing (e.g., "retest in 6–8 weeks")
  → Prescriber review if medically sensitive (put that in the Prescriber Flags section below)
Do not flag something and leave it without resolution.

══════════════════════════════════════════════════
STEP 4 — PRESCRIBER FLAGS (include only when needed)
══════════════════════════════════════════════════
If any findings require medical review, hormone adjustment, or medication consideration, include this section AFTER the Supplement and Action Table using this exact header:

## Prescriber Flags

Use this section for items such as:
• Thyroid medication or dosing strategy review
• Hormone therapy review (testosterone, estrogen, progesterone)
• Estradiol management or estrogen/progesterone balance
• Diabetes medication changes
• Blood pressure medication concerns
• Kidney or liver red flags
• Any medication interaction concern

Format each flag as a direct, actionable sentence — not a vague "see your doctor" note.
Example: "Free T3 is below functional target and Reverse T3 is elevated — priority: review thyroid dosing strategy and retest Free T3 and Reverse T3 in 6 weeks."

If there are no prescriber-sensitive items, omit this section entirely. Do not include it as a placeholder.

══════════════════════════════════════════════════
STEP 5 — CLINICAL DETAIL
══════════════════════════════════════════════════
Use this exact header:

## Clinical Detail

Write for a health-literate adult. Include:
• Specific lab values with conventional reference ranges (label Functional Medicine Targets exactly as: "Functional Medicine Target (not universally standardized)")
• Trends: improving / worsening / stable when previous values are available
• Connected marker patterns and what they suggest together
• What may be driving the pattern (upstream causes)
• What to watch at the next lab draw
• Context limitations go INLINE only where they materially change interpretation of a specific marker

══════════════════════════════════════════════════
STEP 6 — PROVIDER LANGUAGE RULES (apply throughout)
══════════════════════════════════════════════════
Do NOT use provider-role phrases (your doctor, your care team, your provider, your endocrinologist, your hormone doctor, your thyroid doctor, your cardiologist, etc.) anywhere in the report except:
  1. The Prescriber Flags section, where direct language about bringing findings to an appointment is appropriate.
  2. The final disclaimer (verbatim only).

Everywhere else, state the recommendation directly.

Bad: "Your thyroid doctor needs to know about this."
Good: "Priority action: review thyroid dosing strategy and retest Free T3 and Reverse T3 in 6 weeks." (put this in Prescriber Flags)

Bad: "Discuss this with your care team."
Good: "This pattern warrants follow-up labs in 8 weeks to confirm the trend."

══════════════════════════════════════════════════
STEP 7 — CUTOFF PREVENTION + COMPLETION CHECK
══════════════════════════════════════════════════
If you are approaching output length limits before completing the report:
→ Complete the current sentence cleanly.
→ Write exactly:
---
⚠ REPORT LENGTH LIMIT REACHED
Type "Continue report" to receive the remaining sections: [list what's missing]
---
→ Stop. Never end mid-sentence, mid-table row, or mid-section under any circumstances.

Before finalizing, silently verify:
□ Report opens with Executive Summary and follows the exact required order.
□ WINS section is present — major improvements each have their own clear sentence, not buried in paragraphs.
□ WHAT NEEDS ATTENTION section is present.
□ Supplement and Action Table appears before Prescriber Flags, uses the 3-column format, max 6 rows, and is client-actionable only.
□ Prescriber Flags section is used only for medical/hormone/medication review items and does not replace the client-actionable table.
□ CLINICAL DETAIL section appears after Prescriber Flags and includes specific values, reference ranges, and trend notes.
□ Every flagged marker or pattern has a clear next step (action / monitor / retest timing / Prescriber Flags entry).
□ LDL peak size drop (if present) is connected to possible drivers.
□ Mercury or heavy metals (if present) have a specific actionable next step.
□ Leptin (if very low) is connected to energy availability, thyroid, cholesterol, and recovery patterns.
□ At least one non-supplement action appears in the table.
□ No supplement in the table is already in the client's supplement stack.
□ Provider-role phrases appear only in Prescriber Flags and the final disclaimer.
□ The verbatim disclaimer appears EXACTLY ONCE — as the absolute final block of the report.
□ No disclaimer language appears anywhere earlier in the report.
□ eGFR language is softened; do not mention CKD staging unless worsening or clearly clinically relevant.
□ No section is duplicated or cut off; the report does not end mid-sentence.

══════════════════════════════════════════════════
ACCURACY RULES (apply throughout)
══════════════════════════════════════════════════
• Be explicit when uncertain. Label evidence strength.
• Never present a guess as a fact.
• If markers conflict, explain possible reasons.
• If missing context changes a specific interpretation, say so at that marker — not globally.
• Do not overclaim or underclaim.
• Do not just repeat lab values — explain what they mean and why they matter.

══════════════════════════════════════════════════
SAFETY — END EVERY REPORT WITH THIS DISCLAIMER VERBATIM
══════════════════════════════════════════════════
"This summary is for educational purposes only. It is not medical advice, a diagnosis, or a treatment plan. Do not change any medication, hormone, or supplement without speaking with your healthcare provider. Review your results with a qualified doctor or provider, ideally a hormone specialist or functional medicine provider."

`

const CLIENT_SUMMARY_PROMPT = `You are a health coach AI helping women understand their bloodwork in plain, encouraging language. Your job is not to diagnose or replace a doctor. Your job is to help her understand what her labs mean, what to focus on, and what to do next.
Keep the entire summary under 400 words. No clinical language. No hedging. No "discuss with your clinician" on every point.
Format the response exactly like this:

## Overall Status
One paragraph, 2-3 sentences max. Tell her how she's doing overall in plain English. Start with the good news.

## Your Results by Area
For each area, show a status indicator and one plain English sentence.
🟢 Metabolic Health — [one sentence]
🟢 Liver Health — [one sentence]
🟡 Heart Health — [one sentence]
🔴 Inflammation — [one sentence]
Only include areas that have data.

## Your Biggest Win
One sentence. What is she doing really well?

## Your Top Focus Right Now
The single most important thing to address. Two sentences max.

## What To Do This Week
3 action items only. Plain English. Specific and actionable.

## Supplements Worth Considering
Only suggest supplements supported by her actual results. Format as:
| Supplement | Why it matters for you | Suggested amount |
|---|---|---|
No more than 4 supplements. Skip this section if nothing is clearly indicated.

## One Coaching Insight
One or two sentences connecting her labs to how she's actually feeling in real life. Make it personal and real.

Do not add extra sections. Do not add follow-up questions. Do not use tables except for the supplement section. Do not use clinical reference ranges in the output.

This summary is for informational purposes only and is not medical advice, a diagnosis, or a treatment plan.
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
              ai_client_summary IS NOT NULL AS has_client_summary,
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
    // Track upload (non-blocking)
    trackEvent({
      actorUserId: ctx.dbUserId,
      feature:     'bloodwork_upload',
      action:      'upload',
      provider:    'cloudinary',
      providerOp:  'upload_stream',
      fileCount:   1,
      bytesIn:     req.file.size,
      metadata:    { mime_type: req.file.mimetype },
    })
    // Track OCR if it ran
    if (_lastOcrEvent) {
      trackEvent({ ..._lastOcrEvent, actorUserId: ctx.dbUserId })
      _lastOcrEvent = null
    }
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
    // Track staff upload (actor = staff, target = client)
    trackEvent({
      actorUserId:  ctx.dbUserId,
      targetUserId: clientId,
      feature:      'bloodwork_upload',
      action:       'upload',
      provider:     'cloudinary',
      providerOp:   'upload_stream',
      fileCount:    1,
      bytesIn:      req.file.size,
      metadata:     { mime_type: req.file.mimetype, uploaded_by: 'staff' },
    })
    if (_lastOcrEvent) {
      trackEvent({ ..._lastOcrEvent, actorUserId: ctx.dbUserId, targetUserId: clientId })
      _lastOcrEvent = null
    }
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

// GET /api/bloodwork/:id/summary — client reads own client-friendly AI summary
router.get('/:id/summary', requireAuth(), async (req, res, next) => {
  try {
    const ctx = await getCtx(req)
    const { rows } = await pool.query(
      'SELECT id, user_id, ai_client_summary, deleted FROM bloodwork_uploads WHERE id = $1',
      [Number(req.params.id)],
    )
    if (!rows[0] || rows[0].deleted) return res.status(404).json({ error: 'Not found.' })
    const rec = rows[0]
    const isOwner = rec.user_id === ctx.dbUserId
    const staffAccess = isPrivileged(ctx.role) && (await canAccessClient(ctx, rec.user_id))
    if (!isOwner && !staffAccess) return res.status(403).json({ error: 'Access denied.' })
    if (isOwner && !isPrivileged(ctx.role) && !(await isBloodworkEnabled(ctx.dbUserId))) {
      return res.status(403).json({ error: 'Bloodwork feature not yet available.' })
    }
    res.json({ ai_client_summary: rec.ai_client_summary ?? null })
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

    // ── Primary: staff deep summary ───────────────────────────────────────────
    const sumT0 = Date.now()
    const staffMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: SUMMARY_PROMPT + contextBlock + labBlock }],
    })
    const durationMs = Date.now() - sumT0

    const summary = staffMsg.content[0]?.text?.trim()
    if (!summary) return res.status(500).json({ error: 'AI did not return a summary.' })

    await pool.query(
      'UPDATE bloodwork_uploads SET ai_summary = $1, updated_at = NOW() WHERE id = $2',
      [summary, rows[0].id],
    )

    // Track staff summary call (non-blocking)
    trackEvent({
      actorUserId:  ctx.dbUserId,
      targetUserId: rows[0].user_id,
      feature:      'bloodwork_summary',
      action:       'ai_call',
      provider:     'anthropic',
      providerOp:   'messages.create',
      model:        'claude-sonnet-4-6',
      inputTokens:  staffMsg.usage?.input_tokens,
      outputTokens: staffMsg.usage?.output_tokens,
      durationMs,
    })

    // Return to staff immediately — client summary generated below, non-blocking
    res.json({ ai_summary: summary })

    // ── Secondary: client-friendly summary (failure must not affect staff response) ──
    try {
      const clientMsg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: CLIENT_SUMMARY_PROMPT + contextBlock + labBlock }],
      })
      const clientSummary = clientMsg.content[0]?.text?.trim()
      if (clientSummary) {
        await pool.query(
          'UPDATE bloodwork_uploads SET ai_client_summary = $1, updated_at = NOW() WHERE id = $2',
          [clientSummary, rows[0].id],
        )
      }
    } catch (clientErr) {
      console.error('[bloodwork] client summary generation failed (non-fatal):', clientErr?.message)
    }
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
