/**
 * gamification.js — XP, rank, streak, and badge engine.
 *
 * All public functions accept `pool` as their first parameter so they can be
 * imported by any route without circular-dependency issues.
 *
 * Design rules:
 *  - awardAction() is safe to call multiple times; dedup is enforced in code.
 *  - All functions are non-throwing (catch at call site if you need it).
 *  - Routes call these fire-and-forget with .catch(console.error) so a
 *    gamification error never fails the main request.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const XP_VALUES = {
  food_log:     10,
  protein_goal: 20,
  water_goal:   15,
  workout:      20,
  full_day:     25,
}

export const RANKS = [
  { name: 'Recruit',       min: 0,    max: 499,      icon: '⚔️',  color: '#6B7280', bg: '#F9FAFB' },
  { name: 'Warrior',       min: 500,  max: 1499,     icon: '🏆',  color: '#E8670A', bg: '#FFF7ED' },
  { name: 'Elite Warrior', min: 1500, max: 3499,     icon: '⭐',  color: '#7C3AED', bg: '#F5F3FF' },
  { name: 'Life Warrior',  min: 3500, max: Infinity, icon: '💎',  color: '#0284C7', bg: '#F0F9FF' },
]

export const BADGE_DEFS = {
  // Logging
  first_food:       { name: 'First Food Logged',              icon: '🍽️', category: 'Logging',  desc: 'Log your very first meal' },
  food_streak_7:    { name: '7-Day Logging Streak',           icon: '🔥', category: 'Logging',  desc: 'Log food 7 days in a row' },
  food_streak_30:   { name: '30-Day Logging Streak',          icon: '🔥', category: 'Logging',  desc: 'Log food 30 days in a row' },
  full_day_logged:  { name: 'Full Day Logged',                icon: '📋', category: 'Logging',  desc: 'Log breakfast, lunch, and dinner in one day' },
  // Protein
  protein_streak_3: { name: 'Protein Goal: 3 Days in a Row',  icon: '💪', category: 'Protein',  desc: 'Hit your protein goal 3 days in a row' },
  protein_streak_7: { name: 'Protein Goal: 7 Days in a Row',  icon: '💪', category: 'Protein',  desc: 'Hit your protein goal 7 days in a row' },
  // Water
  water_streak_3:   { name: 'Water Goal: 3 Days in a Row',    icon: '💧', category: 'Water',    desc: 'Hit your water goal 3 days in a row' },
  water_streak_7:   { name: 'Water Goal: 7 Days in a Row',    icon: '💧', category: 'Water',    desc: 'Hit your water goal 7 days in a row' },
  // Workouts
  first_workout:    { name: 'First Workout Logged',           icon: '🏋️', category: 'Workouts', desc: 'Complete your first logged workout' },
  workout_streak_3: { name: '3-Week Workout Streak',          icon: '🏋️', category: 'Workouts', desc: 'Log a workout 3 weeks in a row' },
  // Ranks
  rank_warrior:     { name: 'Reached Warrior Rank',           icon: '🏆', category: 'Ranks',    desc: 'Earn 500 total XP' },
  rank_elite:       { name: 'Reached Elite Warrior',          icon: '⭐', category: 'Ranks',    desc: 'Earn 1,500 total XP' },
  rank_life:        { name: 'Reached Life Warrior',           icon: '💎', category: 'Ranks',    desc: 'Earn 3,500 total XP' },
}

// ── Rank helpers ──────────────────────────────────────────────────────────────

export function getRankForXP(xp) {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (xp >= RANKS[i].min) return RANKS[i]
  }
  return RANKS[0]
}

export function getNextRank(xp) {
  return RANKS.find(r => r.min > xp) ?? null
}

// ── Week counter (Monday-anchored) ────────────────────────────────────────────

function weeksSinceEpoch(dateStr) {
  // Treat Monday as the start of each week.
  // Shift epoch by 3 days so that 1970-01-01 (a Thursday) maps to week 0.
  const d = new Date(dateStr + 'T00:00:00Z')
  return Math.floor((d.getTime() + 3 * 86_400_000) / (7 * 86_400_000))
}

// ── Core award function ───────────────────────────────────────────────────────

/**
 * Award XP for `actionType` on `dateStr`, update the streak, check badges.
 *
 * Per spec, workout XP is NOT deduped (you can earn 20 XP per workout logged).
 * All other actions are deduped: one award per (user, action, day).
 *
 * Returns { xpAwarded, newTotalXP, rank, newBadges } or null if already logged.
 */
