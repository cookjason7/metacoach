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
import { validateWorkoutPlan } from './workoutValidation.js'

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
// Order is load-bearing: squat and hinge (the two lower-body patterns) must
// never be adjacent, so an upper push/pull always separates them — Warm-Up is
// prepended and Cool-Down appended by mergeResponse(), giving the full
// required sequence Warm-Up -> Squat -> Push -> Hinge -> Pull -> Core -> Cool-Down.
const BASE_QUOTA  = ['squat', 'upper_push', 'hinge', 'upper_pull', 'core']
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

export function shouldPreferBilateral({ injuries, healthAssessmentInjuries, forceBilateral, fitnessLevel, floorTransfer }) {
  if (forceBilateral) return true
  // Beginners always start with bilateral — spec section 5
  if (fitnessLevel && FITNESS_LEVEL_MAP[fitnessLevel] === 'beginner') return true
  // Floor transfer unable/restricted — bilateral safer
  if (floorTransfer === 'unable' || floorTransfer === 'restricted') {
    console.warn('[workoutGenerator] floor_transfer unable/restricted — forcing bilateral squat/hinge selection')
    return true
  }
  const text = [injuries, healthAssessmentInjuries].filter(Boolean).join(' ')
  return BILATERAL_SIGNAL_RE.test(text)
}

// ── Injury/limitation flags ──────────────────────────────────────────────────
// Drive both DB-level exercise exclusion (below) and prompt context so a
// flagged limitation can never surface as a selected exercise in the first
// place, rather than relying on Katie to avoid it after the fact.
const KNEE_SIGNAL_RE       = /\b(knee|patell|meniscus|\bacl\b|\bmcl\b)\b/i
const WRIST_SIGNAL_RE      = /\b(wrist|carpal tunnel|carpal)\b/i
const LOWER_BACK_SIGNAL_RE = /\b(lower back|low back|lumbar|disc|sciatica)\b/i

export function getInjuryFlags(injuries, healthAssessmentInjuries) {
  const text = [injuries, healthAssessmentInjuries].filter(Boolean).join(' ')
  return {
    knee:      KNEE_SIGNAL_RE.test(text),
    wrist:     WRIST_SIGNAL_RE.test(text),
    lowerBack: LOWER_BACK_SIGNAL_RE.test(text),
  }
}

// ── Blocked exercise names ───────────────────────────────────────────────────
// Applied as a DB-query exclusion (never selected) and re-checked by the
// post-generation validator as a defense-in-depth safety net.
const GLOBAL_BLOCKED_TERMS = [
  'russian twist', 'janda sit-up', 'janda situp', 'jackknife sit-up', 'jackknife situp',
  'cocoon', 'hang clean', 'alternating hang clean', 'power clean', 'clean and press',
  'olympic lift', 'snatch', 'tuck crunch', 'knee tuck jump',
  'bottoms up', // renamed to 'Dead Bug' in the DB — still blocked here in case any variant row exists under the old name
  'side bend', // covers Dumbbell Side Bend, Barbell Side Bend, and any other Side Bend variation
  'oblique crunch', // rotational/lateral core — contraindicated for general population
  'wide-grip pulldown behind the neck', 'pulldown behind neck', 'behind the neck', // shoulder injury risk for all clients
  'wood chop', // rotational power — risky risk/reward ratio
  'side jackknife', // advanced floor plyometric, poor risk/reward for this population
  'flutter kick', // poor risk/reward for general population — previously only excluded when a knee injury was flagged (still in KNEE_UNSAFE_TERMS below), now blocked for everyone
]
const KNEE_UNSAFE_TERMS = [
  'lunge', 'jump squat', 'jumping squat', 'lateral bound', 'box jump', 'depth jump', 'split squat jump',
  'scissors jump', 'bench jump', 'star jump', 'jumping jack', 'flutter kick',
]
// Broad 'bent-over'/'bent over' (not just "...row") so "Bent Over Barbell Row" and
// "Bent Over Dumbbell Row" are caught — the literal "bent over row" substring never
// appears in those names since the equipment word sits between "over" and "row".
// 'deadlift' is handled separately below (LOWER_BACK_DEADLIFT_EXEMPT_RE) since sumo
// and trap-bar variants are exempt.
const LOWER_BACK_UNSAFE_TERMS = [
  'good morning', 'bent-over', 'bent over', 'stiff leg',
  // Rotational/lateral-loaded core — contraindicated for low back pain.
  'spell caster', 'wood chop', 'oblique crunch', 'side bend',
]
// Blocks any "...deadlift..." name for low-back-injured clients EXCEPT sumo or
// trap-bar variants (more upright torso, lower lumbar shear) — expressed as a single
// raw regex (not escaped/joined like the plain terms above) using a negative lookahead.
const LOWER_BACK_DEADLIFT_EXEMPT_RE = '^(?!.*(sumo|trap.?bar)).*deadlift.*$'

// Preferred horizontal-pull substitutes for low-back-injured clients: single-arm,
// supported variations instead of bilateral bent-over rows. Seated Cable Row only
// offered when cable equipment is actually available.
const LOWER_BACK_PULL_PREFERENCE_TERMS = ['one-arm dumbbell row', 'one arm dumbbell row', 'single arm row', 'single-arm row']

function getLowerBackPullPreference(equipmentList) {
  const terms = [...LOWER_BACK_PULL_PREFERENCE_TERMS]
  const cableAvailable = !equipmentList?.length || equipmentList.includes('cable')
  if (cableAvailable) terms.push('seated cable row')
  return terms.map(escapeRegExp).join('|')
}

// Applied only to the core slot: sprint/cardio-named exercises are occasionally
// mistagged movement_pattern='core' in the library (Wind Sprints was — corrected
// to 'conditioning' directly in the DB), so this name-based exclusion is a
// defense-in-depth backstop against the same mistagging recurring, on top of the
// data fix. A core slot should always sit out with the DB fix; this just means it
// can never silently regress if a future import mistags another cardio exercise.
const CORE_SLOT_BLOCKED_TERMS = ['wind sprint', 'sprint', 'shuttle run', 'suicide run', 'cardio']

// Cardio machines that should never appear in a home/equipment-restricted workout.
// Excluded when client does not have access to full gym or dedicated cardio equipment.
const CARDIO_MACHINE_TERMS = [
  'stairmaster', 'stair master', 'stair climber',
  'treadmill',
  'elliptical',
  'stationary bike', 'exercise bike',
  'rowing machine', 'rower',
]

function shouldExcludeCardioMachines(equipmentList) {
  if (!equipmentList) return false // null = "Full Gym" = has everything
  // Include cardio machines only if client has 'Full Gym' or explicitly selected cardio/gym equipment
  const hasFullGym = equipmentList.includes('Full Gym') || equipmentList.includes('Full gym')
  const hasCardioEquipment = equipmentList.includes('cardio') || equipmentList.includes('gym')
  return !hasFullGym && !hasCardioEquipment
}

// Plyometrics must never fill a strength-pattern slot — there is no dedicated
// plyo slot in this day template (see BASE_QUOTA/BONUS_SLOTS above), so without
// an explicit exclusion a plyo-named exercise could otherwise be selected into
// squat/hinge/push/pull/core just because it happens to carry that
// movement_pattern tag in the library. Deliberately NOT applied to carry/
// conditioning (BONUS_SLOTS) — plyo work (e.g. burpee) is legitimate there.
const PLYO_TERMS = [
  'rocket jump', 'broad jump', 'standing long jump', 'long jump',
  'box jump', 'depth jump', 'plyo push-up', 'plyometric push-up',
  'clap push-up', 'jump squat', 'jumping squat', 'lateral bound',
  'star jump', 'scissors jump', 'plyo', 'plyometric',
  'split jump', 'tuck jump', 'burpee',
  'lateral hop', 'single-leg hop', 'single leg hop', 'lateral jump',
  'lunge sprint', 'lunge jump', 'jumping lunge', 'split jump lunge',
  'stride jump', 'single-leg stride jump',
]
const PLYO_EXCLUDED_SLOTS = new Set(['squat', 'upper_push', 'hinge', 'upper_pull', 'core'])

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Merges two optional regex source strings into one (`a|b`), passing either through unchanged if the other is absent. */
function combinePatterns(a, b) {
  return a && b ? `${a}|${b}` : a || b || null
}

/** Builds a single case-insensitive regex source string (for Postgres `!~*` and
 * the post-generation validator) of every exercise name that must never be
 * selected for this client, given fitness level, injury flags, and equipment. Returns null
 * when there's nothing to exclude.
 *
 * `omitFitnessLevelBlocks` drops only the fitness-level-gated lists
 * (BEGINNER_BLOCKED_EXERCISES / INTERMEDIATE_BLOCKED_EXERCISES) while keeping every
 * global-safety, injury, and equipment exclusion as a hard constraint. It exists for
 * exactly one caller — the last-resort pull-slot fallback (see fillPullSlot) — where
 * leaving the slot empty is a worse outcome than a level-inappropriate-but-flagged
 * exercise. Never use it for normal selection. */
export function buildBlockedNamePattern({ isBeginner, injuryFlags, equipmentList, fitnessLevel, omitFitnessLevelBlocks = false }) {
  const terms = new Set(GLOBAL_BLOCKED_TERMS)
  if (isBeginner && !omitFitnessLevelBlocks) for (const t of BEGINNER_BLOCKED_EXERCISES) terms.add(t)
  if (FITNESS_LEVEL_MAP[fitnessLevel] === 'intermediate' && !omitFitnessLevelBlocks) for (const t of INTERMEDIATE_BLOCKED_EXERCISES) terms.add(t)
  if (injuryFlags?.knee) for (const t of KNEE_UNSAFE_TERMS) terms.add(t)
  if (injuryFlags?.lowerBack) for (const t of LOWER_BACK_UNSAFE_TERMS) terms.add(t)
  if (shouldExcludeCardioMachines(equipmentList)) for (const t of CARDIO_MACHINE_TERMS) terms.add(t)
  const escaped = [...terms].map(escapeRegExp)
  // Wrist/carpal tunnel: block the bare standard push-up (wrist in full extension
  // under load) but not incline/wall/fist/neutral-grip variants, which contain
  // "push-up" as a substring and remain selectable.
  if (injuryFlags?.wrist) escaped.push('^push-?up$')
  // Low back: block any deadlift EXCEPT sumo/trap-bar variants — a raw regex (not
  // escaped, unlike the plain substring terms above) since it needs a lookahead.
  if (injuryFlags?.lowerBack) escaped.push(LOWER_BACK_DEADLIFT_EXEMPT_RE)
  return escaped.length ? escaped.join('|') : null
}

// ── Exercise selection ───────────────────────────────────────────────────────

