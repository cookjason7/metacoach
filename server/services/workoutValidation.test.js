import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkoutPlan } from './workoutValidation.js'

function samplePlan() {
  return {
    program_name: 'Test Program',
    description: '',
    days: [
      {
        day_name: 'Day 1',
        focus: 'Squat • Upper Push • Hinge • Upper Pull • Core',
        exercises: [
          { name: 'Warm-Up', movement_pattern: null, equipment: null },
          { name: 'Goblet Squat', movement_pattern: 'squat_bilateral', equipment: 'dumbbell' },
          { name: 'Incline Push-Up', movement_pattern: 'upper_push', equipment: 'body only' },
          { name: 'Glute Bridge', movement_pattern: 'hinge_bilateral', equipment: 'body only' },
          { name: 'Band Pull-Apart', movement_pattern: 'upper_pull', equipment: 'bands' },
          { name: 'Dead Bug', movement_pattern: 'core', equipment: 'body only' },
          { name: 'Cool-Down', movement_pattern: null, equipment: null },
        ],
      },
    ],
  }
}

test('validateWorkoutPlan leaves a well-formed plan untouched', () => {
  const plan = samplePlan()
  const result = validateWorkoutPlan(plan, { equipmentList: ['dumbbell', 'body only', 'bands'], blockedNamePattern: 'russian twist' })
  assert.equal(result.days[0].sequence_warning, undefined)
  for (const ex of result.days[0].exercises) assert.equal(ex.flagged, undefined)
})

test('validateWorkoutPlan flags an exercise using equipment outside the client list', () => {
  const plan = samplePlan()
  // Client only has bodyweight + bands — the dumbbell squat should be flagged.
  const result = validateWorkoutPlan(plan, { equipmentList: ['body only', 'bands'], blockedNamePattern: null })
  const squat = result.days[0].exercises.find(ex => ex.flag_reason === 'equipment_mismatch')
  assert.ok(squat, 'expected an equipment_mismatch flag')
  assert.match(squat.name, /^\[EQUIPMENT MISMATCH/)
})

test('validateWorkoutPlan flags a blocked exercise name and replaces it', () => {
  const plan = samplePlan()
  plan.days[0].exercises[4].name = 'Russian Twist' // upper_pull slot, sabotaged
  const result = validateWorkoutPlan(plan, { equipmentList: null, blockedNamePattern: 'russian twist' })
  const flagged = result.days[0].exercises[4]
  assert.equal(flagged.flag_reason, 'blocked_exercise')
  assert.match(flagged.name, /^\[BLOCKED EXERCISE/)
})

test('validateWorkoutPlan flags two adjacent lower-body pattern exercises', () => {
  const plan = samplePlan()
  // Remove the push exercise so squat and hinge become adjacent.
  plan.days[0].exercises.splice(2, 1)
  const result = validateWorkoutPlan(plan, { equipmentList: null, blockedNamePattern: null })
  assert.match(result.days[0].sequence_warning, /^\[SEQUENCE WARNING/)
})

test('validateWorkoutPlan does not flag warm-up/cool-down as breaking the sequence chain', () => {
  const plan = samplePlan()
  const result = validateWorkoutPlan(plan, { equipmentList: null, blockedNamePattern: null })
  assert.equal(result.days[0].sequence_warning, undefined)
})

test('validateWorkoutPlan keeps a pull-fallback exercise that carries block_bypass_approved', () => {
  const plan = samplePlan()
  // The pull-slot fallback ladder (workoutGenerator.js fillPullSlot) deliberately
  // lifted the fitness-level block for this one slot because every equipment-matched
  // pull was on that list. Re-blanking the name here would leave the day with push
  // work and no pull at all.
  const pull = plan.days[0].exercises[4]
  pull.name = 'Chin-Up'
  pull.equipment = 'body only'
  pull.flagged = true
  pull.flag_reason = 'pull_fallback_level_block_bypassed'
  pull.block_bypass_approved = true

  const result = validateWorkoutPlan(plan, { equipmentList: ['bands', 'body only'], blockedNamePattern: 'chin-up' })
  const checked = result.days[0].exercises[4]
  assert.equal(checked.name, 'Chin-Up', 'the real pull exercise must survive validation')
  assert.equal(checked.flag_reason, 'pull_fallback_level_block_bypassed', 'the coach-facing reason must not be overwritten')
  assert.equal(checked.flagged, true)
})

test('validateWorkoutPlan still blocks a blocked name when block_bypass_approved is absent', () => {
  const plan = samplePlan()
  plan.days[0].exercises[4].name = 'Chin-Up'
  const result = validateWorkoutPlan(plan, { equipmentList: null, blockedNamePattern: 'chin-up' })
  assert.equal(result.days[0].exercises[4].flag_reason, 'blocked_exercise')
  assert.match(result.days[0].exercises[4].name, /^\[BLOCKED EXERCISE/)
})
