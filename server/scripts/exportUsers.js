/**
 * exportUsers.js — one-off, read-only export of per-user data (profile,
 * health assessment, logs, meals, workouts, habits, photos, macro history)
 * to local JSON files. Does not modify any data.
 *
 * Output is written to server/scripts/export-output/ (gitignored — this
 * directory holds PII and health data and must never be committed).
 *
 * Usage:
 *   node server/scripts/exportUsers.js [--include-inactive]
 */

import 'dotenv/config'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { pool } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(__dirname, 'export-output')

const includeInactive = process.argv.includes('--include-inactive')

function groupBy(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const k = row[key]
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(row)
  }
  return map
}

async function main() {
  console.log(`Exporting users (include-inactive: ${includeInactive})...\n`)

  const { rows: [{ c: totalUserCount }] } = await pool.query(
    `SELECT count(*)::int AS c FROM users`,
  )

  const { rows: users } = await pool.query(
    `SELECT id, first_name, last_name, email, phone_number, coaching_type,
            start_date, created_at, client_status
     FROM users
     WHERE $1::boolean OR (client_status IS NULL OR client_status NOT IN ('deactivated', 'deleted'))
     ORDER BY id`,
    [includeInactive],
  )
  const userIds = users.map(u => u.id)

  const [
    healthAssessments,
    dailyLogs,
    meals,
    customFoods,
    workouts,
    workoutExercises,
    workoutLogs,
    habits,
    habitCompletions,
    progressPhotos,
    macroHistory,
  ] = await Promise.all([
    pool.query(
      `SELECT user_id, street_address, city, state, zip_code, country, date_of_birth,
              shirt_size, supplements, goals_6_months, injuries_limitations, occupation,
              energy_level, sleep_hours, sleep_quality, stress_management, daily_water,
              alcohol_weekdays, alcohol_weekends, activity_level
       FROM health_assessments WHERE user_id = ANY($1)`,
      [userIds],
    ),
    pool.query(
      `SELECT user_id, logged_date, weight_lbs, steps, water_oz
       FROM daily_logs WHERE user_id = ANY($1) ORDER BY logged_date`,
      [userIds],
    ),
    pool.query(
      `SELECT user_id, log_date, meal_name, calories, protein, carbs, fat, meal_slot
       FROM meals WHERE user_id = ANY($1) ORDER BY log_date`,
      [userIds],
    ),
    pool.query(
      `SELECT user_id, food_name, calories_per_serving, protein, carbs, fat,
              serving_size, serving_unit, created_at
       FROM custom_foods WHERE user_id = ANY($1) ORDER BY created_at`,
      [userIds],
    ),
    pool.query(
      `SELECT id, user_id, name, description, status, created_at
       FROM workouts WHERE user_id = ANY($1) ORDER BY created_at`,
      [userIds],
    ),
    pool.query(
      `SELECT we.id, we.workout_id, we.day, we.exercise_name, we.sets, we.reps,
              we.rest_seconds, we.notes, we.weight, we.sort_order, we.day_focus, we.section_name
       FROM workout_exercises we
       JOIN workouts w ON w.id = we.workout_id
       WHERE w.user_id = ANY($1)
       ORDER BY we.workout_id, we.sort_order`,
      [userIds],
    ),
    pool.query(
      `SELECT id, user_id, workout_id, completed_at, notes, scheduled_date
       FROM workout_logs WHERE user_id = ANY($1) ORDER BY completed_at`,
      [userIds],
    ),
    pool.query(
      `SELECT id, user_id, habit_name, habit_type, target_value, unit, frequency,
              start_date, end_date, days_of_week, active
       FROM coach_assigned_habits WHERE user_id = ANY($1) ORDER BY start_date`,
      [userIds],
    ),
    pool.query(
      `SELECT id, habit_id, user_id, completion_date, completed_value, target_value,
              completion_percentage, status
       FROM habit_completions WHERE user_id = ANY($1) ORDER BY completion_date`,
      [userIds],
    ),
    pool.query(
      `SELECT user_id, photo_url, angle, taken_at
       FROM progress_photos WHERE user_id = ANY($1) ORDER BY taken_at`,
      [userIds],
    ),
    pool.query(
      `SELECT user_id, goal_calories, goal_protein, goal_carbs, goal_fat, goal_fiber,
              goal_water, changed_at
       FROM macro_target_history WHERE user_id = ANY($1) ORDER BY changed_at`,
      [userIds],
    ),
  ]).then(results => results.map(r => r.rows))

  const healthByUser = new Map(healthAssessments.map(h => [h.user_id, h]))
  const dailyLogsByUser = groupBy(dailyLogs, 'user_id')
  const mealsByUser = groupBy(meals, 'user_id')
  const customFoodsByUser = groupBy(customFoods, 'user_id')
  const workoutsByUser = groupBy(workouts, 'user_id')
  const workoutExercisesByWorkout = groupBy(workoutExercises, 'workout_id')
  const workoutLogsByUser = groupBy(workoutLogs, 'user_id')
  const habitsByUser = groupBy(habits, 'user_id')
  const habitCompletionsByHabit = groupBy(habitCompletions, 'habit_id')
  const progressPhotosByUser = groupBy(progressPhotos, 'user_id')
  const macroHistoryByUser = groupBy(macroHistory, 'user_id')

  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  const exported = []
  const usersMissingHealthAssessment = []
  const usersWithNoMeals = []

  for (const u of users) {
    const h = healthByUser.get(u.id) ?? null
    if (!h) usersMissingHealthAssessment.push({ id: u.id, email: u.email })

    const userMeals = mealsByUser.get(u.id) ?? []
    if (userMeals.length === 0) usersWithNoMeals.push({ id: u.id, email: u.email })

    const record = {
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      phone: u.phone_number,
      coaching_type: u.coaching_type,
      start_date: u.start_date,
      created_at: u.created_at,
      client_status: u.client_status,
      health_assessment: h && {
        address: {
          street: h.street_address,
          city: h.city,
          state: h.state,
          zip: h.zip_code,
          country: h.country,
        },
        date_of_birth: h.date_of_birth,
        shirt_size: h.shirt_size,
        supplements: h.supplements,
        six_month_goals: h.goals_6_months,
        injuries_limitations: h.injuries_limitations,
        occupation: h.occupation,
        energy: h.energy_level,
        sleep_hours: h.sleep_hours,
        sleep_quality: h.sleep_quality,
        stress: h.stress_management,
        water_intake: h.daily_water,
        alcohol_weekday: h.alcohol_weekdays,
        alcohol_weekend: h.alcohol_weekends,
        activity_level: h.activity_level,
      },
      daily_logs: (dailyLogsByUser.get(u.id) ?? []).map(d => ({
        date: d.logged_date,
        weight: d.weight_lbs,
        steps: d.steps,
        water: d.water_oz,
      })),
      meals: userMeals.map(m => ({
        date: m.log_date,
        meal_name: m.meal_name,
        calories: m.calories,
        protein: m.protein,
        carbs: m.carbs,
        fat: m.fat,
        meal_category: m.meal_slot,
      })),
      custom_foods: (customFoodsByUser.get(u.id) ?? []).map(f => ({
        food_name: f.food_name,
        calories_per_serving: f.calories_per_serving,
        protein: f.protein,
        carbs: f.carbs,
        fat: f.fat,
        serving_size: f.serving_size,
        serving_unit: f.serving_unit,
        created_at: f.created_at,
      })),
      workouts: (workoutsByUser.get(u.id) ?? []).map(w => ({
        id: w.id,
        name: w.name,
        description: w.description,
        status: w.status,
        created_at: w.created_at,
        exercises: (workoutExercisesByWorkout.get(w.id) ?? []).map(e => ({
          day: e.day,
          exercise_name: e.exercise_name,
          sets: e.sets,
          reps: e.reps,
          rest_seconds: e.rest_seconds,
          weight: e.weight,
          notes: e.notes,
          section_name: e.section_name,
          day_focus: e.day_focus,
        })),
      })),
      workout_logs: (workoutLogsByUser.get(u.id) ?? []).map(l => ({
        workout_id: l.workout_id,
        completed_at: l.completed_at,
        scheduled_date: l.scheduled_date,
        notes: l.notes,
      })),
      habits: (habitsByUser.get(u.id) ?? []).map(h2 => ({
        habit_name: h2.habit_name,
        habit_type: h2.habit_type,
        target_value: h2.target_value,
        unit: h2.unit,
        frequency: h2.frequency,
        start_date: h2.start_date,
        end_date: h2.end_date,
        days_of_week: h2.days_of_week,
        active: h2.active,
        completions: (habitCompletionsByHabit.get(h2.id) ?? []).map(c => ({
          date: c.completion_date,
          completed_value: c.completed_value,
          target_value: c.target_value,
          completion_percentage: c.completion_percentage,
          status: c.status,
        })),
      })),
      progress_photos: (progressPhotosByUser.get(u.id) ?? []).map(p => ({
        url: p.photo_url,
        angle: p.angle,
        date: p.taken_at,
      })),
      macro_target_history: (macroHistoryByUser.get(u.id) ?? []).map(m => ({
        date: m.changed_at,
        goal_calories: m.goal_calories,
        goal_protein: m.goal_protein,
        goal_carbs: m.goal_carbs,
        goal_fat: m.goal_fat,
        goal_fiber: m.goal_fiber,
        goal_water: m.goal_water,
      })),
    }

    exported.push(record)
    await fs.writeFile(
      path.join(OUTPUT_DIR, `${u.id}.json`),
      JSON.stringify(record, null, 2),
    )
  }

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'users-export.json'),
    JSON.stringify(exported, null, 2),
  )

  console.log('=== Export summary ===')
  console.log(`Total rows in users table: ${totalUserCount}`)
  console.log(`Users exported: ${exported.length}`)
  console.log(`Users skipped (deactivated/deleted, --include-inactive not passed): ${totalUserCount - exported.length}`)
  console.log(`Users missing health_assessments: ${usersMissingHealthAssessment.length}`)
  if (usersMissingHealthAssessment.length > 0) {
    console.log('  ' + usersMissingHealthAssessment.map(u => `#${u.id} (${u.email})`).join(', '))
  }
  console.log(`Users with zero meals logged: ${usersWithNoMeals.length}`)
  if (usersWithNoMeals.length > 0) {
    console.log('  ' + usersWithNoMeals.map(u => `#${u.id} (${u.email})`).join(', '))
  }
  console.log(`\nOutput written to: ${OUTPUT_DIR}`)

  await pool.end()
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