const EQUIPMENT_MAP = {
  // Coach "Generate with Katie" questionnaire (client/src/pages/admin/ClientProfile.jsx)
  'Kettlebell':        ['kettlebells'],
  'Dumbbells':         ['dumbbell'],
  'Body Weight':       ['body only'],
  'Barbell':           ['barbell'],
  'Benches':           [], // no dedicated "bench" equipment tag in the library — never a filter on its own; access is instead signaled through resolveHasBench below, which pickExercise uses to exclude requires_bench=TRUE rows
  'Cable Machine':     ['cable', 'machine'],
  'Full Gym':          null, // no filter — everything available
  'Resistance Bands':  ['bands'],
  // Legacy client-facing questionnaire (client/src/pages/Workouts.jsx)
  'Bodyweight only':   ['body only'],
  'Resistance bands':  ['bands', 'body only'],
  'Barbell + Rack':    ['barbell', 'dumbbell', 'body only'],
  'Full gym':          null,
}

function resolveEquipmentList(equipmentAnswers) {
  const list = Array.isArray(equipmentAnswers) ? equipmentAnswers : [equipmentAnswers].filter(Boolean)
  if (!list.length || list.includes('Full gym') || list.includes('Full Gym')) return null
  const set = new Set()
  for (const eq of list) {
    for (const mapped of EQUIPMENT_MAP[eq] ?? []) set.add(mapped)
  }
  return set.size ? [...set] : null
}

/** Whether this client has access to a bench, derived from the raw equipment
 * answers rather than the resolved equipmentList — 'Benches' contributes no
 * equipment-tag filter of its own (see EQUIPMENT_MAP above), so it would
 * otherwise vanish entirely once resolveEquipmentList normalizes the answer into
 * tags. 'Full Gym'/'Full gym' implies bench access the same way it implies every
 * other piece of equipment. Used by pickExercise to exclude requires_bench=TRUE
 * rows for clients who answered neither. */
function resolveHasBench(equipmentAnswers) {
  const list = Array.isArray(equipmentAnswers) ? equipmentAnswers : [equipmentAnswers].filter(Boolean)
  return list.includes('Benches') || list.includes('Full Gym') || list.includes('Full gym')
}

const FITNESS_LEVEL_MAP = { Beginner: 'beginner', Intermediate: 'intermediate', Advanced: 'advanced' }

function isBodyweightOnly(equipmentList) {
  return !!equipmentList && equipmentList.length === 1 && equipmentList[0] === 'body only'
}

// ── Bodyweight pull fallback ─────────────────────────────────────────────────
// Most upper_pull exercises in the library need a pull-up bar or band — genuinely
// scarce for a bodyweight-only client, especially combined with the strict
// beginner-difficulty constraint above. Rather than silently dropping the pull
// slot (breaking the required day sequence and the weekly pull >= push ratio),
// fall back to one of these hardcoded, no-equipment substitutes. Rotates by day
// index so a multi-day program doesn't repeat the same substitute every day.
const BODYWEIGHT_PULL_FALLBACKS = ['Door Frame Row', 'Table Row', 'Towel Row']
const BODYWEIGHT_PULL_FALLBACK_NOTE =
  'Setup: Find a sturdy door frame or table edge. For a door frame row: hold both sides of an open door frame, lean back slightly, and pull your chest toward the frame. For a table row: lie under a sturdy table, grip the edge, and pull your chest up. Movement: Pull with control, pause at the top, lower slowly. Breathe out as you pull, breathe in as you lower. This builds the back strength that balances your push work and supports better posture.'

function getBodyweightPullFallback(dayIndex) {
  return {
    name: BODYWEIGHT_PULL_FALLBACKS[dayIndex % BODYWEIGHT_PULL_FALLBACKS.length],
    movement_pattern: 'upper_pull',
    equipment: 'body only',
    difficulty: 'beginner',
    notes: BODYWEIGHT_PULL_FALLBACK_NOTE,
  }
}

// ── Vertical pull day-variation (Day 3) ──────────────────────────────────────
// Without this, the pull slot is picked independently per day with no pattern
// awareness, so a 3-day program typically lands 3 horizontal pulls (row
// variants) back to back across the week. Day 1/2 stay horizontal (varied only
// by usedIds excluding whatever was already picked); Day 3 actively prefers a
// vertical pull (pulldown-family) instead.
const VERTICAL_PULL_DAY_INDEX = 2 // Day 3, 0-indexed
const VERTICAL_PULL_TERMS = ['pulldown', 'high-to-low', 'high to low', 'lat pull', 'vertical pull', 'band pull down']

function getVerticalPullPreference() {
  return VERTICAL_PULL_TERMS.map(escapeRegExp).join('|')
}

const PULL_VARIETY_FLAG =
  '[PULL VARIETY — Day 3 ideally uses a vertical pull. Consider substituting a lat pulldown, band pulldown, or high-to-low band pull-apart if equipment allows.]'

// Bodyweight-only fallback specifically for the Day 3 vertical pull, distinct from
// the generic (horizontal) BODYWEIGHT_PULL_FALLBACKS above — used only if the DB
// genuinely has no vertical-pull match for a bodyweight-only client (in practice the
// seeded 'Doorframe Lat Pull' row should cover this; this is defense in depth).
const BODYWEIGHT_VERTICAL_PULL_FALLBACK_NOTE =
  'Stand in an open doorframe, reach both hands up to grip the top corners of the frame at shoulder width. Pull your elbows down and back toward your hips as if trying to bend the doorframe, hold the squeeze for 2 seconds, then release. Breathe out as you pull, breathe in as you release. This builds the lat and upper back strength that balances all your push work and keeps your shoulders healthy over time.'

function getBodyweightVerticalPullFallback() {
  return {
    name: 'Doorframe Lat Pull',
    movement_pattern: 'upper_pull',
    equipment: 'body only',
    difficulty: 'beginner',
    notes: BODYWEIGHT_VERTICAL_PULL_FALLBACK_NOTE,
  }
}

// ── Pull-slot fallback ladder ────────────────────────────────────────────────
// An unfilled slot is normally skipped (see the `continue` in buildDaySkeletons),
// which is tolerable for most patterns but never for upper_pull: dropping it
// silently breaks both the required day sequence and the weekly pull >= push
// ratio. validatePushPullRatio cannot catch that, because it counts the day
// *quota* before selection runs and so never sees a slot lost during selection.
//
// Real equipment selections that hit this (verified against the live library):
//   - Resistance Bands alone, every difficulty — zero 'bands' upper_pull rows exist
//   - Resistance bands / bands + Body Weight, beginner & intermediate — the only
//     'body only' pull row (Chin-Up) is name-blocked at those levels
//   - Kettlebell / Kettlebell + Body Weight, beginner — no beginner kettlebell pull
//     exists, and beginners run strictDifficulty so pickExercise never relaxes it
//
// The previous fallback only rescued clients whose equipment resolved to exactly
// ['body only'], so all of the above silently lost their pull. Every unfilled pull
// slot now walks this ladder instead, and any tier that had to relax a constraint
// reports it through the same coach-facing flag field as the equipment-mismatch
// case (pullVarietyFlag -> pull_variety_flag).
//
// Tier order is deliberate — each tier gives up strictly less than the next:
//   1. Keep equipment + every name block, relax difficulty only.
//   2. Additionally lift the fitness-level name block. Skipped for beginners:
//      for them the level block is a hard safety line (the same reasoning behind
//      strictDifficulty), so a beginner drops to tier 3 rather than being handed
//      e.g. a Chin-Up. Global-safety, injury, and equipment exclusions are never
//      lifted at any tier.
//   3. A hardcoded no-equipment pull (door frame / table / towel row, or the
//      Doorframe Lat Pull on the vertical-pull day). Requires nothing the client
//      lacks, so it is always performable and always fills the slot.

const PULL_DIFFICULTY_RELAXED_FLAG = difficulty =>
  `[PULL FALLBACK — the library has no ${difficulty}-level pull exercise for this client's equipment, so this pull was selected at a different difficulty to keep the day's push/pull balance intact. Review that the load and progression suit this client.]`
const PULL_LEVEL_BLOCK_BYPASSED_FLAG = level =>
  `[PULL FALLBACK — every pull exercise matching this client's equipment is on the ${level} block list, so the block was bypassed for this one slot rather than leaving the day with push work and no pull. Review this exercise and substitute an assisted or band-assisted variation if needed.]`
const PULL_NO_EQUIPMENT_FALLBACK_FLAG =
  '[PULL FALLBACK — no pull exercise in the library matches this client\'s equipment, so a no-equipment substitute was used instead. It needs nothing the client lacks, but review whether it fits their setup.]'

/** Joins two optional coach-facing flag strings, keeping either alone if the other is absent. */
function combineFlags(a, b) {
  return a && b ? `${a} ${b}` : a || b || null
}

/**
 * Last-resort fill for an upper_pull slot that normal selection left empty.
 * Returns `{ exercise, notes, flag, reason, bypassedBlock, isVerticalPull }` —
 * `exercise` is always a real exercise (a DB row, or a hardcoded no-equipment
 * substitute carrying its own `notes`); `flag` is the coach-facing note text and
 * `reason` the machine-readable flag_reason, both non-null whenever a constraint
 * had to be relaxed; `bypassedBlock` marks a tier-2 pick so the post-generation
 * validator doesn't re-reject the very name this ladder deliberately allowed.
 */
async function fillPullSlot(pool, {
  dayIndex, pattern, equipmentList, hasBench, difficulty, usedIds,
  excludeNamePattern, levelRelaxedExcludeNamePattern, isBeginner, fitnessLevel,
}) {
  // Tier 1 — equipment and every name block intact; difficulty relaxed.
  // strictDifficulty is deliberately false here: this is the point at which
  // relaxing it is the lesser harm, and it is reported to the coach.
  let exercise = await pickExercise(pool, {
    pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds,
    excludeNamePattern, strictDifficulty: false,
  })
  if (exercise) {
    console.warn(`[workoutGenerator] No ${difficulty ?? 'matching'}-difficulty pull exercise for equipment=${JSON.stringify(equipmentList)} (day ${dayIndex + 1}) — relaxed difficulty and selected "${exercise.name}" (${exercise.difficulty})`)
    return {
      exercise, notes: null,
      flag: PULL_DIFFICULTY_RELAXED_FLAG(difficulty ?? 'requested'),
      reason: 'pull_fallback_difficulty_relaxed',
      bypassedBlock: false,
      isVerticalPull: false,
    }
  }

  // Tier 2 — additionally lift the fitness-level name block. Never for beginners.
  if (!isBeginner && levelRelaxedExcludeNamePattern !== excludeNamePattern) {
    exercise = await pickExercise(pool, {
      pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds,
      excludeNamePattern: levelRelaxedExcludeNamePattern, strictDifficulty: false,
    })
    if (exercise) {
      console.warn(`[workoutGenerator] Every equipment-matched pull exercise is on the ${fitnessLevel ?? 'level'} block list (day ${dayIndex + 1}) — bypassed the block for this slot and selected "${exercise.name}"`)
      return {
        exercise, notes: null,
        flag: PULL_LEVEL_BLOCK_BYPASSED_FLAG(fitnessLevel ?? 'fitness-level'),
        reason: 'pull_fallback_level_block_bypassed',
        bypassedBlock: true,
        isVerticalPull: false,
      }
    }
  }

  // Tier 3 — hardcoded no-equipment substitute. Always succeeds.
  const isVerticalPullDay = dayIndex === VERTICAL_PULL_DAY_INDEX
  const fallback = isVerticalPullDay ? getBodyweightVerticalPullFallback() : getBodyweightPullFallback(dayIndex)
  console.warn(`[workoutGenerator] No DB pull exercise available for equipment=${JSON.stringify(equipmentList)} (day ${dayIndex + 1}) — using hardcoded no-equipment fallback "${fallback.name}"`)
  // A bodyweight-only client is not an equipment mismatch — a no-equipment
  // substitute is exactly what they should get, so no coach flag for them
  // (unchanged from the original behaviour for that case).
  const bodyweightClient = isBodyweightOnly(equipmentList)
  return {
    exercise: { id: null, name: fallback.name, movement_pattern: fallback.movement_pattern, equipment: fallback.equipment },
    notes: fallback.notes,
    flag: bodyweightClient ? null : PULL_NO_EQUIPMENT_FALLBACK_FLAG,
    reason: bodyweightClient ? null : 'pull_fallback_no_equipment_match',
    bypassedBlock: false,
    isVerticalPull: isVerticalPullDay,
  }
}