export async function awardAction(pool, dbUserId, actionType, dateStr) {
  const xpAmount = XP_VALUES[actionType]
  if (!xpAmount) return null

  const today = dateStr ?? new Date().toISOString().slice(0, 10)

  // ── 1. Dedup guard (non-workout) ─────────────────────────────────────────
  if (actionType !== 'workout') {
    const { rows } = await pool.query(
      'SELECT id FROM xp_log WHERE user_id=$1 AND action_type=$2 AND earned_date=$3::date',
      [dbUserId, actionType, today],
    )
    if (rows.length > 0) return null
  }

  // ── 2. Log the award ─────────────────────────────────────────────────────
  await pool.query(
    'INSERT INTO xp_log (user_id, action_type, xp_earned, earned_date) VALUES ($1,$2,$3,$4::date)',
    [dbUserId, actionType, xpAmount, today],
  )

  // ── 3. Upsert user_xp ────────────────────────────────────────────────────
  const { rows: xpRows } = await pool.query(
    `INSERT INTO user_xp (user_id, total_xp)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET total_xp = user_xp.total_xp + $2, updated_at = NOW()
     RETURNING total_xp`,
    [dbUserId, xpAmount],
  )
  const newTotalXP = xpRows[0].total_xp
  const rank = getRankForXP(newTotalXP)

  await pool.query(
    'UPDATE user_xp SET current_rank=$1 WHERE user_id=$2',
    [rank.name, dbUserId],
  )

  // ── 4. Update streak ─────────────────────────────────────────────────────
  const { rows: sRows } = await pool.query(
    'SELECT current_streak, last_log_date FROM user_streaks WHERE user_id=$1 AND streak_type=$2',
    [dbUserId, actionType],
  )

  let newStreak = 1
  if (sRows.length > 0) {
    const { current_streak, last_log_date } = sRows[0]
    const lastDate = last_log_date
      ? new Date(last_log_date).toISOString().slice(0, 10)
      : null

    if (actionType === 'workout') {
      const curWeek  = weeksSinceEpoch(today)
      const lastWeek = lastDate ? weeksSinceEpoch(lastDate) : null
      if (lastWeek === curWeek)     newStreak = current_streak          // already this week
      else if (lastWeek === curWeek - 1) newStreak = current_streak + 1 // consecutive week
      else                          newStreak = 1                       // gap
    } else {
      const todayD   = new Date(today + 'T00:00:00Z')
      const yesterday = new Date(todayD.getTime() - 86_400_000).toISOString().slice(0, 10)
      if (lastDate === today)     newStreak = current_streak          // already today
      else if (lastDate === yesterday) newStreak = current_streak + 1  // consecutive day
      else                        newStreak = 1                       // gap
    }
  }

  await pool.query(
    `INSERT INTO user_streaks (user_id, streak_type, current_streak, last_log_date)
     VALUES ($1,$2,$3,$4::date)
     ON CONFLICT (user_id, streak_type) DO UPDATE
       SET current_streak=$3, last_log_date=$4::date`,
    [dbUserId, actionType, newStreak, today],
  )

  // ── 5. Check and award badges ─────────────────────────────────────────────
  const newBadges = await checkBadges(pool, dbUserId, newTotalXP)

  return { xpAwarded: xpAmount, newTotalXP, rank: rank.name, newBadges }
}

// ── Badge checker ─────────────────────────────────────────────────────────────

