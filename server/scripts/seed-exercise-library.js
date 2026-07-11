/**
 * seed-exercise-library.js — seeds the `exercise_library` table from the
 * internal Programming Guide for Coaches (movement prep / activation / plyo /
 * core / finisher / stretch catalog). Schema + seed data only — no
 * assembly/generation logic (separate build).
 *
 * Usage:
 *   node server/scripts/seed-exercise-library.js
 *
 * Idempotent — safe to re-run. Upserts on (name, source_program).
 *
 * main_lift rows are intentionally NOT seeded here — see the report printed
 * at the end of the run for why.
 */

import 'dotenv/config'
import { migrate, pool } from '../db.js'

const BW = ['bodyweight']

// ── Foam Roll Program A ─────────────────────────────────────────────────────
const foamRollA = (name, opts = {}) => ({
  name, category: 'foam_roll', source_program: 'Foam Roll Program A',
  equipment: ['foam_roller'], ...opts,
})
const FOAM_ROLL_A = [
  foamRollA('Tennis ball feet', { equipment: ['tennis_ball'] }),
  foamRollA('Upper and mid-back — horizontal cross arms'),
  foamRollA('Glute cross-over'),
  foamRollA('Calves', { instructions: 'all angles = feet dorsi-flexed, plantar flexed, feet angled away from each other, then towards each other' }),
  foamRollA('Psoas'),
  foamRollA('Groin'),
  foamRollA('IT Band'),
  foamRollA('Quads'),
  foamRollA('Shins'),
]

// ── Foam Roll Program B ─────────────────────────────────────────────────────
const foamRollB = (name, opts = {}) => ({
  name, category: 'foam_roll', source_program: 'Foam Roll Program B',
  equipment: ['foam_roller'], ...opts,
})
const FOAM_ROLL_B = [
  foamRollB('Tennis ball feet', { equipment: ['tennis_ball'] }),
  foamRollB('Peanut ball scap thoracic', { instructions: '(or just one tennis ball)', equipment: ['tennis_ball'] }),
  foamRollB('T-spine extension over foam roller or tennis balls', { equipment: ['foam_roller', 'tennis_ball'] }),
  foamRollB('Tennis ball anterior shoulder, upper chest', { equipment: ['tennis_ball'] }),
  foamRollB('Upper and mid-back — vertical cross arms'),
  foamRollB('Lats — arm extended'),
  foamRollB('Straight-leg glute'),
  foamRollB('Groin'),
]

// ── Mobility ─────────────────────────────────────────────────────────────────
const mob = (name, opts = {}) => ({
  name, category: 'mobility', source_program: 'Mobility', equipment: BW, ...opts,
})
const MOBILITY = [
  mob('Neck Circles'),
  mob('Neck Forward and Backwards'),
  mob('Alternating Arm Hugs', { unilateral: true }),
  mob('Arm Circles'),
  mob('Shoulder Shrugs'),
  mob("Y's against wall"),
  mob('Wall Slides'),
  mob('Floor Slides'),
  mob('Quadruped 6 point Zenith'),
  mob('Quadruped T-spine Rotation', { instructions: 'elbow bent 90 degrees', unilateral: true }),
  mob('Scap Push-ups'),
  mob('Leg Lowers'),
  mob('Ankle Circles'),
  mob('Ankle Rocks'),
  mob('Gate-swings', { unilateral: true }),
  mob('Goodmornings'),
  mob('Staggered RDL', { unilateral: true }),
  mob('Quad Pulls', { unilateral: true }),
  mob('Knee Hugs', { unilateral: true }),
  mob('Leg Cradle (Figure 4)', { unilateral: true }),
  mob('½ Kneel Hip Flexor', { unilateral: true }),
  mob('½ Kneel Hip Flexor with Rainbow', { unilateral: true }),
  mob('Curtsey Squat', { unilateral: true }),
  mob('Cook Squat'),
  mob('Sumo Squat'),
  mob('Frankensteins', { unilateral: true }),
  mob("McGill's Airplane", { unilateral: true }),
  mob('Downward Dog'),
  mob('Hurdle Up and Over', { unilateral: true }),
  mob('Stick Bug', { unilateral: true }),
  mob('Spiderman', { unilateral: true }),
  mob('Butterfly Groin'),
  mob('Inchworm'),
  // Using PVC Stick
  mob('3 Points of Contact Stick Hinge', { equipment: ['pvc_stick'] }),
  mob('Overhead Squat', { equipment: ['pvc_stick'] }),
  mob('Windmills', { equipment: ['pvc_stick'], unilateral: true }),
]