// ── Beginner squat day variation ─────────────────────────────────────────────
// Biases which squat-pattern exercise gets picked on each day of a beginner's
// program so the same one exercise (usually the only bodyweight-squat row in
// a sparse library) doesn't repeat on every day. Beginners force bilateral
// squat selection (see shouldPreferBilateral), so these must be names that
// actually exist as beginner/bodyweight `squat_bilateral` rows — confirmed
// against the exercise library directly (Sumo Squat, Sit to Stand were added
// and Chair Squat's equipment tag was corrected from 'machine' to 'body only'
// after the original preference list matched nothing beyond day 1).
const BEGINNER_SQUAT_DAY_PREFERENCES = [
  ['bodyweight squat'],
  ['sumo squat'],
  ['chair squat', 'sit to stand'],
]

/** Regex source string of the day's preferred squat exercise names, or null past
 * the defined preference days (falls through to normal random selection). */
function getBeginnerSquatDayPreference(dayIndex) {
  const terms = BEGINNER_SQUAT_DAY_PREFERENCES[dayIndex]
  return terms ? terms.map(escapeRegExp).join('|') : null
}

// ── Beginner hinge day variation ─────────────────────────────────────────────
// Mirrors the squat day-variation above, matching the beginner hinge progression
// already documented in BEGINNER EXERCISE PROGRESSIONS ("Week 1-2: Glute bridge...
// Week 2-4: Glute kickback... Week 4+: Romanian Deadlift with light weight").
// Confirmed against the library: 'Butt Lift (Bridge)' and 'Glute Kickback' exist as
// beginner/bodyweight hinge_bilateral rows; 'Hip Lift with Band' covers "Hip Lift".
// No exercise is literally named "Romanian Deadlift" or "Single Leg RDL" — the
// closest real beginner/dumbbell match is 'Stiff-Legged Dumbbell Deadlift' (same
// movement: a straight-leg loaded hip hinge), included alongside the RDL name terms
// so Day 3 with dumbbells actually resolves to a DB row instead of matching nothing.
const BEGINNER_HINGE_DAY_PREFERENCES = [
  ['butt lift', 'glute bridge', 'bridge'],
  ['glute kickback', 'hip lift', 'kickback'],
]
const BEGINNER_HINGE_DAY3_DUMBBELL_TERMS = ['romanian deadlift', 'rdl', 'single leg rdl', 'stiff-legged dumbbell deadlift', 'stiff leg dumbbell deadlift']

/** Regex source string of the day's preferred hinge exercise names, or null past
 * the defined preference days. Day 3 (index 2) prefers a loaded RDL-style hinge
 * when dumbbells are available (equipmentList null = no restriction = available),
 * otherwise falls back to the same bridge/kickback terms as Day 1-2. */
function getBeginnerHingeDayPreference(dayIndex, equipmentList) {
  if (dayIndex === 2) {
    const dumbbellAvailable = !equipmentList?.length || equipmentList.includes('dumbbell')
    const terms = dumbbellAvailable
      ? BEGINNER_HINGE_DAY3_DUMBBELL_TERMS
      : [...BEGINNER_HINGE_DAY_PREFERENCES[0], ...BEGINNER_HINGE_DAY_PREFERENCES[1]]
    return terms.map(escapeRegExp).join('|')
  }
  const terms = BEGINNER_HINGE_DAY_PREFERENCES[dayIndex]
  return terms ? terms.map(escapeRegExp).join('|') : null
}

// ── Beginner core day variation ──────────────────────────────────────────────
// Same idea as squat/hinge above — without it the core slot tends to repeat one
// exercise (e.g. Spell Caster) across all 3 days. Confirmed against the library:
// 'Dead Bug', 'Bird Dog', 'Side Plank Modified', 'Pallof Press', and 'Seated Leg
// Tucks' all exist exactly as named at core/beginner. No exercise is literally
// named "Elevated Plank" — the closest real match is the base 'Plank' row.
const BEGINNER_CORE_DAY_PREFERENCES = [
  ['dead bug', 'bird dog'],
  ['side plank modified', 'pallof press'],
  ['seated leg tucks', 'plank'],
]

function getBeginnerCoreDayPreference(dayIndex) {
  const terms = BEGINNER_CORE_DAY_PREFERENCES[dayIndex]
  return terms ? terms.map(escapeRegExp).join('|') : null
}

/** Picks one exercise for `pattern`, relaxing filters progressively until something is found.
 * Equipment and the blocked-name exclusion are always hard constraints — zero tolerance means
 * they are never relaxed as a fallback. Difficulty is normally relaxed as a last resort so the
 * plan doesn't go unfilled over a difficulty preference, but for beginners (`strictDifficulty`)
 * it's a hard constraint too — a beginner must never be handed an intermediate/advanced
 * exercise, so the fallback that drops the difficulty filter entirely is skipped. If nothing
 * matches even after the remaining relaxation, the slot is left unfilled (see
 * buildDaySkeletons) rather than returning an exercise the client shouldn't be given.
 * `preferredNamePattern` (optional) additionally requires the name to match a regex —
 * used for beginner squat day-variation — and is not itself relaxed across attempts;
 * the caller retries without it if a preferred pick isn't found. */
