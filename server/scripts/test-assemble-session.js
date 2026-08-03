/**
 * test-assemble-session.js — standalone smoke test for assembleSession.js.
 * Not wired into any route; run directly against staging to eyeball output.
 *
 * Usage:
 *   node server/scripts/test-assemble-session.js
 */

import 'dotenv/config'
import { pool } from '../db.js'
import { assembleSession } from '../services/workoutAssembly/assembleSession.js'

const flags = []
const flag = msg => { flags.push(msg); console.log(`  [FLAG] ${msg}`) }

// Patterns with zero bodyweight-only entries anywhere in exercise_library's
// main_lift pool — queried live (mainLifts.js has no hardcoded name list to
// read anymore; pickMainLift() queries by movement_pattern directly), so
// this covers every main_lift source_program, not just one seed's rows.
async function patternsWithNoBodyweightOption() {
  const { rows } = await pool.query(
    `SELECT name, movement_pattern, equipment_required FROM exercise_library
     WHERE category = 'main_lift' AND active = TRUE`,
  )
  const byPattern = rows.reduce((acc, r) => {
    (acc[r.movement_pattern] ??= []).push(r)
    return acc
  }, {})
  return Object.entries(byPattern)
    .filter(([, exs]) => !exs.some(e => e.equipment_required.length === 1 && e.equipment_required[0] === 'bodyweight'))
    .map(([pattern]) => pattern)
    .sort()
}

const PROFILES = [
  {
    label: 'Full gym equipment access', level: 'advanced',
    equipment: ['bodyweight', 'barbell', 'dumbbell', 'cable', 'kettlebell', 'trap_bar',
      'mini_band', 'big_band', 'foam_roller', 'tennis_ball', 'medicine_ball'],
  },
  {
    label: 'Bodyweight-only, no equipment', level: 'beginner',
    equipment: ['bodyweight'],
  },
  {
    label: 'Limited home equipment (dumbbells + bands only)', level: 'intermediate',
    equipment: ['bodyweight', 'dumbbell', 'mini_band', 'big_band'],
  },
]

function fmtEx({ exercise, prescription }) {
  const eq = exercise.equipment_required.join(',') || 'none'
  const pres = typeof prescription === 'string' ? prescription : `${prescription.sets}x${prescription.repRange}`
  return `${exercise.name}  [equip: ${eq}]  -  ${pres}`
}