// ── Lengthen (Dynamic) ───────────────────────────────────────────────────────
const len = (name, opts = {}) => ({
  name, category: 'lengthen', source_program: 'Lengthen (Dynamic)', equipment: BW, ...opts,
})
const LENGTHEN = [
  len('Walking Leg Pulls with Reach', { unilateral: true }),
  len('Walking Knee Hugs', { unilateral: true }),
  len('Walking Leg Cradle (Figure 4)', { unilateral: true }),
  len('Jumping Jacks'),
  len('Seal Jacks'),
  len('Figure 4 Skip', { unilateral: true, plane: 'linear' }),
  len('High Knee Skip', { unilateral: true, plane: 'linear' }),
  len('Lateral Skip', { unilateral: true, plane: 'lateral' }),
  len('Cross-Over Skip', { unilateral: true, plane: 'lateral' }),
  len('Power Skips', { unilateral: true, plane: 'linear' }),
  len('High Knee Run', { plane: 'linear' }),
  len('Hopping Hurdle Up and Over', { unilateral: true, plane: 'linear' }),
  len('Scissor Jumps', { unilateral: true }),
  len('Reverse Lunge with Hamstring Stretch', { unilateral: true }),
  len('Single Leg RDL with 2 Arm Reach', { unilateral: true }),
  len('Lateral Shuffle', { plane: 'lateral' }),
  len('Carioca', { plane: 'lateral' }),
  len('Lateral Crawl', { instructions: 'Start in push-up position', plane: 'lateral' }),
]

// ── Combo Mobility Exercises ─────────────────────────────────────────────────
const combo = (name, opts = {}) => ({
  name, category: 'combo_mobility', source_program: 'Combo Mobility', equipment: BW, ...opts,
})
const COMBO_MOBILITY = [
  combo('Stoney Stretch on TRX', { instructions: 'helps hip flexors and anterior shoulder/chest', equipment: ['trx'] }),
  combo('Down dog to Spiderman to T-spine rotation', { unilateral: true }),
  combo('Knee Hug to Spiderman to Hamstring Stretch', { unilateral: true }),
  combo('Walking Lunge with T-spine Rotation', { unilateral: true }),
  combo('Reverse Lunge to Hamstring Stretch', { unilateral: true }),
  combo('Lateral over with high knee grab to lunge', { instructions: 'Using hurdles', unilateral: true, plane: 'lateral' }),
  combo('Backwards over same leg with lunge, tuck/hamstring', { instructions: 'Using hurdles', unilateral: true }),
  combo('Forward over alternate with RDL walk', { instructions: 'Using hurdles', unilateral: true }),
  combo('Lateral over under with cross behind lunge', { instructions: 'Using hurdles', unilateral: true, plane: 'lateral' }),
]

// ── Activate (Bodyweight) ────────────────────────────────────────────────────
const act = (name, opts = {}) => ({
  name, category: 'activation', source_program: 'Bodyweight Activate',
  equipment: BW, instructions: 'hold for 10-15 seconds', ...opts,
})
const ACTIVATION = [
  act('Squat'),
  act('Forward lunge', { unilateral: true }),
  act('Backward lunge', { unilateral: true }),
  act('Lateral lunge', { unilateral: true, plane: 'lateral' }),
  act('Glute bridge'),
  act('Cook hip-lift', { unilateral: true }),
  act('Push-up hold at bottom'),
  act('Push-up hip flexor hold'),
]

// ── Mini Band Circuit A / B ──────────────────────────────────────────────────
const miniA = (name, opts = {}) => ({
  name, category: 'mini_band', source_program: 'Mini Band Circuit A', equipment: ['mini_band'], ...opts,
})
const miniB = (name, opts = {}) => ({
  name, category: 'mini_band', source_program: 'Mini Band Circuit B', equipment: ['mini_band'], ...opts,
})
const MINI_BAND = [
  miniA('Straight leg box walks', { instructions: 'band around ankles or just above knees' }),
  miniA('Straight leg abduction', { instructions: 'band around ankles', unilateral: true }),
  miniA('Squat with abduction', { instructions: 'band just above knees' }),
  miniA('Wide march', { instructions: 'band around feet' }),
  miniA('Clams', { instructions: 'band just above knees', unilateral: true }),
  miniA('Scap pull-aparts', { instructions: 'hold band with hands' }),

  miniB('Squat position box walks', { instructions: 'band around ankles' }),
  miniB('Spiderman', { instructions: 'band around feet', unilateral: true }),
  miniB('Fire Hydrants', { instructions: 'band just above knees', unilateral: true }),
  miniB('Lying side glute extension', { instructions: 'band around feet', unilateral: true }),
  miniB('Supine hip flexor', { instructions: 'band around feet', unilateral: true }),
  miniB('Scap hand-cuffs', { instructions: 'band around wrists' }),
]