async function pickExercise(pool, { pattern, equipmentList, hasBench, difficulty, excludeIds, excludeNamePattern, strictDifficulty, preferredNamePattern }) {
  const attempts = strictDifficulty
    ? [
        { useDifficulty: true, allowRepeat: false },
        { useDifficulty: true, allowRepeat: true  }, // library subset exhausted — repeat an exercise, but never drop the beginner difficulty constraint
      ]
    : [
        { useDifficulty: true,  allowRepeat: false },
        { useDifficulty: false, allowRepeat: false },
        { useDifficulty: false, allowRepeat: true  }, // library subset exhausted — repeat an exercise, but never drop equipment/name constraints
      ]
  for (const { useDifficulty, allowRepeat } of attempts) {
    const conditions = ['movement_pattern = $1']
    const params = [pattern]
    if (!allowRepeat && excludeIds.length) {
      params.push(excludeIds)
      conditions.push(`id != ALL($${params.length})`)
    }
    if (equipmentList?.length) {
      params.push(equipmentList)
      conditions.push(`equipment = ANY($${params.length})`)
    }
    // Bench access is a hard constraint like equipment itself — never relaxed
    // across attempts, and never skipped for a repeat-allowed retry. A client
    // who never answered 'Benches' or 'Full Gym'/'Full gym' cannot physically
    // perform any of the 176 bench-dependent rows regardless of how sparse the
    // remaining library gets for their equipment/difficulty.
    if (!hasBench) {
      conditions.push(`requires_bench = FALSE`)
    }
    if (useDifficulty && difficulty) {
      params.push(difficulty)
      conditions.push(`difficulty = $${params.length}`)
    }
    if (excludeNamePattern) {
      params.push(excludeNamePattern)
      conditions.push(`name !~* $${params.length}`)
    }
    if (preferredNamePattern) {
      params.push(preferredNamePattern)
      conditions.push(`name ~* $${params.length}`)
    }
    const { rows } = await pool.query(
      `SELECT * FROM exercises WHERE ${conditions.join(' AND ')} ORDER BY random() LIMIT 1`,
      params,
    )
    if (rows[0]) return rows[0]
  }
  return null
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

/** Builds the per-day exercise skeleton (deterministic DB picks, no AI involved yet).
 * Exported so the pull-slot fallback behaviour can be exercised directly against a
 * real library (see workoutGenerator.test.js) without a live Claude call. */
export async function buildDaySkeletons(pool, { daysPerWeek, sessionLength, equipmentList, hasBench, difficulty, preferBilateral, excludeNamePattern, levelRelaxedExcludeNamePattern, strictDifficulty, isBeginner, injuryFlags, includeSuperset, fitnessLevel }) {
  const usedIds = []
  const days = []
  let totalFilled = 0
  for (let d = 0; d < daysPerWeek; d++) {
    const quota = buildDayQuota(d, sessionLength)
    const slots = []
    for (const slot of quota) {
      const pattern = slotToPattern(slot, preferBilateral)

      // Every strength-pattern slot (squat, upper_push, hinge, upper_pull, core)
      // additionally excludes PLYO_TERMS on top of the caller's normal exclusions —
      // see PLYO_EXCLUDED_SLOTS above. Core slot further excludes sprint/cardio-named
      // exercises — see CORE_SLOT_BLOCKED_TERMS above.
      let slotExcludeNamePattern = excludeNamePattern
      // Same per-slot additions applied to the level-block-free variant, so the
      // pull fallback ladder's tier 2 still carries the plyo exclusion it relaxes
      // nothing about — see fillPullSlot.
      let slotLevelRelaxedExcludeNamePattern = levelRelaxedExcludeNamePattern ?? excludeNamePattern
      if (PLYO_EXCLUDED_SLOTS.has(slot)) {
        const plyoPattern = PLYO_TERMS.map(escapeRegExp).join('|')
        slotExcludeNamePattern = combinePatterns(excludeNamePattern, plyoPattern)
        slotLevelRelaxedExcludeNamePattern = combinePatterns(slotLevelRelaxedExcludeNamePattern, plyoPattern)
        // Defensive check: combinePatterns must fold the plyo terms into the final
        // pattern for every strength slot — if it silently dropped them (e.g. a
        // future combinePatterns change breaks the `a && b` branch), a plyo exercise
        // could leak into squat/hinge/push/pull/core with no query-level exclusion
        // at all. Fail loudly rather than let that regress silently.
        if (!slotExcludeNamePattern || !slotExcludeNamePattern.includes(plyoPattern)) {
          console.error(`[workoutGenerator] PLYO_TERMS failed to combine into excludeNamePattern for slot=${slot} (day ${d + 1}) — plyo exercises may not be excluded from this query. excludeNamePattern=${JSON.stringify(excludeNamePattern)} plyoPattern=${JSON.stringify(plyoPattern)} result=${JSON.stringify(slotExcludeNamePattern)}`)
        }
      }
      if (slot === 'core') {
        slotExcludeNamePattern = combinePatterns(slotExcludeNamePattern, CORE_SLOT_BLOCKED_TERMS.map(escapeRegExp).join('|'))
        slotLevelRelaxedExcludeNamePattern = combinePatterns(slotLevelRelaxedExcludeNamePattern, CORE_SLOT_BLOCKED_TERMS.map(escapeRegExp).join('|'))
      }

      // Beginner squat day-variation: try the day's preferred name pattern first
      // (excludeIds already carries every exercise used on prior days of this
      // program, so this also naturally avoids repeats even without a match).
      let exercise = null
      if (slot === 'squat' && isBeginner) {
        const preferredNamePattern = getBeginnerSquatDayPreference(d)
        if (preferredNamePattern) {
          exercise = await pickExercise(pool, { pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds, excludeNamePattern: slotExcludeNamePattern, strictDifficulty, preferredNamePattern })
        }
      }
      // Beginner hinge day-variation: same idea as squat above — bridge/kickback
      // early, a loaded hinge (RDL-style) once dumbbells are available on Day 3.
      if (!exercise && slot === 'hinge' && isBeginner) {
        const preferredNamePattern = getBeginnerHingeDayPreference(d, equipmentList)
        if (preferredNamePattern) {
          exercise = await pickExercise(pool, { pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds, excludeNamePattern: slotExcludeNamePattern, strictDifficulty, preferredNamePattern })
        }
      }
      // Beginner core day-variation: same idea as squat/hinge above.
      if (!exercise && slot === 'core' && isBeginner) {
        const preferredNamePattern = getBeginnerCoreDayPreference(d)
        if (preferredNamePattern) {
          exercise = await pickExercise(pool, { pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds, excludeNamePattern: slotExcludeNamePattern, strictDifficulty, preferredNamePattern })
        }
      }
      // Day 3 pull-pattern variation: try a vertical pull (pulldown-family) before
      // anything else, so a 3-day program isn't 3 horizontal rows back to back. If
      // none is available for this client's equipment, fall through to whatever
      // horizontal pull the rest of this block finds, but keep a coach-facing flag.
      // Vertical-pull rows in the library are tagged 'bands', 'body only', or
      // 'cable' — never 'dumbbell'/'barbell'/etc — so a client whose equipment is
      // e.g. dumbbells + bench would never match one under the normal equipment
      // filter, even though a bodyweight/band vertical pull is always physically
      // performable regardless of what other equipment they have. Relax equipment
      // ONLY for this one preferred pick (never the exercise list generally, and
      // never the fallback picks below) to also allow 'body only'/'bands'.
      let pullVarietyFlag = null
      if (!exercise && slot === 'upper_pull' && d === VERTICAL_PULL_DAY_INDEX) {
        const verticalPullEquipmentList = equipmentList?.length
          ? [...new Set([...equipmentList, 'body only', 'bands'])]
          : equipmentList // null = "Full Gym" = no restriction already
        exercise = await pickExercise(pool, { pattern, equipmentList: verticalPullEquipmentList, hasBench, difficulty, excludeIds: usedIds, excludeNamePattern: slotExcludeNamePattern, strictDifficulty, preferredNamePattern: getVerticalPullPreference() })
        if (!exercise) pullVarietyFlag = PULL_VARIETY_FLAG
      }
      // Low back injury: prefer a supported single-arm row for the horizontal pull
      // slot over whatever bilateral row would otherwise be picked (bent-over rows
      // are already hard-excluded above, but this actively biases toward the safer
      // supported variant rather than leaving it to chance among what's left).
      if (!exercise && slot === 'upper_pull' && injuryFlags?.lowerBack) {
        const preferredNamePattern = getLowerBackPullPreference(equipmentList)
        exercise = await pickExercise(pool, { pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds, excludeNamePattern: slotExcludeNamePattern, strictDifficulty, preferredNamePattern })
      }
      if (!exercise) {
        exercise = await pickExercise(pool, { pattern, equipmentList, hasBench, difficulty, excludeIds: usedIds, excludeNamePattern: slotExcludeNamePattern, strictDifficulty })
      }

      // A pull slot is never allowed to go unfilled — see the fillPullSlot ladder
      // above for why, and for what each tier gives up. Applies to every equipment
      // selection now, not just a client whose equipment is exactly ['body only'].
      let fallbackNotes = null
      let pullFallbackReason = null
      let pullFallbackBypassedBlock = false
      if (!exercise && slot === 'upper_pull') {
        const fallback = await fillPullSlot(pool, {
          dayIndex: d,
          pattern,
          equipmentList,
          hasBench,
          difficulty,
          usedIds,
          excludeNamePattern: slotExcludeNamePattern,
          levelRelaxedExcludeNamePattern: slotLevelRelaxedExcludeNamePattern,
          isBeginner,
          fitnessLevel,
        })
        exercise = fallback.exercise
        fallbackNotes = fallback.notes
        pullFallbackReason = fallback.reason
        pullFallbackBypassedBlock = fallback.bypassedBlock
        // The vertical-pull substitute IS a vertical pull, so it satisfies the Day 3
        // variety preference and clears that flag; every other tier leaves it standing
        // and appends its own reason alongside.
        if (fallback.isVerticalPull) pullVarietyFlag = null
        pullVarietyFlag = combineFlags(pullVarietyFlag, fallback.flag)
      }

      if (!exercise) {
        console.error(
          `[workoutGenerator] No exercise found for slot: pattern=${pattern} equipment=${JSON.stringify(equipmentList)} difficulty=${difficulty ?? 'any'} (day ${d + 1}) — skipping slot`,
        )
        continue // library has nothing matching this exact slot; skip it rather than fail the whole plan
      }
      if (exercise.id != null) usedIds.push(exercise.id)
      totalFilled++
      slots.push({
        slot_id: `d${d}-${slots.length}`,
        exercise_id: exercise.id ?? null,
        name: exercise.name,
        movement_pattern: exercise.movement_pattern,
        // Deterministic quota slot (squat/hinge/upper_push/upper_pull/core/carry/
        // conditioning) this exercise was picked for — distinct from
        // exercise.movement_pattern above, which comes straight from the DB row and
        // can't be trusted for pairing logic (the library has had rows mistagged
        // before, e.g. cardio exercises mistagged movement_pattern='core' — see
        // CORE_SLOT_BLOCKED_TERMS). Superset pairing below keys off this field so a
        // mistagged row can never get paired into the wrong superset slot.
        quotaSlot: slot,
        equipment: exercise.equipment,
        fallbackNotes,
        pullVarietyFlag,
        pullFallbackReason,
        pullFallbackBypassedBlock,
        // groupType/groupId: 'exercise'/null until the superset-pairing block below
        // (deterministic, code-only) claims a push/pull pair, or the circuit-grouping
        // pass in mergeResponse (AI-proposed, via circuit_group) claims a slot that
        // superset pairing left alone. Superset always takes precedence — see mergeResponse.
        groupType: 'exercise',
        groupId: null,
        // Only ever forced true on the push half of a superset pair — see below.
        // Never relaxed/inferred from the AI response: rest=0 between a superset's
        // two exercises must hold even if Claude ignores or misreads the prompt's
        // "no rest between them" instruction.
        forceZeroRest: false,
      })
    }
    // Superset pairing: always pair the day's push + pull slots (guaranteed one of
    // each — both are in BASE_QUOTA every day) when the coach requested supersets.
    // Core/hinge/squat/bonus slots stay standalone — no pairing rule for those was
    // specified, so they're deliberately left out rather than guessed at. Keyed off
    // quotaSlot (the loop's own slot variable), not movement_pattern, so a hinge or
    // squat exercise can never be tagged into the push/pull superset.
    if (includeSuperset) {
      const pushSlot = slots.find(s => s.quotaSlot === 'upper_push')
      const pullSlot = slots.find(s => s.quotaSlot === 'upper_pull')
      // Guard against pairing a missing/placeholder exercise: if the push slot was
      // skipped entirely (library had nothing to fill it — see the `continue` above)
      // pushSlot is undefined and this already wouldn't match, but a defensive name
      // check on both slots means a day can never end up superset-labeled as
      // pull+pull (or push+push) if either side isn't a real, named exercise.
      const hasRealExercise = s => !!s && typeof s.name === 'string' && s.name.trim().length > 0
      if (hasRealExercise(pushSlot) && hasRealExercise(pullSlot)) {
        const supersetGroupId = `d${d}-superset`
        pushSlot.groupType = 'superset'
        pushSlot.groupId   = supersetGroupId
        pullSlot.groupType = 'superset'
        pullSlot.groupId   = supersetGroupId
        // Exercise 1 (push) is immediately followed by Exercise 2 (pull) with no
        // rest between them — only the round rest (after pull) is a real rest
        // period, and that stays whatever Claude assigns via ai.rest_seconds.
        pushSlot.forceZeroRest = true
      } else {
        console.warn(`[workoutGenerator] Skipping superset labeling for day ${d + 1} — push and/or pull slot has no valid exercise (push=${pushSlot?.name ?? 'missing'}, pull=${pullSlot?.name ?? 'missing'})`)
      }
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

const CIRCUIT_LABELS  = { none: 'No circuits — standard format', some: 'Some circuits — about 1 per workout', full: 'Full circuits — multiple circuits' }

function buildWorkoutPrompt(firstName, answers, daySkeletons, beginnerBlockList, floorTransferContext, injuryFlags = {}, coachName = 'Katie') {
  const goals = Array.isArray(answers.goals) ? answers.goals.join(', ') : answers.goals
  const equipment = Array.isArray(answers.equipment) ? answers.equipment.join(', ') : answers.equipment
  const isBegginer = (FITNESS_LEVEL_MAP[answers.fitness_level] ?? answers.fitness_level) === 'beginner'

  // Each slot carries its quota pattern (squat/upper_push/hinge/upper_pull/core/…)
  // because the circuit rules below turn on it — without the pattern spelled out
  // per slot, the model only sees an exercise name and a slot id and cannot tell
  // which row is the squat and which is the hinge, so it can't honour the
  // "never circuit squat with hinge" rule even when told to. mergeResponse still
  // enforces that rule regardless of what comes back.
  const skeletonText = daySkeletons.map(day => (
    `Day ${day.day_index + 1} (${day.day_focus}):\n` +
    day.slots.map(s => `  - [${s.slot_id}] "${s.name}" (pattern: ${s.quotaSlot})`).join('\n')
  )).join('\n\n')

  const blockedText = beginnerBlockList.length
    ? `\nBEGINNER BLOCK LIST — these exercises must not appear in cues, substitutions, or warmup suggestions: ${beginnerBlockList.join(', ')}.`
    : ''

  const floorText = floorTransferContext
    ? `\n${floorTransferContext}`
    : ''

  const beginnerProgressionText = isBegginer ? `

BEGINNER EXERCISE PROGRESSIONS
The exercises for this program were already selected from the library within safe beginner bounds — you are not choosing exercises. Use this ladder only to calibrate how you write cues, sets/reps, and coaching notes so they match where a true beginner actually is:

Hinge pattern progression (early programs progress in this order):
- Week 1-2: Glute bridge (floor) or hip thrust to bench
- Week 2-4: Glute kickback (standing, bodyweight)
- Week 4+: Romanian Deadlift (RDL) with light weight
- Never: kettlebell swings, hang cleans, or any ballistic hinge pattern

Squat pattern progression:
- Start with bodyweight squat or sit-to-stand from chair
- Goblet squat only in week 3+ or a second program
- Never: barbell back squat, jump squat, or lateral bound as a squat substitute

Push pattern progression:
- Start with wall push-up or incline push-up (hands on counter/bench)
- Floor push-up only after wall/incline is mastered
- DB floor press is acceptable (floor stops ROM, teaches control)
- Never: barbell bench press on day 1

Core progression:
- Dead bug is the default beginner core exercise
- Side bridge (modified, knees bent) and seated leg tucks in a chair are acceptable
- Never: cocoons, jackknife sit-ups, Russian twist, Janda sit-up, or any rotational loaded core` : ''

  const injuryContextLines = []
  if (injuryFlags.knee) {
    injuryContextLines.push('Right knee arthritis / knee injury flagged: never write cues implying lunges, lateral bounds, jump squats, or single-leg exercises with impact. The selected exercises already avoid these — keep coaching notes consistent with bilateral, controlled, low-impact movement.')
  }
  if (injuryFlags.wrist) {
    injuryContextLines.push('Carpal tunnel / wrist issue flagged: avoid cues that put the wrist into full extension under load. For any push exercise, explicitly note the wrist cue (e.g. "press from a neutral wrist, weight through the knuckles" or "fists/handles instead of flat palm if that\'s more comfortable").')
  }
  if (injuryFlags.lowerBack) {
    injuryContextLines.push('Low back injury or pain: Never generate bent-over bilateral rows (bent over barbell row, bent over dumbbell row) as these place unsupported load on the lumbar spine. Substitute with single-arm rows where the client can brace with their free hand on a bench or front leg in a split stance. Cue the supported position explicitly in every description.')
    injuryContextLines.push('Also for low back: never write cues implying deadlifts (other than sumo or trap-bar variations), good mornings, or stiff-leg movements as primary movements — the selected exercises already avoid these. Reinforce hip-hinge cues from a supported/controlled position.')
  }
  const injuryText = injuryContextLines.length ? `\n${injuryContextLines.map(l => `- ${l}`).join('\n')}` : ''

  // Circuits and supersets requested together need extra prompt context. Superset
  // pairing is decided entirely in code (buildDaySkeletons claims each day's
  // upper_push + upper_pull before the model is ever called), and mergeResponse's
  // circuit-bucketing pass skips any slot already carrying group_type='superset'.
  // So a circuit_group naming push or pull is silently dropped on merge — and if
  // that leaves the bucket with fewer than 2 members the circuit disappears
  // entirely. The model is deliberately never told supersets exist (they're pure
  // app-side structure, see the "Do NOT mention supersets" rule below), so without
  // this it has no way to know those two slots are unavailable, and the
  // upper_push + upper_pull + core pattern below — previously offered to it as an
  // explicitly allowed example — collapsed to zero circuit grouping every time.
  const supersetsActive = answers.supersets !== 'none'
  const circuitsActive  = answers.circuits !== 'none'
  const bothStructuresActive = supersetsActive && circuitsActive

  // With push and pull reserved, a 45-minute day only has squat, hinge and core
  // left, and squat-with-hinge is forbidden — so 2 is the realistic ceiling there.
  // Asking for 3-4 anyway would push the model straight back onto a reserved slot.
  const circuitSizeText = bothStructuresActive ? '2-3' : '3-4'

  const circuitAllowedExamples = bothStructuresActive
    ? '- Allowed:     squat + core   |   hinge + core   |   squat + core + carry/conditioning   |   hinge + core + carry/conditioning'
    : '- Allowed:     squat + upper_push + core   |   hinge + upper_pull + core   |   upper_push + upper_pull + core'

  const circuitNotAllowedExamples = bothStructuresActive
    ? '- NOT allowed: squat + hinge + anything    |   any circuit_group containing both the squat and the hinge slot    |   any circuit_group containing the upper_push or upper_pull slot'
    : '- NOT allowed: squat + hinge + anything    |   any circuit_group containing both the squat and the hinge slot'

  const supersetReservationText = bothStructuresActive ? `
RESERVED SLOTS — READ THIS BEFORE ASSIGNING ANY circuit_group
The "upper_push" and "upper_pull" slots on every day are already reserved by the app for a separate pairing and are NOT available for circuits.
- Never give the "upper_push" or "upper_pull" slot a "circuit_group" value. On every day both must be "circuit_group": null. A circuit_group naming either of them is discarded outright.
- Build each circuit_group only from the remaining slots: squat, hinge, core, and — when that day has one — carry or conditioning.
- Combined with the squat/hinge rule below, one circuit = the core slot plus EITHER the squat or the hinge slot (never both), plus any carry/conditioning slot that day has.
- REQUIRED: every training day must contain exactly ONE circuit_group built this way, even when the circuits selection above says "full" — with push and pull reserved there is only ever room for one circuit per day, so produce one per day and no more.
- A 2-exercise circuit is correct and expected here. Never skip a day's circuit or leave every slot null just because only two eligible slots remain, and never pad it back to 3-4 by reaching for a reserved slot.
` : ''

  // Longer sessions add one bonus carry/conditioning slot per day (see BONUS_SLOTS
  // in buildDayQuota), which the static rules above only mention in passing as
  // something to fold into a circuit "when that day has one." In testing, Claude
  // never actually included it — a static, shared-across-all-days rule wasn't
  // salient enough. Calling the slot out by name, per day, is a much more direct
  // nudge than trusting the model to notice which of its own days qualifies.
  const bonusSlotDayNotes = circuitsActive
    ? daySkeletons
        .map(day => {
          const bonusSlot = day.slots.find(s => s.quotaSlot === 'carry' || s.quotaSlot === 'conditioning')
          if (!bonusSlot) return null
          return `- Day ${day.day_index + 1}: this day has a bonus ${bonusSlot.quotaSlot} slot — [${bonusSlot.slot_id}] "${bonusSlot.name}". Include it in that day's circuit_group alongside the squat-or-hinge + core pairing. Do not leave it standalone.`
        })
        .filter(Boolean)
        .join('\n')
    : ''

  const bonusSlotText = bonusSlotDayNotes ? `
BONUS SLOT — INCLUDE IN THAT DAY'S CIRCUIT
${bonusSlotDayNotes}
` : ''

  return `You are ${coachName}, the Life Warrior Coaching workout programming assistant for women over 40.

YOUR ROLE
The exercises for each training day have already been selected from the LWC approved library by movement pattern. Your job is to:
1. Write sets, reps, rest, and one coaching cue per exercise
2. Write a dynamic warm-up for each day that prepares the exact movement patterns used that day
3. Write a brief cool-down reminder for each day
4. Give the program a name and a short ${coachName}-style intro (2-3 sentences)

Do NOT change, rename, substitute, or add exercises. The exercise list is final.

LIFE WARRIOR COACHING IDENTITY
You speak with calm authority and genuine care. You are direct, supportive, and never use shame or punishment language. Use language like: "small wins stack," "you showed up — that matters," "momentum builds here," "let's protect that progress." Never say: perfect, failed, failure, bad, lost your streak, non-compliant.

PROGRAMMING PHILOSOPHY — FOLLOW EXACTLY
- Full-body movement pattern training. Not body-part splits.
- Maintain at least 1:1 pull-to-push ratio across the week. 2:1 pull-to-push is preferred.
- Warm-up must use DYNAMIC mobility and activation only. No static stretching before strength work.
- Warm-up must prepare the exact movement patterns used in that day's strength work.
- Place core work near the beginning of the strength section, not at the end.
- Keep power work outside fast circuits — power quality requires recovery.
- Unilateral reps must always say "each side" — never write an ambiguous total.

DAY STRUCTURE — REQUIRED SEQUENCE
Every training day already follows this exact order (Warm-Up -> Squat -> Push -> Hinge -> Pull -> Core -> Cool-Down), non-negotiable regardless of fitness level, so the two lower-body patterns (squat, hinge) are never adjacent. This is enforced by the exercise list below — do not reorder the given slots, and write warm-up/cool-down copy consistent with this sequence.

EQUIPMENT HARD RULES — ZERO TOLERANCE
The exercises below were already filtered to the client's available equipment (${equipment || 'Full Gym'}) — every exercise you see already satisfies this. Zero tolerance for cues that imply otherwise:
- Never add an "if you had equipment" note or reference equipment the client doesn't have.
- Never suggest a substitution that requires equipment outside ${equipment || 'anything available in a full gym'}.
- If equipment is bodyweight-only, every cue must describe a zero-equipment execution.

CLIENT PROFILE
- Name: ${firstName}
- Primary goal: ${goals}
- Secondary goal: ${answers.secondary_goal || 'None'}
- Training days/week: ${answers.days_per_week}
- Session length: ${answers.session_length}
- Available equipment: ${equipment || 'Full Gym'}
- Fitness level: ${answers.fitness_level}
- Strength training history: ${answers.strength_history || 'Not specified'}
- Floor transfer ability: ${answers.floor_transfer || 'Not specified'}
- Circuits: ${CIRCUIT_LABELS[answers.circuits] || 'No circuits'}
- Injuries/limitations and program direction: ${answers.injuries || 'None'}
${floorText}
INJURY AND LIMITATION FLAGS${injuryText || '\n- None flagged for this client.'}
- Floor limitations: whenever a cue involves getting down to or up from the floor, include a clear setup instruction for using a chair or wall — never skip this note for a floor exercise.

STRUCTURE RULES — ENFORCE EXACTLY
Circuits selection: ${answers.circuits}
- "none" = no circuits anywhere in the workout. Every exercise's "circuit_group" must be null.
- "some" = exactly ONE circuit of ${circuitSizeText} exercises per workout day, no more. Give every exercise in that circuit the SAME "circuit_group" value (e.g. "1"); every other exercise that day gets "circuit_group": null.
- "full" = organize the strength work into multiple ${circuitSizeText} exercise circuits where session length permits. Give each circuit's exercises a shared "circuit_group" value, distinct per circuit within that day (e.g. "1" for the first circuit, "2" for the second); any leftover exercise that doesn't fit a full circuit gets "circuit_group": null.

"circuit_group" only groups exercises WITHIN the same day — values don't need to be unique across different days, and never apply it to Warm-Up or Cool-Down (those aren't in the exercises list). Never place one exercise's slot_id in more than one circuit_group. Never invent extra exercises to fill a circuit — group only from the exercises already given to you for that day.
${supersetReservationText}
CIRCUIT PATTERN RULE — HARD CONSTRAINT, NO EXCEPTIONS
Never put the "squat" slot and the "hinge" slot in the same "circuit_group". Each exercise above is tagged with its pattern in parentheses — check those tags before assigning any circuit_group. A circuit may contain at most ONE of squat or hinge. Grouping both would place the day's two lower-body movements back to back inside the circuit's rounds, which the required day sequence forbids.
REQUIRED: the "core" slot must always be one of the circuit_group's members. Never tag squat and hinge into the same circuit_group and leave core untagged — that is not a valid circuit, it just pairs the two forbidden lower-body slots together. Every circuit_group you create must be built around core paired with squat OR hinge (never both).
${circuitAllowedExamples}
${circuitNotAllowedExamples}
If a circuit would need both squat and hinge, drop the hinge from it, keep core paired with squat instead, and leave the hinge exercise's "circuit_group" null — never leave core out.
${bonusSlotText}
Show inter-exercise rest AND round rest explicitly (via "rest_seconds" and "notes") when circuits are used.
Use opposing or non-competing movement patterns in circuits (upper/lower alternation preferred).

Do NOT mention supersets, circuits, paired exercises, superset/circuit labels or numbers, or exercise sequencing between exercises in any notes or descriptions. Do not use the words 'Superset', 'Circuit', 'Circuit 1', 'Exercise 1', 'Exercise 2', 'go straight into', 'move directly into', or 'no rest' in any exercise description. The app renders all superset/circuit structure, labeling, and badges automatically from the "circuit_group" field and the app's own superset pairing — never describe it in prose.
${blockedText}

BEGINNER RULES${isBegginer ? ' — THIS CLIENT IS A BEGINNER. ENFORCE ALL OF THESE.' : ' (not applicable — intermediate/advanced client)'}
${isBegginer ? `- Begin with low complexity and generous rest (minimum 60 seconds between sets)
- 2 sets of 10-12 reps for strength exercises
- Prioritize breathing, setup, and movement control in every cue
- Do not write cues that assume prior strength training experience
- Warmup cues should be simple and clearly explained
- Flag any exercise in the list that seems beyond beginner level so the coach can review` : `- Standard sets/reps/rest appropriate for ${answers.fitness_level} level`}
${beginnerProgressionText}

SETS/REPS/REST DEFAULTS BY GOAL
- Weight loss: 3 sets 8-12 reps, 30-45 sec rest in circuits, up to 10 min post-strength conditioning
- Muscle gain: 3-4 sets 8-10 reps, 60-90 sec rest between pairings
- Endurance: higher reps 12-15, shorter rest 30-45 sec
- General fitness: 3 sets 10-12 reps, 45-60 sec rest
- Flexibility/mobility: focus on range and control, not load

Apply the session length (${answers.session_length}) to keep total workout time realistic. Do not prescribe more volume than fits the time.

WARM-UP RULES
- Approximately 5 minutes
- Dynamic mobility and activation ONLY — no static stretching
- Must prepare every movement pattern used in that day's strength work
- Write it as 3-5 specific exercises or one integrated flow (e.g. "leg swings → hip circles → bodyweight squat → arm circles → band pull-apart")
- Keep cues brief and actionable

COOL-DOWN
- Brief reminder only (1-2 sentences)
- Tell the client what to stretch and why — do not write a full routine

EXERCISE DESCRIPTION QUALITY STANDARDS
Every exercise "notes" field must read like a coach is in the room, not a manual — warm, direct, specific, never generic. Keep it short: setup + movement + coaching note combined must be 3 sentences maximum, and the breathing cue is exactly one additional sentence (4 sentences total — hard cap, do not exceed it). Cover all four:
1. Setup: exactly how to get into position, including any props needed (chair, wall, bench)
2. The movement: what to do, in plain language a beginner can follow
3. Breathing cue: exactly when to breathe in and when to breathe out — one sentence only
4. The coaching note: one cue that connects the exercise to their goal or limitation (e.g. "this builds the glute strength that actually supports your knee joint")

ABSOLUTELY NEVER GENERATE THESE EXERCISES FOR ANY CLIENT AT ANY LEVEL:
- Russian Twist (any variation)
- Janda Sit-Up
- Jackknife Sit-Up
- Cocoon (unless explicitly approved by coach for advanced clients)
- Hang Clean (any variation)
- Any Olympic lift for non-athletic populations

TRAINING DAY EXERCISES (DO NOT CHANGE THESE):
${skeletonText}

Respond with raw JSON only. No markdown. No code fences. No prose before or after. No newlines or special characters inside string values — use a space instead.

Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "program_name": "string (creative, motivating LWC-style program name)",
  "description": "string (2-3 sentences, ${coachName}-style intro using Life Warrior language)",
  "days": [
    {
      "warmup": {
        "duration": "string (e.g. '5 minutes')",
        "exercises": "string (specific dynamic movements that prepare today's patterns)"
      },
      "cooldown": {
        "duration": "string (e.g. '3-5 minutes')",
        "notes": "string (brief stretch reminder)"
      },
      "exercises": [
        {
          "slot_id": "string (exactly as given above)",
          "sets": number,
          "reps": "string (e.g. '10-12' or '30 seconds' or '10 each side')",
          "rest_seconds": number,
          "notes": "string (setup + movement + breathing cue + coaching note, 4 sentences maximum, per EXERCISE DESCRIPTION QUALITY STANDARDS above)",
          "circuit_group": "string or null (short id shared by every exercise in the same circuit on this day, per STRUCTURE RULES above — null if this exercise is not part of a circuit)"
        }
      ]
    }
  ]
}

Include exactly ${daySkeletons.length} days in the same order as given. Echo each slot_id exactly as provided. Make sets/reps/rest realistic for a ${answers.fitness_level} trainee with a ${answers.session_length} session.`
}

// ── Response merge ───────────────────────────────────────────────────────────
// Re-attaches the DB-selected name/exercise_id/movement_pattern to each slot
// (defense in depth — even though the prompt forbids it, never trust the model
// to preserve exact exercise names) and prepends/appends warm-up/cool-down as
// synthetic exercise rows (sets=1, matching the pre-existing UI convention).
//
// Grouping (group_id/group_type/group_label) is assembled here from two
// sources: superset pairing is decided entirely by buildDaySkeletons (code,
// never the AI — see includeSuperset there) and just needs relabeling into
// the shared shape; circuit membership is proposed by the AI per exercise via
// circuit_group and cleaned up below (malformed/singleton tags dropped,
// ignored outright when the client didn't request circuits). Superset always
// takes precedence over a circuit tag on the same slot — see the group_type
// guard in the circuit-bucketing pass.
//
// group_label mirrors client/src/utils/workoutGrouping.js's groupLabelFor():
// 'A'/'B' by push/pull order for supersets, '1'/'2'/… by in-day appearance
// order for circuits. Keep both in sync if either changes.

function mergeResponse(daySkeletons, aiPlan, { includeCircuit = false } = {}) {
  const days = daySkeletons.map((skeleton, i) => {
    const aiDay = aiPlan.days?.[i] ?? {}
    const aiBySlot = new Map((aiDay.exercises ?? []).map(e => [e.slot_id, e]))

    // slot_id -> exercise object, so the circuit-grouping pass below can mutate
    // the exact object already pushed for that slot.
    const exerciseBySlotId = new Map()
    const quotaExercises = []
    for (const slot of skeleton.slots) {
      const ai = aiBySlot.get(slot.slot_id) ?? {}
      const ex = {
        name: slot.name,
        exercise_id: slot.exercise_id,
        movement_pattern: slot.movement_pattern,
        equipment: slot.equipment ?? null,
        sets: ai.sets ?? null,
        reps: ai.reps ?? null,
        // Superset lead (push) exercise always gets rest=0 regardless of what Claude
        // returned — see forceZeroRest in buildDaySkeletons. The paired pull exercise
        // is unaffected and keeps the normal ai-provided rest period.
        rest_seconds: slot.forceZeroRest ? 0 : (ai.rest_seconds ?? null),
        // Hardcoded fallback exercises (e.g. the bodyweight pull substitute) carry
        // their own fixed description — never let Katie's guess override it.
        notes: slot.fallbackNotes ?? ai.notes ?? null,
        // Coach-facing only (see PULL_VARIETY_FLAG) — not shown to the client, and
        // never overrides the exercise itself, which is otherwise perfectly valid.
        pull_variety_flag: slot.pullVarietyFlag ?? null,
        // Set when the pull-slot fallback ladder had to relax difficulty, bypass the
        // fitness-level name block, or substitute a no-equipment exercise (see
        // fillPullSlot). Uses the same flagged/flag_reason mechanism as the
        // equipment-mismatch case in workoutValidation.js so a coach reviews it —
        // but deliberately does NOT blank out the exercise name the way that case
        // does, since the whole point is that a real pull got selected.
        ...(slot.pullFallbackReason
          ? { flagged: true, flag_reason: slot.pullFallbackReason, flag_note: slot.pullVarietyFlag ?? null }
          : {}),
        // Tells validateWorkoutPlan this specific name was allowed on purpose, so it
        // isn't re-rejected as [BLOCKED EXERCISE] — which would put the day back to
        // having no pull at all, the exact bug this ladder exists to fix.
        ...(slot.pullFallbackBypassedBlock ? { block_bypass_approved: true } : {}),
        section_name: 'Strength',
        group_id: slot.groupId,
        group_type: slot.groupType,
        group_label: null, // filled in below, once every group's membership for the day is final
      }
      quotaExercises.push(ex)
      exerciseBySlotId.set(slot.slot_id, ex)
    }

    // Circuit grouping — AI-proposed via circuit_group, applied only to slots
    // the code hasn't already claimed for a superset. Ignored entirely when
    // circuits weren't requested, regardless of what the AI returned, so a
    // stray/hallucinated circuit_group can never surface when "none" was selected.
    if (includeCircuit) {
      const buckets = new Map() // raw circuit_group tag -> [{ slotId, quotaSlot }], in day order
      for (const slot of skeleton.slots) {
        const ex = exerciseBySlotId.get(slot.slot_id)
        if (ex.group_type !== 'exercise') continue // already superset-paired — a circuit can never override that
        const ai = aiBySlot.get(slot.slot_id) ?? {}
        const tag = typeof ai.circuit_group === 'string' ? ai.circuit_group.trim()
          : typeof ai.circuit_group === 'number' ? String(ai.circuit_group) : null
        if (!tag) continue
        if (!buckets.has(tag)) buckets.set(tag, [])
        buckets.get(tag).push({ slotId: slot.slot_id, quotaSlot: slot.quotaSlot })
      }
      for (const members of buckets.values()) {
        if (members.length < 2) continue // a "circuit" of one exercise isn't a real group — leave it standalone
        // The AI is told the per-slot pattern and the no-squat-with-hinge rule
        // (see buildWorkoutPrompt), but never trust it to have respected that — a
        // circuit holding both would force them back-to-back within the circuit's
        // rounds, exactly what the day template's non-adjacency rule prevents.
        //
        // Salvage rather than discard: keep the FIRST lower-body member and demote
        // only the later one(s) to standalone. Day order is squat -> push -> hinge ->
        // pull -> core, so the retained member is the squat, and keeping the earliest
        // also keeps the group anchored at its original position once the
        // first-appearance reorder below runs. Dropping the whole grouping (the old
        // behaviour) cost the client every circuit on the day over one bad member,
        // which in testing was most circuit attempts.
        const kept = []
        const demoted = []
        let lowerBodyKept = false
        for (const m of members) {
          const isLowerBody = m.quotaSlot === 'squat' || m.quotaSlot === 'hinge'
          if (isLowerBody && lowerBodyKept) { demoted.push(m); continue }
          if (isLowerBody) lowerBodyKept = true
          kept.push(m)
        }
        // A group needs 2+ members to be a real group. If salvaging leaves fewer
        // (e.g. the AI tagged squat+hinge together and left core untagged), first
        // try pulling in that day's core slot as the second member before giving
        // up — core is the intended pairing per the CIRCUIT PATTERN RULE, and it's
        // sitting right there untagged in exactly the failure case this handles.
        // Only steal it if the AI didn't already tag it into some other group
        // (coreTag would be set) and it isn't superset-claimed.
        if (kept.length < 2) {
          const coreSlot = skeleton.slots.find(s => s.quotaSlot === 'core')
          const coreEx = coreSlot ? exerciseBySlotId.get(coreSlot.slot_id) : null
          const coreAi = coreSlot ? (aiBySlot.get(coreSlot.slot_id) ?? {}) : {}
          const coreTag = typeof coreAi.circuit_group === 'string' ? coreAi.circuit_group.trim()
            : typeof coreAi.circuit_group === 'number' ? String(coreAi.circuit_group) : null
          const coreAvailable = coreEx && coreEx.group_type === 'exercise' && !coreTag
          if (coreAvailable) {
            kept.push({ slotId: coreSlot.slot_id, quotaSlot: coreSlot.quotaSlot })
            console.warn(`[workoutGenerator] Salvaged AI circuit_group for day ${i + 1} by pulling in the untagged core slot (${coreSlot.slot_id}) as the second member, after removing ${demoted.length || members.length - 1} conflicting lower-body slot(s): ${members.map(m => m.slotId).join(', ')}`)
          } else {
            console.warn(`[workoutGenerator] Dropping AI circuit_group for day ${i + 1} — contains ${members.length - kept.length + 1} lower-body (squat/hinge) slots, fewer than 2 members would remain after removing the conflict, and no untagged core slot was available to salvage with: ${members.map(m => m.slotId).join(', ')}`)
            continue
          }
        }
        if (demoted.length) {
          console.warn(`[workoutGenerator] Salvaged AI circuit_group for day ${i + 1} — removed ${demoted.length} conflicting lower-body slot(s) (${demoted.map(m => `${m.slotId}/${m.quotaSlot}`).join(', ')}) and kept the circuit as ${kept.map(m => m.slotId).join(', ')}`)
          // Explicit reset: these were already 'exercise'/null (the bucket builder
          // skips anything superset-claimed), but state it so a demoted slot can
          // never inherit stale grouping if that ever changes.
          for (const { slotId } of demoted) {
            const ex = exerciseBySlotId.get(slotId)
            ex.group_type = 'exercise'
            ex.group_id = null
            ex.group_label = null
          }
        }
        // groupId/labels key off `kept`, not `members` — a demoted first member must
        // not name the group or leave a gap in the 1/2/3… label sequence.
        const groupId = `d${i}-circuit-${kept[0].slotId}`
        kept.forEach(({ slotId }, idx) => {
          const ex = exerciseBySlotId.get(slotId)
          ex.group_type = 'circuit'
          ex.group_id = groupId
          ex.group_label = String(idx + 1)
        })
      }
    }

    // Superset group_label — always exactly push then pull (guaranteed by
    // buildDaySkeletons), so a fixed A/B rather than the general loop above.
    for (const slot of skeleton.slots) {
      const ex = exerciseBySlotId.get(slot.slot_id)
      if (ex.group_type === 'superset') ex.group_label = slot.quotaSlot === 'upper_push' ? 'A' : 'B'
    }

    // Reorder so exercises sharing a group_id sit adjacent to each other. Required
    // for the shared client display util (client/src/utils/workoutGrouping.js
    // buildGroups) to recognize them as one group — it only merges CONSECUTIVE
    // same-group_id rows, and the day template's fixed slot order (squat -> push
    // -> hinge -> pull -> core -> bonus) otherwise interleaves a superset's push+pull
    // (or an AI circuit's members) with unrelated slots between them. A stable sort
    // keyed by each group's first-appearance index preserves the original quota
    // order for standalone exercises and pulls each group together at the position
    // of its earliest member. Safe with respect to the squat/hinge non-adjacency
    // rule: squat is always slot index 0 (the global minimum), so it's always first
    // regardless of grouping, and the lower-body rejection above guarantees no group
    // ever contains both squat and hinge — see workoutGenerator.test.js if this
    // invariant ever needs re-verifying after a BASE_QUOTA change.
    const firstIndexByGroupKey = new Map()
    quotaExercises.forEach((ex, idx) => {
      const key = ex.group_id ?? `__solo_${idx}`
      if (!firstIndexByGroupKey.has(key)) firstIndexByGroupKey.set(key, idx)
    })
    const orderedQuotaExercises = quotaExercises
      .map((ex, idx) => ({ ex, idx, key: ex.group_id ?? `__solo_${idx}` }))
      .sort((a, b) => {
        const rank = firstIndexByGroupKey.get(a.key) - firstIndexByGroupKey.get(b.key)
        return rank !== 0 ? rank : a.idx - b.idx
      })
      .map(e => e.ex)

    const exercises = []
    if (aiDay.warmup) {
      exercises.push({
        name: 'Warm-Up', sets: 1, reps: aiDay.warmup.duration ?? '5 minutes', rest_seconds: null,
        notes: aiDay.warmup.exercises ?? aiDay.warmup.notes ?? null, exercise_id: null, movement_pattern: null,
        section_name: 'Warm-Up', group_id: null, group_type: 'exercise', group_label: null,
      })
    }
    exercises.push(...orderedQuotaExercises)
    if (aiDay.cooldown) {
      exercises.push({
        name: 'Cool-Down', sets: 1, reps: aiDay.cooldown.reps ?? '5 minutes', rest_seconds: null,
        notes: aiDay.cooldown.notes ?? null, exercise_id: null, movement_pattern: null,
        section_name: 'Cool Down', group_id: null, group_type: 'exercise', group_label: null,
      })
    }

    return {
      // Always sequential — day naming is positional, not a creative/AI-generated label.
      day_name: `Day ${i + 1}`,
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

// ── Response parsing ─────────────────────────────────────────────────────────
// Claude occasionally substitutes fullwidth/CJK punctuation for the ASCII
// characters JSON syntax requires (observed: U+FF0C fullwidth comma in place
// of ','). These look visually near-identical to their ASCII counterparts but
// break JSON.parse. Sanitize known substitutes before parsing, and retry the
// API call once if parsing still fails afterward.

export class WorkoutGenerationParseError extends Error {
  constructor(message, originalError) {
    super(message)
    this.name = 'WorkoutGenerationParseError'
    this.status = 502
    this.originalError = originalError
  }
}

const UNICODE_PUNCTUATION_MAP = {
  '，': ',', // fullwidth comma
  '：': ':', // fullwidth colon
  '＂': '"', // fullwidth quotation mark
}

/** Replaces known problematic Unicode punctuation substitutes with their ASCII
 * equivalents, on a copy of `text` — never mutates the input. Logs (via
 * console.warn) which character was substituted and how many times, so a
 * malformed-but-recovered response is never silently rewritten. */
export function sanitizeJsonText(text) {
  let sanitized = text
  for (const [bad, good] of Object.entries(UNICODE_PUNCTUATION_MAP)) {
    if (!sanitized.includes(bad)) continue
    const count = sanitized.split(bad).length - 1
    const codePoint = `U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    console.warn(`[workoutGenerator] Sanitized ${count} occurrence(s) of ${codePoint} (${JSON.stringify(bad)}) -> ${JSON.stringify(good)} in Claude's workout response before JSON.parse`)
    sanitized = sanitized.split(bad).join(good)
  }
  return sanitized
}

/**
 * Best-effort repair of literal control characters and stray internal quotes
 * inside JSON string values. Claude occasionally emits a raw newline/tab, or
 * an unescaped `"` inside a description string — both invalid JSON, and both
 * distinct from the Unicode-punctuation issue sanitizeJsonText() handles.
 * Walks the text tracking whether we're inside a string (an unescaped `"`
 * toggles it) and repairs in place; never touches structural characters
 * outside strings, and leaves already-escaped sequences (\n, \", \\, etc.)
 * untouched. */
function escapeControlCharsInStrings(text) {
  let result = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inString) {
      if (ch === '"') inString = true
      result += ch
      continue
    }
    if (ch === '\\') {
      // Preserve existing escape sequences untouched (\n, \", \\, etc.)
      result += ch + (text[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      // Look ahead past whitespace for the character that would legally
      // follow a string terminator in JSON. If it's not one of those, this
      // quote is very likely an unescaped quote inside the string content
      // rather than the closing quote — escape it instead of ending the string.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const next = text[j]
      const legalAfterString = next === undefined || ',:}]'.includes(next)
      if (legalAfterString) {
        inString = false
        result += ch
      } else {
        result += '\\"'
      }
      continue
    }
    if (ch === '\n') { result += '\\n'; continue }
    if (ch === '\r') { result += '\\r'; continue }
    if (ch === '\t') { result += '\\t'; continue }
    result += ch
  }
  return result
}

/** Tracks bracket/brace/string state through `text` and returns the stack of
 * still-open `{`/`[` characters at the end (innermost last). */
function openBracketStack(text) {
  const stack = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return stack
}

/** Last-resort repair for a response truncated mid-JSON (e.g. cut off by the
 * token limit before the closing braces). Finds the last point where the
 * text holds a complete value (a closing `}`/`]` or a `,` outside a string),
 * truncates there, drops a dangling trailing comma, and appends exactly the
 * closing characters needed to balance every still-open object/array.
 * Returns null if there's nothing usable to repair. */
function repairTruncatedJson(text) {
  let inString = false
  let lastSafeIndex = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '}' || ch === ']' || ch === ',') lastSafeIndex = i
  }
  if (lastSafeIndex === -1) return null

  let truncated = text.slice(0, lastSafeIndex + 1).replace(/,\s*$/, '')
  const stillOpen = openBracketStack(truncated)
  if (stillOpen.length === 0) return null // already balanced — nothing for this repair to fix

  const closing = stillOpen.reverse().map(c => (c === '{' ? '}' : ']')).join('')
  return truncated + closing
}

function extractJsonText(rawText) {
  let text = rawText.trim()

  // Strip a leading ```json or ``` fence (with or without a trailing newline)
  // and a trailing ``` fence, independently — handles both matched pairs and
  // a fence on only one side.
  text = text.replace(/^```(?:json)?\s*\n?/, '')
  text = text.replace(/\n?```\s*$/, '')
  text = text.trim()

  // Defense in depth: if any leading/trailing prose slipped through (or the
  // fence regex above didn't match, e.g. inconsistent fencing), narrow to the
  // first { through the last } — the JSON object itself.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1)
  }

  return text
}

async function requestPlanFromClaude(prompt) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  return message.content[0].text
}

/** Requests a plan from Claude and parses it, sanitizing known Unicode
 * punctuation issues first. Retries the API call once (same prompt) if
 * parsing still fails after sanitization; throws WorkoutGenerationParseError
 * if the retry also fails to parse, rather than crashing with a raw
 * JSON.parse exception or returning a partial/broken result. */
async function requestAndParsePlan(prompt) {
  let lastErr
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rawText = await requestPlanFromClaude(prompt)
    const jsonText = escapeControlCharsInStrings(sanitizeJsonText(extractJsonText(rawText)))
    try {
      return JSON.parse(jsonText)
    } catch (err) {
      const repaired = repairTruncatedJson(jsonText)
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired)
          console.warn(`[workoutGenerator] Repaired a malformed/truncated workout JSON response on attempt ${attempt}/2 by closing structure early at the last complete value (original error: ${err.message})`)
          return parsed
        } catch {
          // Repair attempt itself didn't parse — fall through with the original error.
        }
      }
      lastErr = err
      console.warn(`[workoutGenerator] Failed to parse Claude's workout response on attempt ${attempt}/2: ${err.message}`)
    }
  }
  throw new WorkoutGenerationParseError(
    `Failed to parse workout plan JSON after sanitization and retry: ${lastErr.message}`,
    lastErr,
  )
}

