/**
 * server/services/assemblyWorkoutGenerator.js
 *
 * New generation path for the coach-facing "Generate with Katie" flow
 * (ClientProfile.jsx's WorkoutsTab, WO_GOALS/WO_EQUIPMENT_OPTIONS,
 * routed through coachAdmin.js's /clients/:id/workouts/generate). Exercise
 * selection now comes from assembleSession() (exercise_library, rule-based —
 * see server/services/workoutAssembly/) instead of Claude inventing/picking
 * from the old `exercises` table. Katie's role shrinks to notes-only: given
 * the stated injuries/limitations and the already-assembled list of
 * exercises, she may write a short caution/adaptation note per exercise —
 * she cannot add, remove, substitute, or rename anything. If her call fails
 * or returns unusable JSON, the workout still returns with no notes rather
 * than failing the whole request — exercise selection never depends on her.
 *
 * Does NOT touch the true client self-service flow (routes/workouts.js,
 * client/src/pages/Workouts.jsx) or the original workoutGenerator.js it
 * uses — that flow is left exactly as it was.
 *
 * days_per_week now drives a real week of sessions (see the Weekly split
 * section lower down) — A/B alternation over program_day_patterns' two
 * day-types, one assembleSession() call per training day. supersets/circuits
 * toggles are still accepted but ignored entirely.
 */

import Anthropic from '@anthropic-ai/sdk'
import { assembleSession, getDayLabelForSession } from './workoutAssembly/assembleSession.js'
import { sanitizeJsonText } from './workoutGenerator.js'

const anthropic = new Anthropic()

// ── Goal mapping ─────────────────────────────────────────────────────────────
// WO_GOALS (ClientProfile.jsx) ids -> volume_rules.goal. 'general_fitness' is
// intentionally absent — still hidden from this flow's form (see WorkoutsTab)
// since the engine has no support for it yet. 'flexibility' maps to the
// 'mobility' volume_rules goal, which carries zero main-lift work by design
// (see assembleSession.js's buildMainWork and the volume_rules seed in
// server/db.js).
const GOAL_ENGINE_MAP = {
  muscle_gain: 'hypertrophy',
  endurance: 'endurance',
  weight_loss: 'endurance',
  flexibility: 'mobility',
}

function resolveEngineGoal(goalsAnswer) {
  const list = Array.isArray(goalsAnswer) ? goalsAnswer : [goalsAnswer].filter(Boolean)
  for (const g of list) {
    if (GOAL_ENGINE_MAP[g]) return GOAL_ENGINE_MAP[g]
  }
  return 'hypertrophy'
}

// ── Equipment mapping ────────────────────────────────────────────────────────
// WO_EQUIPMENT_OPTIONS (ClientProfile.jsx) -> exercise_library.equipment_required tokens.
const ALL_EQUIPMENT_TOKENS = [
  'bodyweight', 'dumbbell', 'kettlebell', 'barbell', 'bench', 'cable', 'trap_bar',
  'trx', 'pull_up_bar', 'yoke', 'mini_band', 'big_band', 'medicine_ball', 'foam_roller',
]

const EQUIPMENT_TOKEN_MAP = {
  Kettlebell: ['kettlebell'],
  Dumbbells: ['dumbbell'],
  'Body Weight': ['bodyweight'],
  Barbell: ['barbell'],
  Benches: ['bench'],
  'Cable Machine': ['cable'],
  'Resistance Bands': ['mini_band', 'big_band'],
  // 'Full Gym' handled separately below — expands to every token.
}

function resolveEngineEquipment(equipmentAnswer) {
  const list = Array.isArray(equipmentAnswer) ? equipmentAnswer : [equipmentAnswer].filter(Boolean)
  if (!list.length || list.includes('Full Gym')) return [...ALL_EQUIPMENT_TOKENS]
  const set = new Set(['bodyweight']) // always available, matches assembleSession()'s own default
  for (const eq of list) {
    for (const token of EQUIPMENT_TOKEN_MAP[eq] ?? []) set.add(token)
  }
  return [...set]
}

// ── Session length / fitness level ──────────────────────────────────────────
// Both already match the engine's vocabulary once trivially parsed/lowercased.
const VALID_SESSION_LENGTHS = [20, 30, 45, 60, 90]
const VALID_LEVELS = ['beginner', 'intermediate', 'advanced']