// ── Big Band Circuit A / B ───────────────────────────────────────────────────
const bigA = (name, opts = {}) => ({
  name, category: 'big_band', source_program: 'Big Band Circuit A', equipment: ['big_band'], ...opts,
})
const bigB = (name, opts = {}) => ({
  name, category: 'big_band', source_program: 'Big Band Circuit B', equipment: ['big_band'], ...opts,
})
const BIG_BAND = [
  bigA('Lateral shuffle', { instructions: 'band under feet and over shoulders', plane: 'lateral' }),
  bigA('Lateral cross walk', { instructions: 'band under feet, make X hold with neutral grip, elbows at 90', plane: 'lateral' }),
  bigA('Squat with abduction', { instructions: 'band around knees, one above, one below' }),
  bigA('Standing bent over row', { instructions: 'band under feet, hold with hands' }),
  bigA('Supine pull-aparts', { instructions: 'hold band with supine grip, arms straight at chest height' }),

  bigB('Goodmornings', { instructions: 'band under feet and around shoulders' }),
  bigB('Cross walk forwards and backwards', { instructions: 'band under feet, make X hold with neutral grip, elbows 90', plane: 'lateral' }),
  bigB('Lateral shuffle', { instructions: 'band around knees, one above, one below', plane: 'lateral' }),
  bigB('Bridge with abduction', { instructions: 'band around knees, one above, one below' }),
  bigB('Seated scap retraction', { instructions: 'sit with legs straight, band around feet & hold with neutral grip' }),
  bigB('45 degree pull-aparts', { instructions: 'hold band with prone hand grip' }),
]

// ── Plyo Levels 1-4 ───────────────────────────────────────────────────────────
const plyo = (name, level, opts = {}) => ({
  name, category: 'plyo', source_program: `Level ${level} Plyo`, plyo_level: level,
  level_min: level === 1 ? 'beginner' : level === 2 ? 'intermediate' : 'advanced',
  equipment: BW, ...opts,
})
const PLYO = [
  plyo('Box jump', 1, { instructions: '(4–24 inches in height) find appropriate height for client based on above, jump up onto box and step down', plyo_type: 'jump', plane: 'linear' }),
  plyo('Single leg box hop', 1, { instructions: 'start with 4 inch box (aerobic step is good), if client has knee issues start on ground', plyo_type: 'hop', unilateral: true, plane: 'linear' }),
  plyo('Single leg lateral box hop', 1, { instructions: '4 to 6 inches', plyo_type: 'hop', unilateral: true, plane: 'lateral' }),
  plyo('Lateral bound and stick', 1, { plyo_type: 'bound', unilateral: true, plane: 'lateral' }),

  plyo('Hurdle jump and stick', 2, { instructions: '(12–30 inches in height)', plyo_type: 'jump', plane: 'linear' }),
  plyo('Single leg hurdle jump and stick', 2, { plyo_type: 'jump', unilateral: true, plane: 'linear' }),
  plyo('Single leg lateral hurdle hop and stick', 2, { plyo_type: 'hop', unilateral: true, plane: 'lateral' }),
  plyo('45 degree bound and stick', 2, { plyo_type: 'bound', unilateral: true, plane: 'lateral' }),

  plyo('Double leg box jump', 3, { instructions: 'now jumping onto and off box', plyo_type: 'jump', plane: 'linear' }),
  plyo('Hurdle jump with bounce', 3, { instructions: 'bounce between each hurdle vs sticking landing', plyo_type: 'jump', plane: 'linear' }),
  plyo('Single leg hurdle hop with bounce', 3, { plyo_type: 'hop', unilateral: true, plane: 'linear' }),
  plyo('Single leg lateral hurdle hop with bounce', 3, { plyo_type: 'hop', unilateral: true, plane: 'lateral' }),
  plyo('45 degree bound with bounce', 3, { plyo_type: 'bound', unilateral: true, plane: 'lateral' }),

  plyo('Hurdle jumps continuous', 4, { plyo_type: 'jump', plane: 'linear' }),
  plyo('Single leg hurdle hops continuous', 4, { plyo_type: 'hop', unilateral: true, plane: 'linear' }),
  plyo('Single leg lateral hurdle hops continuous', 4, { plyo_type: 'hop', unilateral: true, plane: 'lateral' }),
  plyo('45 degree lateral bound continuous', 4, { plyo_type: 'bound', unilateral: true, plane: 'lateral' }),
  plyo('Power skip', 4, { plyo_type: 'skip', unilateral: true, plane: 'linear' }),
]