// ── Validator 1: Push/pull ratio ─────────────────────────────────────────────
// Counts upper_push vs upper_pull slots across the full week.
// Rejects if push > pull at the weekly level.
function validatePushPullRatio(daysPerWeek, sessionLength) {
  let pushCount = 0
  let pullCount = 0
  for (let d = 0; d < daysPerWeek; d++) {
    const quota = buildDayQuota(d, sessionLength)
    for (const slot of quota) {
      if (slot === 'upper_push') pushCount++
      if (slot === 'upper_pull') pullCount++
    }
  }
  if (pushCount > pullCount) {
    throw new Error(
      `Push/pull imbalance: ${pushCount} push slots vs ${pullCount} pull slots across the week. Pull must equal or exceed push. Adjust buildDayQuota or session length.`
    )
  }
  console.log(`[workoutGenerator] Push/pull check passed: ${pushCount} push / ${pullCount} pull`)
}

// ── Validator 2: Circuit and superset count ───────────────────────────────────
// "some" means exactly 1 per workout day. "none" means 0. "full" means as many as fit.
// This validator logs the selections so they are explicit in server logs.
// Actual enforcement of count is in the Katie prompt (Part 3).
function validateCircuitSuperset(answers) {
  const valid = ['none', 'some', 'full']
  if (!valid.includes(answers.supersets)) {
    throw new Error(`Invalid supersets value: "${answers.supersets}". Must be one of: none, some, full.`)
  }
  if (!valid.includes(answers.circuits)) {
    throw new Error(`Invalid circuits value: "${answers.circuits}". Must be one of: none, some, full.`)
  }
  console.log(`[workoutGenerator] Structure: supersets=${answers.supersets} circuits=${answers.circuits}`)
}