function resolveEngineSessionLength(sessionLengthAnswer) {
  const n = parseInt(sessionLengthAnswer, 10)
  return VALID_SESSION_LENGTHS.includes(n) ? n : 45
}

function resolveEngineLevel(fitnessLevelAnswer) {
  const lower = String(fitnessLevelAnswer ?? '').toLowerCase()
  return VALID_LEVELS.includes(lower) ? lower : 'intermediate'
}

// ── Flatten assembleSession()'s grouped shape into the flat exercises array ──
// the client-facing UI (WorkoutsTab review table / Workouts.jsx PlanReview)
// and workout_exercises table already expect.
//
// foam_roll/activation/stretch/finisher are ALWAYS empty (coach-editable
// placeholders — see assembleSession.js's module header) — they still get
// one clearly-labeled placeholder row each here, in the correct block order,
// so the review UI shows every block instead of silently omitting four of
// them. The row's `name` is directly editable/deletable in that UI already
// (click to edit, ✕ to remove), so a coach can fill it in or delete it.
//
// Order matches program_templates.block_order plus the two invented blocks
// (bands, finisher) slotted in at their natural position in the session:
// foam_roll -> mobility -> activation -> bands -> plyo -> [main circuit] ->
// core -> stretch -> finisher.
function formatPrescription(p) {
  if (p == null) return null
  return typeof p === 'string' ? p : `${p.sets}x${p.repRange}`
}

function pushPlaceholder(flat, slotId, label) {
  flat.push({
    slot_id: slotId,
    name: `— Add ${label} exercise —`,
    exercise_id: null,
    movement_pattern: null,
    sets: null,
    reps: null,
    rest_seconds: null,
    notes: 'Coach-editable placeholder — not auto-picked.',
    legacy_exercise_id: null, // placeholders are never real exercise_library rows — no media possible
    image_url: null,
    instructions: null, // placeholders have no exercise_library row to source instructions from
  })
}

function flattenAssembledSession(session) {
  const flat = []
  const pushGroup = (items, slotPrefix) => {
    items.forEach((item, i) => {
      flat.push({
        slot_id: `${slotPrefix}-${i}`,
        name: item.exercise.name,
        // exercise_id intentionally left null — assembleSession() sources from
        // exercise_library, but workout_exercises.exercise_id has a foreign key
        // into the unrelated legacy `exercises` table. Writing an
        // exercise_library id there would silently point at the wrong row (or
        // violate the FK if no row with that id exists).
        exercise_id: null,
        movement_pattern: item.exercise.movement_pattern ?? null,
        sets: null,
        reps: formatPrescription(item.prescription),
        rest_seconds: null,
        notes: null,
        // legacy_exercise_id -> image_url is resolved in one batched lookup
        // after flattening (see attachLegacyMedia) rather than per-item here.
        legacy_exercise_id: item.exercise.legacy_exercise_id ?? null,
        image_url: null,
        // exercise_library's own how-to-perform cue — distinct from `notes`
        // (Katie's injury-specific caution, filled in later). Only ~24% of
        // exercise_library rows have one (see match-legacy-exercise-media.js
        // era investigation); null here just means none was ever written.
        instructions: item.exercise.instructions ?? null,
      })
    })
  }

  pushPlaceholder(flat, 'foam_roll-0', 'Foam Roll')
  pushGroup(session.warmup.mobility, 'mobility')
  pushPlaceholder(flat, 'activation-0', 'Activation')
  pushGroup(session.warmup.bands, 'bands')
  pushGroup(session.warmup.plyo, 'plyo')

  session.main.forEach((slot, i) => {
    flat.push({
      slot_id: `main-${i}`,
      name: slot.exercise.name,
      exercise_id: null,
      movement_pattern: slot.movementPattern,
      sets: slot.prescription.sets,
      reps: slot.prescription.repRange,
      rest_seconds: null,
      notes: null,
      legacy_exercise_id: slot.exercise.legacy_exercise_id ?? null,
      image_url: null,
      instructions: slot.exercise.instructions ?? null,
    })
  })

  pushGroup(session.cooldown.core, 'core')
  pushPlaceholder(flat, 'stretch-0', 'Stretch')
  pushPlaceholder(flat, 'finisher-0', 'Finisher')

  return flat
}