// ── Power/Plyo — Medicine Ball list ──────────────────────────────────────────
const medBall = (name, opts = {}) => ({
  name, category: 'plyo', source_program: 'Power/Plyo — Medicine Ball', equipment: ['medicine_ball'], ...opts,
})
const MEDICINE_BALL = [
  medBall('Side throws with pivot'),
  medBall('Side throws with pivot and step'),
  medBall('Front twist throw'),
  medBall('Single leg front twist throw', { unilateral: true }),
  medBall('Overhead throw to wall with step'),
  medBall('Overhead floor slam'),
  medBall('Tall kneel chest throw'),
  medBall('Chest throw with hop'),
  medBall('Rotational slams'),
  medBall('Windmills'),
]

// ── Core ─────────────────────────────────────────────────────────────────────
const coreEx = (name, subtype, program, opts = {}) => ({
  name, category: 'core', core_subtype: subtype, source_program: program, equipment: BW, ...opts,
})
const CORE = [
  coreEx('Elbow plank', 'anti_extension', 'Core — Anti-Extension', { instructions: 'regression is to elevate the plank vs putting someone on their knees' }),
  coreEx('Stability ball roll out', 'anti_extension', 'Core — Anti-Extension'),
  coreEx('Body saw with feet on valslide', 'anti_extension', 'Core — Anti-Extension'),
  coreEx('Ab wheel roll out', 'anti_extension', 'Core — Anti-Extension'),
  coreEx('Valslide or slide board roll out', 'anti_extension', 'Core — Anti-Extension'),

  coreEx('Plank reach', 'anti_rotation', 'Core — Anti-Rotation'),
  coreEx('Clock plank', 'anti_rotation', 'Core — Anti-Rotation'),
  coreEx('Bird dog', 'anti_rotation', 'Core — Anti-Rotation'),
  coreEx('Plank row', 'anti_rotation', 'Core — Anti-Rotation', { instructions: 'i.e. renegade row' }),
  coreEx('Plank with leg abduction', 'anti_rotation', 'Core — Anti-Rotation', { unilateral: true }),

  coreEx('Side plank with row', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { unilateral: true }),
  coreEx('Suitcase carry', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { unilateral: true }),
  coreEx("Farmer's Walk", 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion'),
  coreEx('½ Kneel Chops', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { instructions: 'with ball or cable', equipment: ['medicine_ball', 'cable'], unilateral: true }),
  coreEx('Lunge Position Chops', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { instructions: 'with ball or cable', equipment: ['medicine_ball', 'cable'], unilateral: true }),
  coreEx('½ Kneel Lifts', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { instructions: 'with cable', equipment: ['cable'], unilateral: true }),
  coreEx('Lunge Position Lift', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { instructions: 'with cable', equipment: ['cable'], unilateral: true }),
  coreEx('Step up Lifts', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { instructions: 'with cable', equipment: ['cable'], unilateral: true }),
  coreEx('Standing Traverse Chop', 'anti_lateral_flexion', 'Core — Anti-Lateral Flexion', { instructions: 'with cable (baseball swing)', equipment: ['cable'] }),
]

// ── Finishers ─────────────────────────────────────────────────────────────────
const fin = (name, opts = {}) => ({
  name, category: 'finisher', source_program: 'Finishers', equipment: BW, ...opts,
})
const FINISHERS = [
  fin('100 Reps', { instructions: 'of anything (like OH slams, KB swings, squat jumps etc.) as fast as they can, rest when/if needed' }),
  fin('Intervals', { instructions: '(treadmill, bike, rower)' }),
  fin('Sled Work'),
  fin('10 Rep Ladder', { instructions: 'pick 2 opposing exercises and do 10 reps each then 9, 8, 7…1' }),
  fin('Mirror Dodge', { instructions: 'lateral shuffle back and forth following partner', plane: 'lateral' }),
  fin('Suicides'),
  fin('Obstacle Course'),
  fin('Tabata'),
  fin('4 Cone Drill', { instructions: 'sprint to # cone coach calls out and back peddle back' }),
]

// ── Stretching/Recovery — key muscles ────────────────────────────────────────
const stretch = (name, opts = {}) => ({
  name, category: 'stretch', source_program: 'Stretching/Recovery — Key Muscles', equipment: BW, ...opts,
})
const STRETCH = [
  stretch('Pectorals'),
  stretch('Biceps', { unilateral: true }),
  stretch('Hip flexors', { unilateral: true }),
  stretch('Hamstrings', { unilateral: true }),
  stretch('Upper trapezius', { unilateral: true }),
  stretch('Psoas', { unilateral: true }),
  stretch('Piriformis', { unilateral: true }),
  stretch('Calf muscles', { unilateral: true }),
]

const ALL = [
  ...FOAM_ROLL_A, ...FOAM_ROLL_B, ...MOBILITY, ...LENGTHEN, ...COMBO_MOBILITY,
  ...ACTIVATION, ...MINI_BAND, ...BIG_BAND, ...PLYO, ...MEDICINE_BALL, ...CORE,
  ...FINISHERS, ...STRETCH,
]

function normalize(e) {
  return {
    name: e.name,
    category: e.category,
    movement_pattern: null,
    core_subtype: e.core_subtype ?? null,
    plyo_level: e.plyo_level ?? null,
    plyo_type: e.plyo_type ?? null,
    equipment_required: e.equipment ?? [],
    level_min: e.level_min ?? 'beginner',
    unilateral: e.unilateral ?? false,
    plane: e.plane ?? null,
    instructions: e.instructions ?? null,
    source_program: e.source_program,
  }
}

// ── main_lift check ──────────────────────────────────────────────────────────
// The guide names the 8 movement patterns (hinge, squat, vertical_push,
// vertical_pull, horizontal_push, horizontal_pull, lift, carry) but gives no
// actual lift exercise names. Per instructions, check workout_exercises for
// existing data that maps cleanly before skipping.
async function checkMainLifts() {
  const { rows } = await pool.query('SELECT DISTINCT exercise_name FROM workout_exercises ORDER BY 1')
  console.log(`\n[main_lift check] workout_exercises has ${rows.length} distinct free-text exercise_name values, with no movement_pattern column.`)
  console.log('[main_lift check] Some names are individually recognizable (e.g. "Barbell Full Squat" -> squat, '
    + '"Farmer\'s Walk"/"Yoke Walk" -> carry, "Sumo Deadlift with Chains" -> hinge), but the set as a whole mixes '
    + 'main lifts with warm-ups, cooldowns, stretches, and mobility drills, and gives no way to distinguish '
    + 'vertical vs. horizontal push/pull, or identify a "lift" (e.g. Turkish get-up-style) pattern, without guessing.')
  console.log('[main_lift check] Skipping main_lift seeding — mapping is not clean across all 8 patterns.')
}

async function run() {
  await migrate()
  await checkMainLifts()

  const mapped = ALL.map(normalize)

  const distribution = mapped.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1
    return acc
  }, {})
  console.log('\nCategory distribution:', JSON.stringify(distribution, null, 2))
  console.log('Total rows to seed:', mapped.length)

  let inserted = 0
  let updated = 0
  for (const e of mapped) {
    const { rows } = await pool.query(
      `INSERT INTO exercise_library
         (name, category, movement_pattern, core_subtype, plyo_level, plyo_type,
          equipment_required, level_min, unilateral, plane, instructions, source_program)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (name, source_program) DO UPDATE SET
         category           = EXCLUDED.category,
         movement_pattern    = EXCLUDED.movement_pattern,
         core_subtype        = EXCLUDED.core_subtype,
         plyo_level          = EXCLUDED.plyo_level,
         plyo_type           = EXCLUDED.plyo_type,
         equipment_required  = EXCLUDED.equipment_required,
         level_min           = EXCLUDED.level_min,
         unilateral          = EXCLUDED.unilateral,
         plane               = EXCLUDED.plane,
         instructions        = EXCLUDED.instructions
       RETURNING (xmax = 0) AS inserted`,
      [e.name, e.category, e.movement_pattern, e.core_subtype, e.plyo_level, e.plyo_type,
       e.equipment_required, e.level_min, e.unilateral, e.plane, e.instructions, e.source_program],
    )
    if (rows[0].inserted) inserted++
    else updated++
  }

  console.log(`\nDone — ${inserted} inserted, ${updated} updated, ${mapped.length} total.`)

  const byCat = await pool.query(
    `SELECT category, COUNT(*) FROM exercise_library GROUP BY category ORDER BY category`,
  )
  console.log('exercise_library row counts by category:', JSON.stringify(byCat.rows))

  await pool.end()
}

run().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
