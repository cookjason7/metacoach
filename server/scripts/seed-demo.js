/**
 * seed-demo.js — staging-only demo data seeder
 *
 * Safety gate: aborts if NODE_ENV === 'production' AND ALLOW_DEMO_SEED !== 'true'.
 *
 * Usage (CLI):
 *   node server/scripts/seed-demo.js          # seed (skips if already seeded)
 *   node server/scripts/seed-demo.js --wipe   # wipe demo rows then re-seed
 *
 * Also callable as a function: import { runSeed } from './seed-demo.js'
 */

import 'dotenv/config'
import { pool } from '../db.js'

// ── Safety gate ───────────────────────────────────────────────────────────────

export function isSeedAllowed() {
  const env = process.env.NODE_ENV ?? 'development'
  const override = process.env.ALLOW_DEMO_SEED === 'true'
  return env !== 'production' || override
}

// ── Deterministic fake-data helpers ──────────────────────────────────────────

function jitter(base, pct = 0.08) {
  return Math.round(base * (1 + (Math.random() - 0.5) * pct * 2) * 10) / 10
}
function rInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function pick(arr) { return arr[rInt(0, arr.length - 1)] }
function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

// ── Demo personas ─────────────────────────────────────────────────────────────

const COACH = {
  clerkId:   'demo_coach_001',
  email:     'coach@demo.metacoach.dev',
  firstName: 'Mike',
  lastName:  'Torres',
  role:      'coach',
}