export async function checkBadges(pool, dbUserId, totalXP) {
  // Fetch already-earned badges
  const { rows: earnedRows } = await pool.query(
    'SELECT badge_id FROM user_badges WHERE user_id=$1',
    [dbUserId],
  )
  const earned = new Set(earnedRows.map(r => r.badge_id))

  // Fetch streaks
  const { rows: sRows } = await pool.query(
    'SELECT streak_type, current_streak FROM user_streaks WHERE user_id=$1',
    [dbUserId],
  )
  const streaks = Object.fromEntries(sRows.map(r => [r.streak_type, r.current_streak]))

  // Resolve total XP if not passed
  if (totalXP == null) {
    const { rows } = await pool.query('SELECT total_xp FROM user_xp WHERE user_id=$1', [dbUserId])
    totalXP = rows[0]?.total_xp ?? 0
  }

  const toAward = []

  // Logging
  if (!earned.has('first_food')) {
    const { rows } = await pool.query('SELECT id FROM meals WHERE user_id=$1 LIMIT 1', [dbUserId])
    if (rows.length) toAward.push('first_food')
  }
  if (!earned.has('food_streak_7')  && (streaks.food_log ?? 0) >= 7)  toAward.push('food_streak_7')
  if (!earned.has('food_streak_30') && (streaks.food_log ?? 0) >= 30) toAward.push('food_streak_30')
  if (!earned.has('full_day_logged')) {
    const { rows } = await pool.query(
      "SELECT id FROM xp_log WHERE user_id=$1 AND action_type='full_day' LIMIT 1",
      [dbUserId],
    )
    if (rows.length) toAward.push('full_day_logged')
  }

  // Protein
  if (!earned.has('protein_streak_3') && (streaks.protein_goal ?? 0) >= 3) toAward.push('protein_streak_3')
  if (!earned.has('protein_streak_7') && (streaks.protein_goal ?? 0) >= 7) toAward.push('protein_streak_7')

  // Water
  if (!earned.has('water_streak_3') && (streaks.water_goal ?? 0) >= 3) toAward.push('water_streak_3')
  if (!earned.has('water_streak_7') && (streaks.water_goal ?? 0) >= 7) toAward.push('water_streak_7')

  // Workouts
  if (!earned.has('first_workout')) {
    const { rows } = await pool.query('SELECT id FROM workout_logs WHERE user_id=$1 LIMIT 1', [dbUserId])
    if (rows.length) toAward.push('first_workout')
  }
  if (!earned.has('workout_streak_3') && (streaks.workout ?? 0) >= 3) toAward.push('workout_streak_3')

  // Ranks
  if (!earned.has('rank_warrior') && totalXP >= 500)  toAward.push('rank_warrior')
  if (!earned.has('rank_elite')   && totalXP >= 1500) toAward.push('rank_elite')
  if (!earned.has('rank_life')    && totalXP >= 3500) toAward.push('rank_life')

  for (const badgeId of toAward) {
    await pool.query(
      'INSERT INTO user_badges (user_id, badge_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [dbUserId, badgeId],
    )
  }

  return toAward
}

// ── Side-effect checks called from other routes ───────────────────────────────

/**
 * Award full_day XP if breakfast + lunch + dinner all have at least one item
 * on the given date.
 */
export async function checkFullDay(pool, dbUserId, dateStr) {
  const { rows } = await pool.query(
    `SELECT DISTINCT meal_slot FROM meals
     WHERE user_id=$1
       AND COALESCE(log_date, logged_at::date) = $2::date
       AND meal_slot IN ('Breakfast','Lunch','Dinner')`,
    [dbUserId, dateStr],
  )
  const slots = new Set(rows.map(r => r.meal_slot))
  if (slots.has('Breakfast') && slots.has('Lunch') && slots.has('Dinner')) {
    await awardAction(pool, dbUserId, 'full_day', dateStr)
  }
}

/**
 * Award protein_goal XP if today's total protein >= user's goal.
 */
export async function checkProteinGoal(pool, dbUserId, dateStr) {
  const { rows: uRows } = await pool.query('SELECT goal_protein FROM users WHERE id=$1', [dbUserId])
  const goal = uRows[0]?.goal_protein
  if (!goal) return

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(protein),0) AS total FROM meals
     WHERE user_id=$1 AND COALESCE(log_date, logged_at::date) = $2::date`,
    [dbUserId, dateStr],
  )
  if (parseFloat(rows[0].total) >= goal) {
    await awardAction(pool, dbUserId, 'protein_goal', dateStr)
  }
}

/**
 * Award water_goal XP if today's logged water_oz >= 64 oz (8 cups standard goal).
 */
export async function checkWaterGoal(pool, dbUserId, waterOz, dateStr) {
  const WATER_GOAL_OZ = 64
  if (parseFloat(waterOz) >= WATER_GOAL_OZ) {
    await awardAction(pool, dbUserId, 'water_goal', dateStr)
  }
}
