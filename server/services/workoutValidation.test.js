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