// ── Validator 3: Beginner exercise block list ─────────────────────────────────
// These exercise names are blocked for beginner clients at the prompt level.
// The validator logs a warning so coaches can see when a block was triggered.
const BEGINNER_BLOCKED_EXERCISES = [
  'dip', 'bench dip', 'ring dip',
  'clean', 'power clean', 'hang clean', 'clean and press',
  'kettlebell swing', 'single-leg kettlebell swing', 'vertical swing',
  // Ballistic hinge/pull — same category as the swings above ("Never: kettlebell
  // swings, hang cleans, or any ballistic hinge pattern" in BEGINNER EXERCISE
  // PROGRESSIONS), but previously unnamed here, so 'Kettlebell Sumo High Pull'
  // stayed selectable for a beginner via the pull-slot fallback ladder.
  'high pull',
  'russian twist',
  'sit-up', 'full sit-up',
  'box jump', 'depth jump',
  'chin-up', 'chin up', // requires significant pulling strength not yet built
  'pull-up', 'pullup', // requires significant pulling strength not yet built
  'natural glute ham raise', 'glute ham raise', // advanced posterior chain, inappropriate for beginners
  'plyo push-up', 'plyometric push-up', 'clap push-up', // floor plyometrics for beginners
  'rocket jump', // high impact plyometric
  'standing long jump', // high impact plyometric
]

