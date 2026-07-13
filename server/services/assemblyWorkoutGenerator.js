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
 * Explicitly out of scope for this first pass (per task): training days per
 * week (always generates one session), supersets/circuits toggles (ignored
 * entirely).
 */

import Anthropic from '@anthropic-ai/sdk'
import { assembleSession, getDayLabelForSession } from './workoutAssembly/assembleSession.js'
import { sanitizeJsonText } from './workoutGenerator.js'

const anthropic = new Anthropic()

// ── Goal mapping ─────────────────────────────────────────────────────────────
// WO_GOALS (ClientProfile.jsx) ids -> volume_rules.goal. 'flexibility' and
// 'general_fitness' are intentionally absent — hidden from this flow's form
// (see WorkoutsTab) since the engine has no support for either yet.
const GOAL_ENGINE_MAP = {
  muscle_gain: 'hypertrophy',
  endurance: 'endurance',
  weight_loss: 'endurance',
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
    })
  })

  pushGroup(session.cooldown.core, 'core')
  pushPlaceholder(flat, 'stretch-0', 'Stretch')
  pushPlaceholder(flat, 'finisher-0', 'Finisher')

  return flat
}

function buildFocus(session) {
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

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Generates a single-session workout by calling assembleSession() for real
 * exercise selection, then Katie once for optional per-exercise notes.
 * Returns the same { program_name, description, days: [...] } shape the
 * existing client UI (PlanReview) and POST /workouts save endpoint expect.
 *
 * @param {import('pg').Pool} pool
 * @param {string} firstName
 * @param {object} answers - goals, session_length, equipment, injuries, fitness_level
 *   (days_per_week, supersets, circuits are accepted but ignored — see module header)
 */
export async function generateWorkoutPlanFromAssembly(pool, firstName, answers) {
  const goal = resolveEngineGoal(answers.goals)
  const equipment = resolveEngineEquipment(answers.equipment)
  const sessionLength = resolveEngineSessionLength(answers.session_length)
  const level = resolveEngineLevel(answers.fitness_level)
  const dayLabel = getDayLabelForSession(0) // single session per request, always Day A for now

  const session = await assembleSession(pool, { dayLabel, sessionLength, goal, level, equipment, rotationIndex: 0 })
  if (session.warnings.length) {
    console.log('[assemblyWorkoutGenerator] assembleSession warnings:', session.warnings)
  }

  const exercises = flattenAssembledSession(session)
  const notes = await requestExerciseNotes(answers.injuries, exercises)
  for (const ex of exercises) {
    if (notes.has(ex.slot_id)) ex.notes = notes.get(ex.slot_id)
  }

  const goalLabel = Object.entries(GOAL_ENGINE_MAP).find(([, v]) => v === goal)?.[0]?.replace('_', ' ') ?? 'fitness'
  return {
    program_name: `${firstName}'s ${sessionLength}-Minute Program`,
    description: `A ${level}-level session focused on ${goalLabel}, built from your available equipment.`,
    days: [
      {
        day_name: 'Day 1',
        focus: buildFocus(session),
        exercises,
      },
    ],
  }
}