// ── Media (image_url) ────────────────────────────────────────────────────────
// exercise_library has no media of its own — server/scripts/match-legacy-
// exercise-media.js links matching rows to the legacy `exercises` table
// (free-exercise-db import) by exact normalized name (~20% coverage; the
// rest are Programming-Guide-specific drills with no legacy counterpart).
// One batched lookup per generated session, not a query per exercise.
async function attachLegacyMedia(pool, exercises) {
  const ids = [...new Set(exercises.map(e => e.legacy_exercise_id).filter(Boolean))]
  if (!ids.length) return
  const { rows } = await pool.query(`SELECT id, image_url FROM exercises WHERE id = ANY($1)`, [ids])
  const imageMap = new Map(rows.map(r => [r.id, r.image_url]))
  for (const ex of exercises) {
    if (ex.legacy_exercise_id) ex.image_url = imageMap.get(ex.legacy_exercise_id) ?? null
    delete ex.legacy_exercise_id // internal-only — not part of the shape the UI/save endpoint expect
  }
}

function buildFocus(session) {
  if (session.main.length === 0) {
    // Mobility-goal sessions carry no main-lift slots (see buildMainWork) —
    // fall back to naming the warm-up/cooldown categories that actually
    // exist so the UI's focus line isn't blank.
    return 'Mobility & Recovery'
  }
  const labels = session.main.map(s => s.movementPattern.replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase()))
  return [...new Set(labels)].join(' • ')
}

// ── Katie: notes-only ────────────────────────────────────────────────────────
// Given injuries/limitations text and the already-selected exercise list,
// asks Katie for short per-exercise caution/adaptation notes. Never asked to
// choose, add, remove, or rename exercises — the prompt explicitly forbids
// it, and the response is only ever used to fill in `notes` by slot_id on
// exercises this function already decided. Any failure (API error, bad JSON)
// falls back to "no notes" rather than breaking generation.
function extractJsonArrayText(rawText) {
  let text = rawText.trim()
  const fence = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/)
  if (fence) text = fence[1]
  return text
}

async function requestExerciseNotes(injuriesText, exercises) {
  if (!injuriesText?.trim() || exercises.length === 0) return new Map()

  const listText = exercises.map(e => `- [${e.slot_id}] ${e.name}`).join('\n')
  const prompt = `You are Katie, a supportive fitness coach. A client has stated the following injuries or limitations: "${injuriesText.trim()}"

The exercises below have ALREADY been selected for their workout by a separate system. You must NOT add, remove, substitute, or rename any exercise — your only job is to flag which of these exercises (if any) could be a concern given the stated limitation, and write one short (one sentence) caution or adaptation note for each one that needs it. Skip any exercise with no relevant concern — most exercises should NOT get a note.

${listText}

Return ONLY a valid JSON array (no markdown, no extra text). Each item: {"slot_id": "string, exactly as given above", "note": "short one-sentence caution or adaptation note"}. Omit exercises that don't need a note. If none of these exercises are a concern given the stated limitation, return [].`

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })
    const jsonText = sanitizeJsonText(extractJsonArrayText(message.content[0].text))
    const parsed = JSON.parse(jsonText)
    if (!Array.isArray(parsed)) return new Map()

    const validSlotIds = new Set(exercises.map(e => e.slot_id))
    const notes = new Map()
    for (const item of parsed) {
      if (item?.slot_id && validSlotIds.has(item.slot_id) && typeof item.note === 'string' && item.note.trim()) {
        notes.set(item.slot_id, item.note.trim())
      }
    }
    return notes
  } catch (err) {
    console.error('[assemblyWorkoutGenerator] Katie notes call failed, proceeding with no notes:', err.message)
    return new Map()
  }
}