const INTERMEDIATE_BLOCKED_EXERCISES = [
  'natural glute ham raise', 'glute ham raise', // requires advanced posterior chain strength; assisted or band-assisted version preferred
  'chin-up', 'chin up', // intermediate clients should use assisted or band-assisted version only — flag with coach note rather than block if assisted variation exists
  'wide-grip pulldown behind the neck', 'behind the neck', // shoulder injury risk even for intermediate clients
  'kettlebell clean', 'one-arm clean', 'open palm clean', 'clean', // power clean already globally blocked; this catches remaining clean variations
  'ring dip', // rings require significant stabilization strength beyond intermediate
  'muscle up', // extreme advanced
  'single-arm push-up', 'one-arm push-up', // extreme advanced
  'plate twist', // rotational loaded core — same risk as Russian Twist
  'windmill', // advanced kettlebell skill
  '3/4 sit-up', 'three quarter sit-up', // sit-ups blocked for beginners, extended to intermediate
  'decline crunch', 'decline sit-up',
  'kettlebell swing', 'one-arm kettlebell swing', 'single arm swing', // ballistic power movement requiring established hip hinge mechanics
  'high pull', // ballistic hinge-to-pull, same category as the swings above
  'clock push-up', 'clock pushup', // advanced multi-plane variation
  'lunge sprint', // plyometric lunge pattern
  'rope climb', // requires specialized equipment and extreme pulling strength
  'pistol squat', 'smith machine pistol', // single leg to full depth, advanced
  'turkish get-up', 'turkish getup', 'get-up', // extreme advanced multi-pattern skill movement
  'frog sit-up', 'frog situp',
  'weighted sit-up', 'banded sit-up', 'sit-up', // sit-ups blocked for beginners, extended to intermediate
]

