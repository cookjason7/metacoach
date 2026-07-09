/**
 * server/services/workoutGenerator.js
 *
 * Shared "Katie" workout-generation logic used by both the client-facing
 * generator (routes/workouts.js) and the coach-facing generator
 * (routes/coachAdmin.js). Previously each route file duplicated an identical
 * prompt-builder and let Claude invent exercise names freely with no
 * categorization. Now:
 *
 *   1. Each training day is filled from a fixed movement-pattern quota
 *      (squat, hinge, upper_push, upper_pull, core, +optional carry/conditioning)
 *   2. Actual exercises are picked from the `exercises` library table, not
 *      invented by the model — this is what makes selection auditable/
 *      categorized instead of free text.
 *   3. Claude's job shrinks to what it's actually good at: sets/reps/rest/
 *      coaching notes for the given exercises, warm-up/cool-down copy, and
 *      the overall program name/description — Katie's tone is unchanged.
 *   4. squat/hinge slots default to unilateral variants unless the client's
 *      injuries/limitations text (questionnaire answer or saved health
 *      assessment) signals a reason to prefer bilateral, or a coach override
 *      is passed explicitly.
 */

import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

/** Thrown when the exercise library can't support the requested plan — surfaced to
 * the API as an explicit error response instead of silently returning a broken plan. */
export class ExerciseLibraryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ExerciseLibraryError'
    this.status = 503
  }
}

// ── Day template ─────────────────────────────────────────────────────────────
// Core quota every training day gets, plus one bonus slot on longer sessions.
const BASE_QUOTA  = ['squat', 'hinge', 'upper_push', 'upper_pull', 'core']
const BONUS_SLOTS = ['carry', 'conditioning']

function buildDayQuota(dayIndex, sessionLength) {
  const quota = [...BASE_QUOTA]
  const longSession = sessionLength === '60 minutes' || sessionLength === '90 minutes'
  if (longSession) quota.push(BONUS_SLOTS[dayIndex % BONUS_SLOTS.length])
  return quota
}

// ── Unilateral default ───────────────────────────────────────────────────────
// squat/hinge default to unilateral variants unless something calls for
// bilateral work: injury/balance-related keywords in the client's stated
// limitations, or an explicit coach override.
const BILATERAL_SIGNAL_RE = /\b(knee|ankle|balance|hip|vertigo|dizz|stability|fall(ing)?)\b/i

export function shouldPreferBilateral({ injuries, healthAssessmentInjuries, forceBilateral }) {
  if (forceBilateral) return true
  const text = [injuries, healthAssessmentInjuries].filter(Boolean).join(' ')
  return BILATERAL_SIGNAL_RE.test(text)
}

// ── Exercise selection ───────────────────────────────────────────────────────

const EQUIPMENT_MAP = {
  'Bodyweight only':   ['body only'],
  'Resistance bands':  ['bands', 'body only'],
  'Dumbbells':         ['dumbbell', 'body only'],
  'Barbell + Rack':    ['barbell', 'dumbbell', 'body only'],
  'Full gym':          null, // no filter — everything available
}

function resolveEquipmentList(equipmentAnswers) {
  const list = Array.isArray(equipmentAnswers) ? equipmentAnswers : [equipmentAnswers].filter(Boolean)
  if (!list.length || list.includes('Full gym')) return null
  const set = new Set()
  for (const eq of list) {
    for (const mapped of EQUIPMENT_MAP[eq] ?? []) set.add(mapped)
  }
  return set.size ? [...set] : null
}

const FITNESS_LEVEL_MAP = { Beginner: 'beginner', Intermediate: 'intermediate', Advanced: 'advanced' }

/** Picks one exercise for `pattern`, relaxing filters progressively until something is found. */
async function pickExercise(pool, { pattern, equipmentList, difficulty, excludeIds }) {
  const attempts = [
    { useEquipment: true,  useDifficulty: true  },
    { useEquipment: true,  useDifficulty: false },
    { useEquipment: false, useDifficulty: false },
  ]
  for (const { useEquipment, useDifficulty } of attempts) {
    const conditions = ['movement_pattern = $1']
    const params = [pattern]
    if (excludeIds.length) {
      params.push(excludeIds)
      conditions.push(`id != ALL($${params.length})`)
    }
    if (useEquipment && equipmentList?.length) {
      params.push(equipmentList)
      conditions.push(`equipment = ANY($${params.length})`)
    }
    if (useDifficulty && difficulty) {
      params.push(difficulty)
      conditions.push(`difficulty = $${params.length}`)
    }
    const { rows } = await pool.query(
      `SELECT * FROM exercises WHERE ${conditions.join(' AND ')} ORDER BY random() LIMIT 1`,
      params,
    )
    if (rows[0]) return rows[0]
  }
  // Last resort: allow repeats (small library subset exhausted).
  const { rows } = await pool.query(
    `SELECT * FROM exercises WHERE movement_pattern = $1 ORDER BY random() LIMIT 1`,
    [pattern],
  )
  return rows[0] ?? null
}