// ── Weekly split ─────────────────────────────────────────────────────────────
// program_day_patterns only defines TWO day types — A and B (confirmed against
// staging: 8 rows, day_label ∈ {A, B}, no goal column):
//   Day A: squat -> horizontal_pull -> horizontal_push -> carry
//   Day B: hinge -> vertical_pull  -> vertical_push  -> lift
// A and B share no main-lift movement pattern, so alternating them avoids
// stacking the same pattern on consecutive days. There is NO third+ day-type
// in the data and no day-count-aware logic anywhere (program_templates is
// session_length-only, volume_rules is goal-only), so a week longer than 2
// days repeats the A/B cycle: getDayLabelForSession(i) = A,B,A,B,A,...
//
// *** FIRST-PASS SPLIT ASSIGNMENT — needs a coach's review before it's treated
// as real programming. *** With only two day-patterns in the data, Days 1/3/5
// share the same A skeleton (and 2/4 share B). To keep same-label days from
// being literal duplicates, each day is assembled with rotationIndex = its day
// index, so pickMainLift() cycles a different exercise from each pattern's pool
// per day — Day 1 (A, rot 0) and Day 3 (A, rot 2) get the same movement-pattern
// structure but different actual lifts. This is a mechanical A/B rotation over
// the existing patterns, not a periodized upper/lower or push/pull/legs plan.
const MIN_DAYS = 1
const MAX_DAYS = 6

function resolveDaysPerWeek(daysAnswer) {
  const n = parseInt(daysAnswer, 10)
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n))
}

/**
 * Builds ONE day of the week: real exercise selection via assembleSession(),
 * then media + Katie's notes-only pass. All per-session logic (block
 * structure, exercise selection, placeholder blocks, image/instructions,
 * injury notes) is identical to the single-session behaviour — this is just
 * the extracted body of the old single-day generator so the week can call it
 * once per day.
 */
async function buildOneDay(pool, { dayIndex, sessionLength, goal, level, equipment, injuries }) {
  const dayLabel = getDayLabelForSession(dayIndex) // A/B alternation (existing helper)
  const session = await assembleSession(pool, {
    dayLabel, sessionLength, goal, level, equipment, rotationIndex: dayIndex,
  })
  if (session.warnings.length) {
    console.log(`[assemblyWorkoutGenerator] day ${dayIndex + 1} (${dayLabel}) assembleSession warnings:`, session.warnings)
  }

  const exercises = flattenAssembledSession(session)
  await attachLegacyMedia(pool, exercises)
  const notes = await requestExerciseNotes(injuries, exercises)
  for (const ex of exercises) {
    if (notes.has(ex.slot_id)) ex.notes = notes.get(ex.slot_id)
  }

  return {
    day_name: `Day ${dayIndex + 1}`,
    focus: buildFocus(session),
    exercises,
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Generates a full week of sessions (one per training day) by calling
 * assembleSession() per day for real exercise selection, then Katie per day
 * for optional per-exercise notes. Returns the same
 * { program_name, description, days: [...] } shape the existing coach UI
 * (WorkoutsTab review table) and POST /clients/:id/workouts save endpoint
 * already expect — both already loop over `days`, so no UI/save changes were
 * needed to go from one day to many.
 *
 * @param {import('pg').Pool} pool
 * @param {string} firstName
 * @param {object} answers - goals, days_per_week, session_length, equipment, injuries, fitness_level
 *   (supersets, circuits are accepted but ignored — see module header)
 */
export async function generateWorkoutPlanFromAssembly(pool, firstName, answers) {
  const goal = resolveEngineGoal(answers.goals)
  const equipment = resolveEngineEquipment(answers.equipment)
  const sessionLength = resolveEngineSessionLength(answers.session_length)
  const level = resolveEngineLevel(answers.fitness_level)
  const daysPerWeek = resolveDaysPerWeek(answers.days_per_week)

  const days = []
  for (let i = 0; i < daysPerWeek; i++) {
    days.push(await buildOneDay(pool, {
      dayIndex: i, sessionLength, goal, level, equipment, injuries: answers.injuries,
    }))
  }

  const goalLabel = Object.entries(GOAL_ENGINE_MAP).find(([, v]) => v === goal)?.[0]?.replace('_', ' ') ?? 'fitness'
  const dayWord = daysPerWeek === 1 ? 'day' : 'days'
  return {
    program_name: `${firstName}'s ${daysPerWeek}-Day Program`,
    description: `A ${level}-level ${daysPerWeek}-${dayWord}/week plan focused on ${goalLabel}, `
      + `built from your available equipment (${sessionLength}-minute sessions).`,
    days,
  }
}