const CLIENTS = [
  {
    clerkId:         'demo_client_001',
    email:           'sarah.chen@demo.metacoach.dev',
    firstName:       'Sarah',
    lastName:        'Chen',
    gender:          'female',
    age:             32,
    heightInches:    64,
    startWeightLbs:  195,
    currentWeight:   178,
    goalWeightLbs:   160,
    goalCalories:    1650,
    goalProtein:     140,
    goalCarbs:       150,
    goalFat:         55,
    startDaysAgo:    88,
    occupation:      'Marketing Manager',
    activityLevel:   'moderate',
    goals:           'Lose the last 35 lbs before my sister\'s wedding in October. Feel confident and energetic.',
    injuries:        'Right knee — avoid high-impact jumps',
    supplements:     'Creatine 5g daily, Vitamin D3',
    sleepQuality:    3,
    energyLevel:     3,
    stressLevel:     4,
    identity:        ['The Consistent One', 'The Health-Focused One'],
    habits: [
      { name: 'Log food in app', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Drink 80 oz water', type: 'numeric', target: 80, unit: 'oz', freq: 'daily', cat: 'food_tracking' },
      { name: 'Walk 8,000 steps', type: 'numeric', target: 8000, unit: 'steps', freq: 'daily', cat: 'movement' },
      { name: 'No snacking after 8pm', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
    ],
    complianceRate: 0.78,
  },
  {
    clerkId:         'demo_client_002',
    email:           'marcus.johnson@demo.metacoach.dev',
    firstName:       'Marcus',
    lastName:        'Johnson',
    gender:          'male',
    age:             45,
    heightInches:    72,
    startWeightLbs:  218,
    currentWeight:   211,
    goalWeightLbs:   200,
    goalCalories:    2400,
    goalProtein:     195,
    goalCarbs:       220,
    goalFat:         80,
    startDaysAgo:    72,
    occupation:      'Project Manager',
    activityLevel:   'moderate',
    goals:           'Build strength, add muscle, and fix years of sitting at a desk. Want to be the strongest I\'ve been since college.',
    injuries:        'Lower back tightness — needs hip mobility work',
    supplements:     'Whey protein 2x daily, Fish oil, Magnesium',
    sleepQuality:    2,
    energyLevel:     3,
    stressLevel:     4,
    identity:        ['The Strong One', 'The Disciplined One'],
    habits: [
      { name: 'Hit protein goal (195g)', type: 'numeric', target: 195, unit: 'g', freq: 'daily', cat: 'food_tracking' },
      { name: 'Lift 4x per week', type: 'boolean', freq: 'specific_days', days: '1,2,4,5', cat: 'movement' },
      { name: 'Hip mobility 10 min', type: 'boolean', freq: 'daily', cat: 'movement' },
      { name: 'Sleep by 10:30pm', type: 'boolean', freq: 'daily', cat: 'mindset' },
    ],
    complianceRate: 0.82,
  },
  {
    clerkId:         'demo_client_003',
    email:           'emily.rodriguez@demo.metacoach.dev',
    firstName:       'Emily',
    lastName:        'Rodriguez',
    gender:          'female',
    age:             28,
    heightInches:    66,
    startWeightLbs:  138,
    currentWeight:   136,
    goalWeightLbs:   132,
    goalCalories:    1850,
    goalProtein:     145,
    goalCarbs:       190,
    goalFat:         65,
    startDaysAgo:    55,
    occupation:      'Physical Therapist',
    activityLevel:   'very_active',
    goals:           'Optimize performance for half-marathon season. Want to feel fueled, not depleted.',
    injuries:        'None currently',
    supplements:     'Electrolytes, B12',
    sleepQuality:    4,
    energyLevel:     4,
    stressLevel:     2,
    identity:        ['The Athletic One', 'The Consistent One'],
    habits: [
      { name: 'Pre-workout meal 2hr before training', type: 'boolean', freq: 'specific_days', days: '0,2,4,6', cat: 'food_tracking' },
      { name: 'Log all meals', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Run or cross-train', type: 'boolean', freq: 'specific_days', days: '1,3,5,6', cat: 'movement' },
      { name: '5-min breathing practice', type: 'boolean', freq: 'daily', cat: 'mindset' },
    ],
    complianceRate: 0.91,
  },
  {
    clerkId:         'demo_client_004',
    email:           'david.kim@demo.metacoach.dev',
    firstName:       'David',
    lastName:        'Kim',
    gender:          'male',
    age:             52,
    heightInches:    69,
    startWeightLbs:  247,
    currentWeight:   231,
    goalWeightLbs:   210,
    goalCalories:    2000,
    goalProtein:     175,
    goalCarbs:       170,
    goalFat:         70,
    startDaysAgo:    90,
    occupation:      'Restaurant Owner',
    activityLevel:   'light',
    goals:           'Doctor said I need to change or I\'m heading for diabetes. Taking this seriously for the first time.',
    injuries:        'Plantar fasciitis — walking painful at times',
    supplements:     'Berberine, Fish oil',
    sleepQuality:    3,
    energyLevel:     2,
    stressLevel:     5,
    identity:        ['The Comeback Kid', 'The Health-Focused One'],
    habits: [
      { name: 'No fried food at the restaurant', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Log dinner macro estimate', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Walk 20 min after lunch', type: 'boolean', freq: 'specific_days', days: '1,2,3,4,5', cat: 'movement' },
      { name: 'Read 10 min mindset content', type: 'boolean', freq: 'daily', cat: 'mindset' },
    ],
    complianceRate: 0.61,
  },
  {
    clerkId:         'demo_client_005',
    email:           'lisa.thompson@demo.metacoach.dev',
    firstName:       'Lisa',
    lastName:        'Thompson',
    gender:          'female',
    age:             38,
    heightInches:    65,
    startWeightLbs:  172,
    currentWeight:   168,
    goalWeightLbs:   148,
    goalCalories:    1750,
    goalProtein:     130,
    goalCarbs:       165,
    goalFat:         60,
    startDaysAgo:    30,
    occupation:      'Nurse — Night shifts',
    activityLevel:   'light',
    goals:           'Lost 40lbs two years ago, gained 25 back after having the baby. Need to find my routine again.',
    injuries:        'C-section recovery complete, cleared for full activity',
    supplements:     'Postnatal vitamin',
    sleepQuality:    2,
    energyLevel:     2,
    stressLevel:     4,
    identity:        ['The Comeback Kid', 'The Consistent One'],
    habits: [
      { name: 'Meal prep Sunday', type: 'boolean', freq: 'specific_days', days: '0', cat: 'food_tracking' },
      { name: 'Pack lunch before night shift', type: 'boolean', freq: 'specific_days', days: '3,4,5', cat: 'food_tracking' },
      { name: 'Stroller walk 30 min', type: 'boolean', freq: 'specific_days', days: '1,3,5', cat: 'movement' },
    ],
    complianceRate: 0.68,
  },
  {
    clerkId:         'demo_client_006',
    email:           'james.wilson@demo.metacoach.dev',
    firstName:       'James',
    lastName:        'Wilson',
    gender:          'male',
    age:             34,
    heightInches:    71,
    startWeightLbs:  189,
    currentWeight:   184,
    goalWeightLbs:   178,
    goalCalories:    2200,
    goalProtein:     185,
    goalCarbs:       200,
    goalFat:         75,
    startDaysAgo:    60,
    occupation:      'Software Engineer (Remote)',
    activityLevel:   'moderate',
    goals:           'Lose the remote-work weight gain. Want to feel like myself again. Energy is terrible right now.',
    injuries:        'None',
    supplements:     'Creatine, Vitamin D, Omega-3',
    sleepQuality:    3,
    energyLevel:     3,
    stressLevel:     3,
    identity:        ['The Disciplined One', 'The Strong One'],
    habits: [
      { name: 'Stand and walk every 90 min', type: 'boolean', freq: 'specific_days', days: '1,2,3,4,5', cat: 'movement' },
      { name: 'Log all meals', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Gym 3x this week', type: 'boolean', freq: 'specific_days', days: '1,3,5', cat: 'movement' },
      { name: 'No alcohol on weekdays', type: 'boolean', freq: 'specific_days', days: '1,2,3,4,5', cat: 'mindset' },
    ],
    complianceRate: 0.75,
  },
  {
    clerkId:         'demo_client_007',
    email:           'amanda.foster@demo.metacoach.dev',
    firstName:       'Amanda',
    lastName:        'Foster',
    gender:          'female',
    age:             41,
    heightInches:    63,
    startWeightLbs:  158,
    currentWeight:   154,
    goalWeightLbs:   138,
    goalCalories:    1600,
    goalProtein:     125,
    goalCarbs:       145,
    goalFat:         55,
    startDaysAgo:    45,
    occupation:      'Elementary School Teacher',
    activityLevel:   'moderate',
    goals:           'Stop stress eating at the end of the school day. Build a sustainable routine I can actually keep.',
    injuries:        'None',
    supplements:     'Magnesium glycinate for sleep',
    sleepQuality:    3,
    energyLevel:     3,
    stressLevel:     5,
    identity:        ['The Health-Focused One', 'The Consistent One'],
    habits: [
      { name: 'Eat a real lunch (not just snacks)', type: 'boolean', freq: 'specific_days', days: '1,2,3,4,5', cat: 'food_tracking' },
      { name: 'After-school walk instead of snacking', type: 'boolean', freq: 'specific_days', days: '1,2,3,4,5', cat: 'movement' },
      { name: 'Journal 5 min before bed', type: 'boolean', freq: 'daily', cat: 'mindset' },
      { name: 'No mindless phone snacking after 9pm', type: 'boolean', freq: 'daily', cat: 'mindset' },
    ],
    complianceRate: 0.72,
  },
  {
    clerkId:         'demo_client_008',
    email:           'ryan.martinez@demo.metacoach.dev',
    firstName:       'Ryan',
    lastName:        'Martinez',
    gender:          'male',
    age:             29,
    heightInches:    70,
    startWeightLbs:  205,
    currentWeight:   203,
    goalWeightLbs:   185,
    goalCalories:    2300,
    goalProtein:     180,
    goalCarbs:       215,
    goalFat:         78,
    startDaysAgo:    14,
    occupation:      'Sales Representative',
    activityLevel:   'moderate',
    goals:           'Lose 20lbs before my 30th birthday. Tired of feeling sluggish at client dinners.',
    injuries:        'None',
    supplements:     'Protein powder',
    sleepQuality:    4,
    energyLevel:     3,
    stressLevel:     3,
    identity:        ['The Disciplined One', 'The Athletic One'],
    habits: [
      { name: 'High-protein breakfast every day', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Log all food in app', type: 'boolean', freq: 'daily', cat: 'food_tracking' },
      { name: 'Gym or walk — no zero days', type: 'boolean', freq: 'daily', cat: 'movement' },
    ],
    complianceRate: 0.85,
  },
]

const MEAL_TEMPLATES = [
  // slot, name, cal, pro, carb, fat, fiber
  ['breakfast', 'Greek Yogurt + Berries + Granola',       380, 28, 42, 8, 4],
  ['breakfast', 'Eggs & Avocado Toast',                   420, 22, 38, 18, 6],
  ['breakfast', 'Protein Oatmeal with Banana',            390, 30, 48, 7, 5],
  ['breakfast', 'Chicken Egg White Scramble',             320, 35, 8, 12, 2],
  ['breakfast', 'Protein Shake + Fruit',                  340, 40, 32, 6, 3],
  ['breakfast', 'Cottage Cheese + Berries',               280, 30, 24, 4, 3],
  ['lunch',     'Grilled Chicken Salad',                  480, 42, 28, 18, 6],
  ['lunch',     'Turkey & Avocado Wrap',                  520, 38, 48, 16, 5],
  ['lunch',     'Ground Beef Rice Bowl',                  580, 40, 55, 18, 4],
  ['lunch',     'Salmon + Roasted Veg + Rice',            540, 38, 48, 14, 6],
  ['lunch',     'Tuna Salad Lettuce Wraps',               320, 35, 8, 14, 3],
  ['lunch',     'Chicken Burrito Bowl',                   620, 45, 62, 16, 8],
  ['lunch',     'Shrimp Stir Fry + Brown Rice',           490, 36, 52, 10, 5],
  ['dinner',    'Grilled Salmon + Sweet Potato + Broccoli', 560, 42, 45, 16, 8],
  ['dinner',    'Chicken Thighs + Roasted Veggies',       520, 48, 22, 22, 6],
  ['dinner',    'Lean Beef Tacos (2) + Salad',            580, 38, 48, 22, 7],
  ['dinner',    'Turkey Meatballs + Zucchini Pasta',      490, 44, 28, 18, 6],
  ['dinner',    'Pork Tenderloin + Rice + Green Beans',   540, 46, 48, 12, 5],
  ['dinner',    'Baked Tilapia + Quinoa + Asparagus',     480, 40, 42, 10, 7],
  ['dinner',    'Shrimp + Cauliflower Rice Bowl',         400, 38, 24, 12, 5],
  ['snack',     'Protein Bar',                            200, 20, 22, 6, 2],
  ['snack',     'Apple + Almond Butter',                  240, 6, 28, 12, 4],
  ['snack',     'Greek Yogurt',                           150, 15, 12, 2, 0],
  ['snack',     'Rice Cakes + Peanut Butter',             230, 8, 28, 10, 2],
  ['snack',     'Hard Boiled Eggs x2',                   155, 13, 1, 11, 0],
  ['snack',     'Cottage Cheese + Pineapple',             180, 18, 18, 2, 1],
]

const COACH_NOTE_TEMPLATES = [
  c => `${c.firstName} had a great first week — already down ${rInt(1,3)} lbs. Keep momentum going.`,
  c => `Reminder to increase protein to meet goal of ${c.goalProtein}g. Logging has been inconsistent at dinner.`,
  c => `${c.firstName} mentioned stress at work — reinforce habit stacking and the "good enough" mindset.`,
  c => `Check in on hydration. Water logs show some days missing. Goal is ${c.goalCalories} kcal on training days.`,
  c => `Progress photos requested for next check-in. Weight trending in right direction.`,
  c => `Great week for ${c.firstName}. Compliance was high — habits looking solid. Consider adding a 5th habit next cycle.`,
  c => `Discussed sleep quality issues. Suggested no screens 30min before bed, magnesium glycinate if open to it.`,
]

const MESSAGE_PAIRS = [
  [
    c => `Hi ${c.firstName}! Just checking in — how is the week going?`,
    c => `Hey! Pretty good actually. Stayed on track with meals all week. The Sunday prep really helped.`,
  ],
  [
    c => `Great job this week on hitting your protein goal! How are energy levels feeling?`,
    c => `Way better than last month honestly. Still tired some mornings but overall feeling stronger.`,
  ],
  [
    c => `Quick reminder — try to get your water logged even on days you feel like you hit it. Helps us track the trend.`,
    c => `Good call, I keep forgetting to log it. I'll set a reminder.`,
  ],
  [
    c => `How did the meal prep go this week?`,
    c => `Actually did it this time! Made a big batch of chicken and rice. Made the week so much easier.`,
  ],
  [
    c => `Saw your check-in — nice progress this week. How did the workout feel?`,
    c => `Tough but I finished it. The lunges are still killing me but I'm getting there.`,
  ],
]

const AI_CLIENT = {
  clerkId:        'demo_client_ai_001',
  email:          'alex.demo@demo.metacoach.dev',
  firstName:      'Alex',
  lastName:       'Demo',
  gender:         'male',
  age:            35,
  heightInches:   70,
  startWeightLbs: 210,
  currentWeight:  210,
  goalWeightLbs:  190,
  goalCalories:   2100,
  goalProtein:    170,
  goalCarbs:      190,
  goalFat:        72,
  startDaysAgo:   20,
  activityLevel:  'moderate',
  habits: [
    { name: 'Log meals daily',   type: 'boolean', freq: 'daily', cat: 'food_tracking' },
    { name: 'Walk 7,000 steps',  type: 'numeric', target: 7000, unit: 'steps', freq: 'daily', cat: 'movement' },
  ],
  complianceRate: 0.70,
}

// ── Demo AI client helper ─────────────────────────────────────────────────────

async function seedAiDemoClient(db, coachId, log) {
  const { rows: aiExisting } = await db.query(
    `SELECT id FROM users WHERE clerk_user_id = $1 LIMIT 1`, [AI_CLIENT.clerkId]
  )
  if (aiExisting.length) {
    log(`  ↩ AI client already exists (id=${aiExisting[0].id})`)
  } else {
    const startDate = daysAgo(AI_CLIENT.startDaysAgo)
    const { rows: [aiRow] } = await db.query(`
      INSERT INTO users
        (clerk_user_id, email, first_name, last_name, name, role, paid,
         onboarding_complete, assessment_complete, client_status,
         coaching_type, assigned_coach_id, start_date,
         age, gender, height_inches, starting_weight_lbs, goal_weight_lbs,
         goal_calories, goal_protein, goal_carbs, goal_fat, activity_level)
      VALUES ($1,$2,$3,$4,$5,'client',TRUE,TRUE,TRUE,'active',
              'hybrid',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id
    `, [
      AI_CLIENT.clerkId, AI_CLIENT.email,
      AI_CLIENT.firstName, AI_CLIENT.lastName,
      `${AI_CLIENT.firstName} ${AI_CLIENT.lastName}`,
      coachId, isoDate(startDate),
      AI_CLIENT.age, AI_CLIENT.gender, AI_CLIENT.heightInches,
      AI_CLIENT.startWeightLbs, AI_CLIENT.goalWeightLbs,
      AI_CLIENT.goalCalories, AI_CLIENT.goalProtein, AI_CLIENT.goalCarbs,
      AI_CLIENT.goalFat, AI_CLIENT.activityLevel,
    ])
    const aiId = aiRow.id
    // Seed minimal habits
    const habitStart = isoDate(daysAgo(AI_CLIENT.startDaysAgo))
    for (const h of AI_CLIENT.habits) {
      await db.query(`
        INSERT INTO coach_assigned_habits
          (user_id, assigned_by_user_id, habit_name, habit_type,
           target_value, unit, frequency, days_of_week, start_date, active, identity_category)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
      `, [
        aiId, coachId, h.name, h.type,
        h.target ?? null, h.unit ?? null,
        h.freq, h.days ?? null,
        habitStart, h.cat ?? null,
      ])
    }
    log(`  ✓ AI client ${AI_CLIENT.firstName} ${AI_CLIENT.lastName} (id=${aiId}, coaching_type='hybrid')`)
  }
}

// ── Core seed function ────────────────────────────────────────────────────────

export async function runSeed({ wipe = false, log = console.log } = {}) {
  if (!isSeedAllowed()) {
    throw new Error('Demo seed blocked: NODE_ENV=production and ALLOW_DEMO_SEED is not set.')
  }

  const client = await pool.connect()
  try {
    // ── Check / wipe ────────────────────────────────────────────────────────────
    const { rows: existing } = await client.query(
      `SELECT id FROM users WHERE clerk_user_id LIKE 'demo_%' LIMIT 1`
    )
    if (existing.length > 0 && !wipe) {
      log('ℹ  Demo data present — skipping main seed, checking demo extras…')
      const { rows: [coachRow] } = await client.query(
        `SELECT id FROM users WHERE clerk_user_id = 'demo_coach_001' LIMIT 1`
      )
      if (coachRow) {
        await client.query('BEGIN')
        try {
          await seedAiDemoClient(client, coachRow.id, log)
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK')
          throw e
        }
      }
      log('✅ Demo extras check complete.')
      return { skipped: true, reason: 'already_seeded' }
    }
    if (wipe && existing.length > 0) {
      log('🗑  Wiping existing demo rows…')
      // Retire any previously-seeded [QA]-prefixed form templates (legacy demo artifacts).
      // Break circular FK (current_version_id → form_versions) before cascade-deleting templates
      await client.query(`UPDATE form_templates SET current_version_id = NULL WHERE title LIKE '[QA]%'`)
      // Cascade-deletes form_versions, form_submissions, form_assignments for QA templates
      await client.query(`DELETE FROM form_templates WHERE title LIKE '[QA]%'`)
      // Cascade-deletes all user-linked data (habits, meals, submissions, etc.)
      await client.query(`DELETE FROM users WHERE clerk_user_id LIKE 'demo_%'`)
      log('   Done.')
    }

    await client.query('BEGIN')
    const summary = { coach: null, clients: [] }

    // ── Insert coach ────────────────────────────────────────────────────────────
    const { rows: [coachRow] } = await client.query(`
      INSERT INTO users
        (clerk_user_id, email, first_name, last_name, name, role, paid,
         onboarding_complete, assessment_complete, client_status, staff_status)
      VALUES ($1,$2,$3,$4,$5,'coach',TRUE,TRUE,TRUE,'active','active')
      RETURNING id
    `, [COACH.clerkId, COACH.email, COACH.firstName, COACH.lastName,
        `${COACH.firstName} ${COACH.lastName}`])
    const coachId = coachRow.id
    summary.coach = coachId
    log(`✓ Coach created (id=${coachId})`)

    // ── Insert clients ──────────────────────────────────────────────────────────
    for (const c of CLIENTS) {
      log(`  Seeding ${c.firstName} ${c.lastName}…`)

      const startDate = daysAgo(c.startDaysAgo)
      const today = new Date()

      // 1. users row
      const { rows: [uRow] } = await client.query(`
        INSERT INTO users
          (clerk_user_id, email, first_name, last_name, name, role, paid,
           onboarding_complete, assessment_complete, client_status,
           coaching_type, assigned_coach_id, start_date,
           age, gender, height_inches, starting_weight_lbs, goal_weight_lbs,
           goal_calories, goal_protein, goal_carbs, goal_fat,
           activity_level)
        VALUES ($1,$2,$3,$4,$5,'client',TRUE,TRUE,TRUE,'active',
                'vip',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING id
      `, [
        c.clerkId, c.email, c.firstName, c.lastName,
        `${c.firstName} ${c.lastName}`,
        coachId,
        isoDate(startDate),
        c.age, c.gender, c.heightInches,
        c.startWeightLbs, c.goalWeightLbs,
        c.goalCalories, c.goalProtein, c.goalCarbs, c.goalFat,
        c.activityLevel,
      ])
      const userId = uRow.id

      // 2. health_assessments
      await client.query(`
        INSERT INTO health_assessments
          (user_id, first_name, last_name, email,
           occupation, activity_level, goals_6_months, injuries_limitations,
           supplements, sleep_quality, energy_level, stress_management,
           happiness_level, confidence_level, daily_water, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'64+ oz', NOW())
        ON CONFLICT (user_id) DO NOTHING
      `, [
        userId, c.firstName, c.lastName, c.email,
        c.occupation, c.activityLevel, c.goals, c.injuries,
        c.supplements, c.sleepQuality, c.energyLevel, c.stressLevel,
        rInt(3, 5), rInt(3, 5),
      ])

      // 3. daily_logs — 90 days of weight, steps, water, sleep
      const logDays = Math.min(90, c.startDaysAgo)
      const weightDelta = (c.currentWeight - c.startWeightLbs) / logDays
      for (let i = logDays; i >= 0; i--) {
        const d = daysAgo(i)
        if (d < startDate) continue
        const progress = (logDays - i) / logDays
        const w = Math.round((c.startWeightLbs + weightDelta * (logDays - i) + jitter(0, 0.05)) * 10) / 10
        // skip some days randomly (not everyone logs every day)
        if (Math.random() < 0.15) continue
        await client.query(`
          INSERT INTO daily_logs (user_id, logged_date, weight_lbs, steps, water_oz, sleep_minutes)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (user_id, logged_date) DO NOTHING
        `, [
          userId,
          isoDate(d),
          w,
          rInt(4500, 13000),
          Math.round(jitter(72, 0.25) * 10) / 10,
          rInt(340, 490), // 5h40m – 8h10m
        ])
      }

      // 4. meals — 30 days, 3-4 meals per day
      const mealDays = Math.min(30, c.startDaysAgo)
      for (let i = mealDays; i >= 0; i--) {
        const d = daysAgo(i)
        if (d < startDate) continue
        if (Math.random() < 0.12) continue // skip some days
        const breakfastOpts = MEAL_TEMPLATES.filter(m => m[0] === 'breakfast')
        const lunchOpts     = MEAL_TEMPLATES.filter(m => m[0] === 'lunch')
        const dinnerOpts    = MEAL_TEMPLATES.filter(m => m[0] === 'dinner')
        const snackOpts     = MEAL_TEMPLATES.filter(m => m[0] === 'snack')
        const dayMeals = [
          pick(breakfastOpts),
          pick(lunchOpts),
          pick(dinnerOpts),
          ...(Math.random() < 0.6 ? [pick(snackOpts)] : []),
        ]
        for (const [slot, name, cal, pro, carb, fat, fiber] of dayMeals) {
          await client.query(`
            INSERT INTO meals
              (user_id, meal_name, meal_slot, log_date, calories, protein, carbs, fat, fiber)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [
            userId, name, slot, isoDate(d),
            Math.round(jitter(cal, 0.06)),
            Math.round(jitter(pro, 0.06) * 10) / 10,
            Math.round(jitter(carb, 0.06) * 10) / 10,
            Math.round(jitter(fat, 0.06) * 10) / 10,
            fiber,
          ])
        }
      }

      // 5. coach_assigned_habits
      const habitStartDate = isoDate(startDate)
      const insertedHabitIds = []
      for (const h of c.habits) {
        const { rows: [hRow] } = await client.query(`
          INSERT INTO coach_assigned_habits
            (user_id, assigned_by_user_id, habit_name, habit_type,
             target_value, unit, frequency, days_of_week,
             start_date, active, identity_category)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
          RETURNING id
        `, [
          userId, coachId, h.name, h.type,
          h.target ?? null, h.unit ?? null,
          h.freq, h.days ?? null,
          habitStartDate,
          h.cat ?? null,
        ])
        insertedHabitIds.push({ id: hRow.id, habit: h })
      }

      // 6. habit_completions — realistic compliance over last ~45 days
      const compDays = Math.min(45, c.startDaysAgo)
      for (let i = compDays; i >= 0; i--) {
        const d = daysAgo(i)
        if (d < startDate) continue
        if (d > today) continue
        const dow = d.getDay() // 0=Sun … 6=Sat
        for (const { id: habitId, habit } of insertedHabitIds) {
          // Check if this habit is scheduled for this day
          if (habit.freq === 'specific_days' && habit.days) {
            const scheduled = habit.days.split(',').map(Number)
            if (!scheduled.includes(dow)) continue
          }
          // Roll compliance
          if (Math.random() > c.complianceRate) continue // missed
          const pct = habit.type === 'numeric'
            ? Math.round(jitter(100, 0.12))
            : 100
          const status = pct >= 80 ? 'complete' : pct >= 50 ? 'partial' : 'not_started'
          await client.query(`
            INSERT INTO habit_completions
              (user_id, habit_id, completion_date,
               completed_value, target_value, completion_percentage, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (habit_id, completion_date) DO NOTHING
          `, [
            userId, habitId, isoDate(d),
            habit.target ? Math.round(jitter(habit.target, 0.1) * 10) / 10 : null,
            habit.target ?? null,
            pct, status,
          ])
        }
      }

      // 7. weekly_checkins — last 8 weeks
      for (let w = 7; w >= 0; w--) {
        const weekStart = daysAgo(w * 7 + new Date().getDay()) // align to Monday
        if (weekStart < startDate) continue
        if (Math.random() < 0.15) continue // occasional missed check-in
        const weightAtWeek = c.startWeightLbs + (c.currentWeight - c.startWeightLbs) * ((8 - w) / 8)
        await client.query(`
          INSERT INTO weekly_checkins
            (user_id, week_start, current_weight,
             sleep_quality, energy, stress, cravings,
             workouts_completed, days_food_logged, days_hit_protein,
             biggest_win, biggest_struggle)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (user_id, week_start) DO NOTHING
        `, [
          userId, isoDate(weekStart),
          Math.round(weightAtWeek * 10) / 10,
          rInt(c.sleepQuality - 1, Math.min(5, c.sleepQuality + 1)),
          rInt(c.energyLevel  - 1, Math.min(5, c.energyLevel  + 1)),
          rInt(Math.max(1, c.stressLevel - 1), Math.min(5, c.stressLevel + 1)),
          rInt(1, 4),
          rInt(2, 5),
          rInt(3, 7),
          rInt(2, 6),
          pick([
            'Hit protein goal 5 days in a row',
            'Meal prepped for the first time',
            'Skipped the office donuts',
            'Got 8 hours three nights in a row',
            'Chose the salad at dinner out',
            'Did not stress eat after a hard day',
            'Logged every meal this week',
            'Down another pound',
          ]),
          pick([
            'Late night snacking on Thursday',
            'Skipped workout on Wednesday — too tired',
            'Weekend got off track with family BBQ',
            'Stressed at work and stress ate',
            'Forgot to log dinner twice',
            'Not drinking enough water',
            'Sleep was rough this week',
          ]),
        ])
      }

      // 8. activity_logs — 8–14 workout sessions
      const numWorkouts = rInt(8, Math.min(14, Math.floor(c.startDaysAgo / 5)))
      const activities = ['Weight Training', 'Cardio', 'Walking', 'HIIT', 'Yoga / Stretching', 'Cycling', 'Swimming']
      for (let i = 0; i < numWorkouts; i++) {
        const dOffset = rInt(1, Math.min(c.startDaysAgo, 60))
        const d = daysAgo(dOffset)
        if (d < startDate) continue
        await client.query(`
          INSERT INTO activity_logs (user_id, activity_type, duration_minutes, logged_at)
          VALUES ($1,$2,$3,$4)
        `, [userId, pick(activities), rInt(20, 65), d.toISOString()])
      }

      // 9. client_measurements — 2–3 measurements
      const numMeasurements = rInt(2, 3)
      for (let i = numMeasurements - 1; i >= 0; i--) {
        const mDate = daysAgo(i * Math.floor(c.startDaysAgo / numMeasurements))
        if (mDate < startDate) continue
        await client.query(`
          INSERT INTO client_measurements (user_id, measurement_date, chest, waist, hips)
          VALUES ($1,$2,$3,$4,$5)
        `, [
          userId, isoDate(mDate),
          c.gender === 'female' ? rInt(34, 42) : rInt(38, 46),
          rInt(30, 40),
          c.gender === 'female' ? rInt(36, 46) : rInt(34, 42),
        ])
      }

      // 10. client_notes — 2-3 coach notes
      const numNotes = rInt(2, 3)
      const noteFns = [...COACH_NOTE_TEMPLATES].sort(() => Math.random() - 0.5).slice(0, numNotes)
      for (let i = 0; i < noteFns.length; i++) {
        const noteDate = daysAgo(rInt(3, Math.min(c.startDaysAgo, 30)))
        await client.query(`
          INSERT INTO client_notes (client_id, author_id, note_body, visibility, created_at)
          VALUES ($1,$2,$3,'shared_staff',$4)
        `, [userId, coachId, noteFns[i](c), noteDate.toISOString()])
      }

      // 11. client_messages — 1-2 exchange pairs
      const msgPair = pick(MESSAGE_PAIRS)
      const msgDate = daysAgo(rInt(2, 10))
      // Coach sends first
      await client.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body,
           thread_type, visibility, read_at, created_at)
        VALUES ($1,$2,'staff',$3,'coach_thread','client_and_staff',NOW(),$4)
      `, [userId, coachId, msgPair[0](c), msgDate.toISOString()])
      // Client replies (unread — allows badge test)
      const replyDate = new Date(msgDate.getTime() + rInt(1, 8) * 3600_000)
      await client.query(`
        INSERT INTO client_messages
          (client_id, sender_id, sender_role, message_body,
           thread_type, visibility, read_at, created_at)
        VALUES ($1,$2,'client',$3,'coach_thread','client_and_staff',NULL,$4)
      `, [userId, userId, msgPair[1](c), replyDate.toISOString()])

      summary.clients.push({ id: userId, name: `${c.firstName} ${c.lastName}` })
      log(`  ✓ ${c.firstName} ${c.lastName} (id=${userId})`)
    }

    // ── AI demo client ───────────────────────────────────────────────────────────
    log('\n  Seeding AI demo client…')
    await seedAiDemoClient(client, coachId, log)

    await client.query('COMMIT')
    log(`\n✅ Demo seed complete — 1 coach, ${summary.clients.length} clients + AI demo client`)
    return { ok: true, summary }

  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1].endsWith('seed-demo.js')) {
  const wipe = process.argv.includes('--wipe')
  if (!isSeedAllowed()) {
    console.error('❌ Demo seed blocked: NODE_ENV=production and ALLOW_DEMO_SEED is not set.')
    process.exit(1)
  }
  console.log(`🌱 Starting demo seed (wipe=${wipe})…`)
  runSeed({ wipe, log: console.log })
    .then(result => {
      if (result.skipped) console.log('ℹ Already seeded. Use --wipe to reset.')
      process.exit(0)
    })
    .catch(err => {
      console.error('❌ Seed failed:', err.message)
      process.exit(1)
    })
}