const PATTERN_LABELS = {
  squat_bilateral:  'Squat',
  squat_unilateral: 'Squat (Unilateral)',
  hinge_bilateral:  'Hinge',
  hinge_unilateral: 'Hinge (Unilateral)',
  upper_push:       'Upper Push',
  upper_pull:       'Upper Pull',
  core:             'Core',
  carry:            'Carry',
  conditioning:     'Conditioning',
}

function slotToPattern(slot, preferBilateral) {
  if (slot === 'squat') return preferBilateral ? 'squat_bilateral' : 'squat_unilateral'
  if (slot === 'hinge') return preferBilateral ? 'hinge_bilateral' : 'hinge_unilateral'
  return slot // upper_push, upper_pull, core, carry, conditioning map 1:1
}

/** Every distinct movement_pattern the day templates will actually query for this plan. */
function getRequiredPatterns(daysPerWeek, sessionLength, preferBilateral) {
  const patterns = new Set()
  for (let d = 0; d < daysPerWeek; d++) {
    for (const slot of buildDayQuota(d, sessionLength)) patterns.add(slotToPattern(slot, preferBilateral))
  }
  return [...patterns]
}

/** Pre-generation sanity check: fail loudly and early if the library can't back
 * the requested plan, instead of silently producing a warmup/cooldown-only plan. */
async function assertLibraryHasRequiredPatterns(pool, requiredPatterns) {
  const { rows } = await pool.query(
    `SELECT movement_pattern, COUNT(*)::int AS count FROM exercises WHERE movement_pattern = ANY($1) GROUP BY movement_pattern`,
    [requiredPatterns],
  )
  const counts = new Map(rows.map(r => [r.movement_pattern, r.count]))
  const missing = requiredPatterns.filter(p => !counts.get(p))
  if (missing.length) {
    const msg = `Exercise library has zero exercises for required movement pattern(s): ${missing.join(', ')}. Cannot generate a categorized workout — is the exercises table seeded on this database?`
    console.error(`[workoutGenerator] ${msg}`)
    throw new ExerciseLibraryError(msg)
  }
}