function getBeginnnerBlockList(fitnessLevel) {
  if (FITNESS_LEVEL_MAP[fitnessLevel] !== 'beginner') return []
  return BEGINNER_BLOCKED_EXERCISES
}

function getIntermediateBlockList(fitnessLevel) {
  if (FITNESS_LEVEL_MAP[fitnessLevel] !== 'intermediate') return []
  return INTERMEDIATE_BLOCKED_EXERCISES
}

// ── Validator 4: Floor transfer exercise filter ───────────────────────────────
// If floor_transfer is unable or restricted, warn Katie in the prompt
// and flag it so exercise instructions avoid floor cues.
function getFloorTransferContext(floorTransfer) {
  if (floorTransfer === 'unable' || floorTransfer === 'restricted') {
    return 'CLIENT CANNOT GET ON THE FLOOR. Do not write warmup, exercise, or cooldown cues that require lying down, getting on hands and knees, or floor-based positions. Substitute seated or standing alternatives in all coaching notes.'
  }
  if (floorTransfer === 'needs_support') {
    return 'Client needs support to get up and down from the floor. Note this in any coaching cues for floor-based exercises — suggest using a chair or wall for assistance.'
  }
  return null
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
  const hasBench      = resolveHasBench(answers.equipment)
  const difficulty    = FITNESS_LEVEL_MAP[answers.fitness_level] ?? null
  const preferBilateral = shouldPreferBilateral({
    injuries: answers.injuries,
    healthAssessmentInjuries: opts.healthAssessmentInjuries,
    forceBilateral: opts.forceBilateral,
    fitnessLevel: answers.fitness_level,
    floorTransfer: answers.floor_transfer,
  })

  validatePushPullRatio(answers.days_per_week, answers.session_length)
  validateCircuitSuperset(answers)
  const beginnerBlockList = getBeginnnerBlockList(answers.fitness_level)
  const floorTransferContext = getFloorTransferContext(answers.floor_transfer)
  const isBeginner = (FITNESS_LEVEL_MAP[answers.fitness_level] ?? answers.fitness_level) === 'beginner'
  const injuryFlags = getInjuryFlags(answers.injuries, opts.healthAssessmentInjuries)
  const blockedNamePattern = buildBlockedNamePattern({ isBeginner, injuryFlags, equipmentList, fitnessLevel: answers.fitness_level })
  // Identical exclusions minus the fitness-level-gated name lists. Used by exactly
  // one path — tier 2 of the pull-slot fallback ladder (see fillPullSlot) — and never
  // for normal selection or for the post-generation validator, which keeps checking
  // against the full blockedNamePattern above.
  const levelRelaxedBlockedNamePattern = buildBlockedNamePattern({
    isBeginner, injuryFlags, equipmentList, fitnessLevel: answers.fitness_level, omitFitnessLevelBlocks: true,
  })
  // 'some'/'full' both request supersets (validateCircuitSuperset above already
  // guarantees answers.supersets is one of 'none'/'some'/'full') — the push+pull
  // pairing is deterministic (buildDaySkeletons/forceZeroRest) and identical
  // either way. Katie's prompt is never told about superset structure at all
  // (see buildWorkoutPrompt) — 'some' vs 'full' no longer changes anything about
  // what she writes, only that the app pairs push+pull for either.
  const includeSuperset = answers.supersets !== 'none'
  // Circuits, unlike supersets, ARE proposed by the AI (via circuit_group in its
  // JSON response — see buildWorkoutPrompt/mergeResponse) since there's no
  // deterministic code-side circuit logic. includeCircuit gates mergeResponse's
  // circuit-bucketing pass so a "none" selection can never surface a circuit
  // regardless of what the model returns.
  const includeCircuit = answers.circuits !== 'none'

  const requiredPatterns = getRequiredPatterns(answers.days_per_week, answers.session_length, preferBilateral)
  await assertLibraryHasRequiredPatterns(pool, requiredPatterns)

  const daySkeletons = await buildDaySkeletons(pool, {
    daysPerWeek: answers.days_per_week,
    sessionLength: answers.session_length,
    equipmentList,
    hasBench,
    difficulty,
    preferBilateral,
    excludeNamePattern: blockedNamePattern,
    levelRelaxedExcludeNamePattern: levelRelaxedBlockedNamePattern,
    strictDifficulty: isBeginner,
    isBeginner,
    injuryFlags,
    includeSuperset,
    fitnessLevel: answers.fitness_level,
  })

  const prompt = buildWorkoutPrompt(firstName, answers, daySkeletons, beginnerBlockList, floorTransferContext, injuryFlags, opts.coachName ?? 'Katie')
  const aiPlan = await requestAndParsePlan(prompt)

  const plan = mergeResponse(daySkeletons, aiPlan, { includeCircuit })
  return validateWorkoutPlan(plan, { equipmentList, blockedNamePattern })
}
