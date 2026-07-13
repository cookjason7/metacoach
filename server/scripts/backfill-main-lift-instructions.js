/**
 * backfill-main-lift-instructions.js — fills exercise_library.instructions
 * for the 69 main_lift rows, none of which had a value (a prior seed pass
 * never set this field for that category — see match-legacy-exercise-media.js
 * era investigation: 59/249 populated overall, 0/69 in main_lift).
 *
 * *** These cues are AI-generated, standard strength-coaching form points —
 * NOT sourced from the Programming Guide or verified by a human coach. They
 * should be spot-checked before being trusted in front of real clients. ***
 *
 * Style matches the existing populated rows elsewhere in the table (short
 * phrase fragments, not full sentences — e.g. "band around wrists", "elbow
 * bent 90 degrees").
 *
 * Only touches rows with category = 'main_lift' AND instructions currently
 * NULL/blank — never overwrites an existing value. Idempotent (re-running
 * after these are set is a no-op, since it only targets blank rows).
 *
 * Usage:
 *   node server/scripts/backfill-main-lift-instructions.js
 */

import 'dotenv/config'
import { migrate, pool } from '../db.js'

// name -> instructions. Keyed by exact exercise_library.name.
const CUES = {
  'Barbell Back Squat': 'brace core, knees track over toes, chest up',
  'Front Squat': 'elbows high, bar on front delts, upright torso',
  'Goblet Squat': 'hold dumbbell at chest, elbows inside knees',
  'Bodyweight Squat': 'weight in heels, knees track over toes',
  'Split Squat': 'back heel lifted, front knee tracks over toe',
  'Pistol Squat Progression': 'control the descent, use support as needed',
  'Conventional Deadlift': 'hips back, flat back, bar close to shins',
  'Romanian Deadlift': 'soft knees, hinge at hips, bar close to legs',
  'Trap Bar Deadlift': 'neutral spine, drive through heels',
  'Single-Leg RDL': 'hinge at hip, back leg extends behind, chest up',
  'Glute Bridge': 'drive through heels, squeeze glutes at top',
  'Nordic Curl Regression': 'anchor ankles, lower slowly under control',
  'Barbell Bench Press': 'shoulder blades retracted, feet flat, bar to chest',
  'Dumbbell Bench Press': 'elbows at 45 degrees, controlled descent',
  'Push-up': 'hands under shoulders, body in straight line',
  'Barbell Row': 'hinge at hips, pull to lower ribs, flat back',
  'Dumbbell Row': 'flat back, pull elbow past torso',
  'Seated Cable Row': 'chest up, pull to sternum, squeeze shoulder blades',
  'Inverted Row': 'body straight, pull chest to bar',
  'Overhead Press': 'brace core, bar path close to face',
  'Dumbbell Shoulder Press': 'press straight overhead, avoid arching back',
  'Pull-up': 'full hang start, chin over bar, controlled descent',
  'Lat Pulldown': 'pull to upper chest, avoid leaning back excessively',
  "Farmer's Carry": 'shoulders back, tall posture, even steps',
  'Suitcase Carry': 'resist leaning, brace obliques against the load',
  'Turkish Get-up': 'eyes on the weight throughout, move slowly',
  'Kettlebell Clean and Press': 'close to body on the clean, press straight overhead',
  'Alternating Hang Clean': 'hips extend explosively, catch in front rack',
  'Barbell Full Squat': 'full depth, hips below knee crease, chest up',
  'Goblet squat': 'hold dumbbell at chest, elbows inside knees',
  'Barbell Lunge': 'front knee tracks over toe, torso upright',
  'DB Lunge': 'step through, front knee over ankle',
  'Barbell Shoulder Press': 'brace core, press bar in straight line',
  'DB Shoulder Press': 'press overhead, avoid excessive back arch',
  'Bent-Arm Barbell Pullover (Vertical Pull)': 'elbows bent, lower bar behind head, engage lats',
  'Bent-Arm Barbell Pullover (Vertical Push)': 'elbows bent, control bar overhead, engage chest',
  'Barbell Board Press': 'boards limit range, pause bar on boards',
  'DB chest press': 'elbows at 45 degrees, controlled descent',
  'BB chest press': 'shoulder blades retracted, bar to chest',
  'KB RDL': 'hinge at hips, kettlebell close to legs',
  'BB RDL': 'soft knees, hinge at hips, bar close to legs',
  'Double Kettlebell Push Press': 'dip and drive, press bells overhead',
  'Double Kettlebell Windmill': 'eyes on top bell, hinge at hips, straight bottom arm',
  'Dumbbell Lying One-Arm Rear Lateral Raise': 'lie on side, raise arm to shoulder height',
  'Dumbbell Rear Lunge': 'step back, front knee tracks over toe',
  'Elevated Back Lunge': 'rear foot elevated, front knee over ankle',
  "Farmer's Walk": 'shoulders back, tall posture, even steps',
  'Pull-ups/assisted': 'full hang start, chin over bar, controlled descent',
  'High Cable Curls': 'elbows high, curl hands toward ears',
  'db curls': 'elbows fixed at sides, controlled curl',
  'Incline Push-Up (Hands on Wall or Counter)': 'hands elevated, body in straight line',
  'Kettlebell Figure 8': 'pass bell between legs, stay low and braced',
  'Lying Triceps Press': 'elbows fixed, lower bar to forehead',
  'Modified Glute Bridge': 'drive through heels, squeeze glutes at top',
  'One-Arm Kettlebell Clean': 'close to body, catch in rack position',
  'One-Arm Kettlebell Floor Press': 'elbow at 45 degrees, press straight up',
  'One-Arm Kettlebell Swings': 'hinge at hips, hike bell back, snap hips forward',
  'One-Arm Open Palm Kettlebell Clean': 'close to body, relaxed grip on catch',
  'Power Clean from Blocks': 'hips extend explosively, catch in front rack',
  'Single Leg Glute Bridge': 'drive through the working heel, hips level',
  'Standing Hip Hinge (Bodyweight Good Morning)': 'soft knees, hinge at hips, flat back',
  'Standing Modified Squat (Feet Wide, Shallow Depth)': 'wide stance, shallow depth, knees track over toes',
  'Sumo Deadlift': 'wide stance, toes out, chest up',
  'Suspended Split Squat': 'rear foot in strap, front knee over ankle',
  'Two-Arm Kettlebell Clean': 'close to body, catch in rack position',
  'Two-Arm Kettlebell Row': 'hinge at hips, pull elbows past torso',
  'V-Bar Pulldown': 'pull to upper chest, squeeze shoulder blades',
  'Wall Sit': 'back flat against wall, knees at 90 degrees',
  'Yoke Walk': 'brace core, short controlled steps, stay tall',
}

async function run() {
  await migrate()

  const { rows } = await pool.query(
    `SELECT id, name, instructions FROM exercise_library WHERE category = 'main_lift' ORDER BY id`,
  )
  console.log(`main_lift rows: ${rows.length}`)

  let updated = 0
  let skippedAlreadySet = 0
  const noCue = []

  for (const row of rows) {
    if (row.instructions && row.instructions.trim()) {
      skippedAlreadySet++
      continue
    }
    const cue = CUES[row.name]
    if (!cue) {
      noCue.push(row.name)
      continue
    }
    await pool.query(`UPDATE exercise_library SET instructions = $1 WHERE id = $2`, [cue, row.id])
    updated++
  }

  console.log(`Updated: ${updated}`)
  console.log(`Skipped (already had a value): ${skippedAlreadySet}`)
  console.log(`No cue mapped (should be 0): ${noCue.length}`)
  if (noCue.length) console.log(noCue)

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM exercise_library WHERE category = 'main_lift' AND instructions IS NOT NULL AND trim(instructions) != ''`,
  )
  console.log(`main_lift rows now with instructions: ${countRows[0].count} / ${rows.length}`)

  await pool.end()
}

run().catch(err => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