/** Builds the per-day exercise skeleton (deterministic DB picks, no AI involved yet). */
async function buildDaySkeletons(pool, { daysPerWeek, sessionLength, equipmentList, difficulty, preferBilateral }) {
  const usedIds = []
  const days = []
  let totalFilled = 0
  for (let d = 0; d < daysPerWeek; d++) {
    const quota = buildDayQuota(d, sessionLength)
    const slots = []
    for (const slot of quota) {
      const pattern = slotToPattern(slot, preferBilateral)
      const exercise = await pickExercise(pool, { pattern, equipmentList, difficulty, excludeIds: usedIds })
      if (!exercise) {
        console.error(
          `[workoutGenerator] No exercise found for slot: pattern=${pattern} equipment=${JSON.stringify(equipmentList)} difficulty=${difficulty ?? 'any'} (day ${d + 1}) — skipping slot`,
        )
        continue // library has nothing matching this exact slot; skip it rather than fail the whole plan
      }
      usedIds.push(exercise.id)
      totalFilled++
      slots.push({
        slot_id: `d${d}-${slots.length}`,
        exercise_id: exercise.id,
        name: exercise.name,
        movement_pattern: exercise.movement_pattern,
      })
    }
    days.push({
      day_index: d,
      slots,
      day_focus: [...new Set(slots.map(s => PATTERN_LABELS[s.movement_pattern] ?? s.movement_pattern))].join(' • '),
    })
  }
  if (totalFilled === 0) {
    const msg = 'Zero exercise slots were filled across the entire plan — refusing to return a warmup/cooldown-only workout.'
    console.error(`[workoutGenerator] ${msg}`)
    throw new ExerciseLibraryError(msg)
  }
  return days
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildWorkoutPrompt(firstName, answers, daySkeletons) {
  const goals = Array.isArray(answers.goals) ? answers.goals.join(', ') : answers.goals
  const skeletonText = daySkeletons.map(day => (
    `Day ${day.day_index + 1} (${day.day_focus}):\n` +
    day.slots.map(s => `  - [${s.slot_id}] "${s.name}"`).join('\n')
  )).join('\n\n')

  return `You are Katie, an enthusiastic and supportive fitness coach for the Life Warrior Coaching program.
Create a personalized weekly workout program for ${firstName} based on their profile:
- Fitness goals: ${goals}
- Training days per week: ${answers.days_per_week}
- Session length: ${answers.session_length}
- Fitness level: ${answers.fitness_level}
- Injuries or limitations: ${answers.injuries || 'None'}

The exercises for each day have already been selected from our exercise library by
movement pattern — you must NOT change, substitute, rename, or add exercise names.
Your job is to write sets/reps/rest and a short coaching cue for each listed exercise,
add a warm-up and cool-down for each day, and give the whole program a name and a
short Katie-style intro.

${skeletonText}

Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "program_name": "string (creative, motivating program name)",
  "description": "string (2-3 sentences, Katie-style intro to this program)",
  "days": [
    {
      "day_name": "string (e.g. 'Day 1 — Full Body')",
      "warmup": { "reps": "string (e.g. '5 minutes')", "notes": "string, brief warm-up description" },
      "cooldown": { "reps": "string (e.g. '5 minutes')", "notes": "string, brief cool-down description" },
      "exercises": [
        { "slot_id": "string, exactly as given above", "sets": number, "reps": "string (e.g. '10-12' or '30 seconds')", "rest_seconds": number, "notes": "string (brief form tip or coaching cue, 1 sentence)" }
      ]
    }
  ]
}

Include exactly ${daySkeletons.length} days, in the same order as given above, and echo each
slot_id exactly as provided so exercises can be matched back up. Make the sets/reps/rest
realistic and progressive for a ${answers.fitness_level} trainee with a ${answers.session_length} session.`
}

// ── Response merge ───────────────────────────────────────────────────────────
// Re-attaches the DB-selected name/exercise_id/movement_pattern to each slot
// (defense in depth — even though the prompt forbids it, never trust the model
// to preserve exact exercise names) and prepends/appends warm-up/cool-down as
// synthetic exercise rows (sets=1, matching the pre-existing UI convention).

function mergeResponse(daySkeletons, aiPlan) {
  const days = daySkeletons.map((skeleton, i) => {
    const aiDay = aiPlan.days?.[i] ?? {}
    const slotById = new Map(skeleton.slots.map(s => [s.slot_id, s]))
    const aiBySlot  = new Map((aiDay.exercises ?? []).map(e => [e.slot_id, e]))

    const exercises = []
    if (aiDay.warmup) {
      exercises.push({ name: 'Warm-Up', sets: 1, reps: aiDay.warmup.reps ?? '5 minutes', rest_seconds: null, notes: aiDay.warmup.notes ?? null, exercise_id: null, movement_pattern: null })
    }
    for (const slot of skeleton.slots) {
      const ai = aiBySlot.get(slot.slot_id) ?? {}
      exercises.push({
        name: slot.name,
        exercise_id: slot.exercise_id,
        movement_pattern: slot.movement_pattern,
        sets: ai.sets ?? null,
        reps: ai.reps ?? null,
        rest_seconds: ai.rest_seconds ?? null,
        notes: ai.notes ?? null,
      })
    }
    if (aiDay.cooldown) {
      exercises.push({ name: 'Cool-Down', sets: 1, reps: aiDay.cooldown.reps ?? '5 minutes', rest_seconds: null, notes: aiDay.cooldown.notes ?? null, exercise_id: null, movement_pattern: null })
    }

    return {
      day_name: aiDay.day_name ?? `Day ${i + 1}`,
      focus: skeleton.day_focus,
      exercises,
    }
  })

  return {
    program_name: aiPlan.program_name ?? 'Custom Program',
    description:  aiPlan.description ?? '',
    days,
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Generates a full workout plan: picks exercises from the library by
 * movement-pattern quota, then asks Claude to annotate them (sets/reps/rest/
 * notes/warmup/cooldown/program copy) without changing exercise selection.
 *
 * @param {import('pg').Pool} pool
 * @param {string} firstName
 * @param {object} answers - questionnaire answers (goals, days_per_week, session_length, equipment, injuries, fitness_level)
 * @param {object} [opts]
 * @param {string} [opts.healthAssessmentInjuries] - injuries_limitations from the client's saved health assessment, if any
 * @param {boolean} [opts.forceBilateral] - coach override: force bilateral squat/hinge selection
 */
export async function generateWorkoutPlan(pool, firstName, answers, opts = {}) {
  const equipmentList = resolveEquipmentList(answers.equipment)
  const difficulty    = FITNESS_LEVEL_MAP[answers.fitness_level] ?? null
  const preferBilateral = shouldPreferBilateral({
    injuries: answers.injuries,
    healthAssessmentInjuries: opts.healthAssessmentInjuries,
    forceBilateral: opts.forceBilateral,
  })

  const requiredPatterns = getRequiredPatterns(answers.days_per_week, answers.session_length, preferBilateral)
  await assertLibraryHasRequiredPatterns(pool, requiredPatterns)

  const daySkeletons = await buildDaySkeletons(pool, {
    daysPerWeek: answers.days_per_week,
    sessionLength: answers.session_length,
    equipmentList,
    difficulty,
    preferBilateral,
  })

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildWorkoutPrompt(firstName, answers, daySkeletons) }],
  })

  let text = message.content[0].text.trim()
  const fence = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/)
  if (fence) text = fence[1]
  const aiPlan = JSON.parse(text)

  return mergeResponse(daySkeletons, aiPlan)
}