async function runProfile(profile, noBwPatterns) {
  console.log('\n' + '='.repeat(78))
  console.log(`PROFILE: ${profile.label}`)
  console.log(`  level: ${profile.level}   equipment: [${profile.equipment.join(', ')}]`)
  console.log('='.repeat(78))

  for (const dayLabel of ['A', 'B']) {
    const session = await assembleSession(pool, {
      orgId: 1, dayLabel, sessionLength: 60, goal: 'hypertrophy', level: profile.level, equipment: profile.equipment,
    })

    console.log(`\n--- DAY ${dayLabel} ---`)

    console.log('\n[Warm-up]')
    for (const cat of ['foam_roll', 'mobility', 'activation', 'bands', 'plyo']) {
      const items = session.warmup[cat]
      const placeholder = cat === 'foam_roll' || cat === 'activation'
      if (items.length === 0) {
        console.log(`  ${cat}: (none picked${placeholder ? ' — coach-editable placeholder, expected' : ''})`)
      } else {
        console.log(`  ${cat}:`)
        items.forEach(item => console.log(`    - ${fmtEx(item)}`))
      }
    }

    console.log('\n[Main lift + accessory work, in order]')
    for (const slot of session.main) {
      const required = slot.exercise.equipment_required
      const availableForCheck = profile.equipment.includes('bodyweight') ? profile.equipment : [...profile.equipment, 'bodyweight']
      const matches = required.every(eq => availableForCheck.includes(eq))
      const matchLabel = matches ? 'MATCH' : 'NO MATCH (fell back to full pool)'
      console.log(`  ${slot.movementPattern.padEnd(16)} -> ${slot.exercise.name}  [equip: ${required.join(',') || 'none'}]  ${slot.prescription.sets}x${slot.prescription.repRange}  (${matchLabel})`)

      const shouldWarn = noBwPatterns.includes(slot.movementPattern) && !matches
      const didWarn = session.warnings.some(w => w.includes(`"${slot.movementPattern}"`))
      if (shouldWarn !== didWarn) {
        flag(`Day ${dayLabel} / ${slot.movementPattern}: expected warning=${shouldWarn}, actual warning=${didWarn}`)
      }
    }

    console.log('\n[Cooldown]')
    if (session.cooldown.core.length === 0) {
      console.log('  core: (none picked)')
    } else {
      console.log('  core:')
      session.cooldown.core.forEach(item => console.log(`    - ${fmtEx(item)}  [${item.exercise.core_subtype}]`))
    }
    if (session.cooldown.stretch.length === 0) {
      console.log('  stretch: (none picked — coach-editable placeholder, expected)')
    } else {
      console.log('  stretch:')
      session.cooldown.stretch.forEach(item => console.log(`    - ${fmtEx(item)}`))
    }
    if (session.cooldown.finisher.length === 0) {
      console.log('  finisher: (none picked — coach-editable placeholder, expected)')
    } else {
      console.log('  finisher:')
      session.cooldown.finisher.forEach(item => console.log(`    - ${fmtEx(item)}`))
    }

    console.log('\n[Warnings reported by assembleSession]')
    if (session.warnings.length === 0) {
      console.log('  (none)')
    } else {
      session.warnings.forEach(w => console.log(`  - ${w}`))
    }

    // Sanity checks not specific to equipment matching.
    if (session.main.length !== 4) {
      flag(`Day ${dayLabel}: expected 4 main-work slots, got ${session.main.length}`)
    }
    // foam_roll and activation are intentionally always empty (coach-editable
    // placeholders — see assembleSession.js) and deliberately excluded here;
    // only mobility/plyo should still be flagged if a real gap shows up.
    for (const cat of ['mobility', 'plyo']) {
      if (session.warmup[cat].length === 0 && profile.equipment.length > 1) {
        flag(`Day ${dayLabel}: "${cat}" returned zero picks even though profile has non-bodyweight equipment — check equipment tagging for that category`)
      }
    }
    if (session.warmup.foam_roll.length !== 0) {
      flag(`Day ${dayLabel}: "foam_roll" expected to always be empty (coach-editable placeholder) but got ${session.warmup.foam_roll.length} pick(s)`)
    }
    if (session.warmup.activation.length !== 0) {
      flag(`Day ${dayLabel}: "activation" expected to always be empty (coach-editable placeholder) but got ${session.warmup.activation.length} pick(s)`)
    }
    if (session.cooldown.stretch.length !== 0) {
      flag(`Day ${dayLabel}: "stretch" expected to always be empty (coach-editable placeholder) but got ${session.cooldown.stretch.length} pick(s)`)
    }
    if (session.cooldown.finisher.length !== 0) {
      flag(`Day ${dayLabel}: "finisher" expected to always be empty (coach-editable placeholder) but got ${session.cooldown.finisher.length} pick(s)`)
    }
  }
}

async function run() {
  const noBwPatterns = await patternsWithNoBodyweightOption()
  console.log(`Patterns with NO bodyweight-only option in exercise_library main_lift pool: [${noBwPatterns.join(', ')}]`)

  for (const profile of PROFILES) {
    await runProfile(profile, noBwPatterns)
  }

  console.log('\n' + '='.repeat(78))
  console.log('SUMMARY')
  console.log('='.repeat(78))
  if (flags.length === 0) {
    console.log('No flags raised — output matched expectations for all profiles/days.')
  } else {
    console.log(`${flags.length} flag(s) raised:`)
    flags.forEach(f => console.log(`  - ${f}`))
  }

  await pool.end()
}

run().catch(err => {
  console.error('Test script failed:', err)
  process.exit(1)
})
