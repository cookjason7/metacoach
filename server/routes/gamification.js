import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'
import { RANKS, BADGE_DEFS, getRankForXP, getNextRank } from '../gamification.js'

const router = Router()

// GET /api/gamification/me — rank, XP, streaks, recent badges
router.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)

    // XP
    const { rows: xpRows } = await pool.query(
      'SELECT total_xp FROM user_xp WHERE user_id=$1',
      [dbUserId],
    )
    const totalXP    = xpRows[0]?.total_xp ?? 0
    const rank       = getRankForXP(totalXP)
    const nextRankDef = getNextRank(totalXP)

    const progressPct = nextRankDef
      ? Math.round(((totalXP - rank.min) / (nextRankDef.min - rank.min)) * 100)
      : 100

    // Streaks
    const { rows: sRows } = await pool.query(
      'SELECT streak_type, current_streak FROM user_streaks WHERE user_id=$1',
      [dbUserId],
    )
    const streaks = Object.fromEntries(sRows.map(r => [r.streak_type, r.current_streak]))

    // Recent badges (last 3)
    const { rows: badgeRows } = await pool.query(
      'SELECT badge_id, earned_at FROM user_badges WHERE user_id=$1 ORDER BY earned_at DESC LIMIT 3',
      [dbUserId],
    )
    const recentBadges = badgeRows.map(r => ({
      badge_id:  r.badge_id,
      earned_at: r.earned_at,
      ...(BADGE_DEFS[r.badge_id] ?? { name: r.badge_id, icon: '🏅', category: 'Unknown', desc: '' }),
    }))

    const { rows: cntRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM user_badges WHERE user_id=$1',
      [dbUserId],
    )

    res.json({
      total_xp:        totalXP,
      rank:            rank.name,
      rank_icon:       rank.icon,
      rank_color:      rank.color,
      rank_bg:         rank.bg,
      next_rank:       nextRankDef?.name ?? null,
      next_rank_xp:    nextRankDef?.min  ?? null,
      xp_to_next_rank: nextRankDef ? nextRankDef.min - totalXP : 0,
      progress_pct:    progressPct,
      streaks: {
        food_log:     streaks.food_log     ?? 0,
        water_goal:   streaks.water_goal   ?? 0,
        protein_goal: streaks.protein_goal ?? 0,
        workout:      streaks.workout      ?? 0,
      },
      recent_badges: recentBadges,
      badges_count:  cntRows[0].count,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/gamification/badges — all badge definitions with earned status
router.get('/badges', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)

    const { rows: earnedRows } = await pool.query(
      'SELECT badge_id, earned_at FROM user_badges WHERE user_id=$1',
      [dbUserId],
    )
    const earnedMap = Object.fromEntries(earnedRows.map(r => [r.badge_id, r.earned_at]))

    const badges = Object.entries(BADGE_DEFS).map(([id, def]) => ({
      badge_id:  id,
      ...def,
      earned:    !!earnedMap[id],
      earned_at: earnedMap[id] ?? null,
    }))

    res.json(badges)
  } catch (err) {
    next(err)
  }
})

// ─── Identity stage helper ────────────────────────────────────────────────────

function getIdentityStage(activeWeeks, isComeback) {
  if (isComeback) return {
    stage: 'Resilient Warrior',
    desc:  'Coming back is a choice — and you made it. That\'s self-trust in action.',
  }
  if (activeWeeks >= 10) return {
    stage: 'Life Warrior',
    desc:  'Consistency is no longer a goal. It\'s who you are.',
  }
  if (activeWeeks >= 7) return {
    stage: 'Consistency Warrior',
    desc:  'You show up even when it\'s hard. That\'s your identity now.',
  }
  if (activeWeeks >= 4) return {
    stage: 'Self-Trust Builder',
    desc:  'Every week you follow through, you trust yourself a little more.',
  }
  if (activeWeeks >= 2) return {
    stage: 'Momentum Builder',
    desc:  'You\'re building something real, one week at a time.',
  }
  return {
    stage: 'Starting Strong',
    desc:  'Every Life Warrior starts with a single consistent week. This is yours.',
  }
}

// GET /api/gamification/momentum — weekly identity momentum (5 pillars)
router.get('/momentum', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId   = await getOrCreateUser(userId)

    // Monday midnight UTC as week start
    const now       = new Date()
    const weekStart = new Date(now)
    weekStart.setUTCHours(0, 0, 0, 0)
    const daysFromMon = (weekStart.getUTCDay() + 6) % 7
    weekStart.setUTCDate(weekStart.getUTCDate() - daysFromMon)

    // Last week start (7 days prior) — used for comeback detection
    const lastWeekStart = new Date(weekStart)
    lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7)

    // 12 weeks ago — used for identity stage
    const twelveWeeksAgo = new Date(weekStart)
    twelveWeeksAgo.setUTCDate(twelveWeeksAgo.getUTCDate() - 84)

    const { rows: [row] } = await pool.query(`
      SELECT
        -- Food Tracking: meals logged on 3+ distinct days this week
        -- OR a food_tracking habit completed this week
        (
          (SELECT COUNT(DISTINCT COALESCE(log_date, logged_at::date))
           FROM meals WHERE user_id=$1 AND COALESCE(log_date, logged_at::date) >= $2::date) >= 3
          OR EXISTS (
            SELECT 1 FROM habit_completions hc
            JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'food_tracking'
          )
        ) AS food_tracking,
        -- Movement: 1+ workout OR steps logged on 3+ days this week
        -- OR a movement habit completed this week
        (
          (SELECT COUNT(*) FROM workout_logs WHERE user_id=$1 AND completed_at >= $2) > 0
          OR (SELECT COUNT(*) FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL AND logged_date >= $2::date) >= 3
          OR EXISTS (
            SELECT 1 FROM habit_completions hc
            JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'movement'
          )
        ) AS movement,
        -- Mindset: watched 50%+ of a published mindset video this week
        -- OR a mindset habit completed this week
        (
          EXISTS (
            SELECT 1 FROM video_watch_progress vwp
            JOIN mindset_videos mv ON mv.id = vwp.video_id
            WHERE vwp.user_id=$1
              AND vwp.highest_pct >= 50
              AND vwp.last_watched_at >= $2
              AND mv.published = TRUE
          )
          OR EXISTS (
            SELECT 1 FROM habit_completions hc
            JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1
              AND hc.completion_date >= $2::date
              AND cah.identity_category = 'mindset'
          )
        ) AS mindset,
        -- Check-Ins: form submitted this week OR a check_ins-category habit completed this week
        (
          (SELECT COUNT(*) FROM form_submissions WHERE user_id=$1 AND submitted_at >= $2) > 0
          OR EXISTS (
            SELECT 1 FROM habit_completions hc
            JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1
              AND hc.completion_date >= $2::date
              AND cah.identity_category = 'check_ins'
          )
        ) AS check_ins,
        -- Progress: weight logged OR progress photo this week
        -- OR a progress habit completed this week
        (
          (SELECT COUNT(*) FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL AND logged_date >= $2::date) > 0
          OR (SELECT COUNT(*) FROM progress_photos WHERE user_id=$1 AND taken_at >= $2) > 0
          OR EXISTS (
            SELECT 1 FROM habit_completions hc
            JOIN coach_assigned_habits cah ON cah.id = hc.habit_id
            WHERE hc.user_id=$1 AND hc.completion_date >= $2::date AND cah.identity_category = 'progress'
          )
        ) AS progress
    `, [dbUserId, weekStart.toISOString()])

    const categories = [
      { key: 'food_tracking', label: 'Food Tracking', icon: '🍽️', active: row.food_tracking },
      { key: 'movement',      label: 'Movement',      icon: '🏃',  active: row.movement      },
      { key: 'mindset',       label: 'Mindset',       icon: '🧠',  active: row.mindset       },
      { key: 'check_ins',     label: 'Check-Ins',     icon: '📋',  active: row.check_ins     },
      { key: 'progress',      label: 'Progress',      icon: '📊',  active: row.progress      },
    ]

    const activeCount = categories.filter(c => c.active).length

    // How many weeks in the past 12 (before this week) had any meal activity?
    // Uses day-of-week floor to Monday (avoids TIMESTAMPTZ expression index issues).
    const { rows: [wkRow] } = await pool.query(`
      SELECT COUNT(DISTINCT
        COALESCE(log_date, logged_at::date)
        - ((EXTRACT(DOW FROM COALESCE(log_date, logged_at::date))::int + 6) % 7)
      ) AS active_weeks
      FROM meals
      WHERE user_id = $1
        AND COALESCE(log_date, logged_at::date) >= $2::date
        AND COALESCE(log_date, logged_at::date) <  $3::date
    `, [dbUserId, twelveWeeksAgo.toISOString(), weekStart.toISOString()])
    const activeWeeks = parseInt(wkRow.active_weeks, 10) || 0

    // Did the user have any meals last week? (comeback check)
    const { rows: [lwRow] } = await pool.query(`
      SELECT COUNT(*) AS meal_count
      FROM meals
      WHERE user_id = $1
        AND COALESCE(log_date, logged_at::date) >= $2::date
        AND COALESCE(log_date, logged_at::date) <  $3::date
    `, [dbUserId, lastWeekStart.toISOString(), weekStart.toISOString()])
    const lastWeekMeals = parseInt(lwRow.meal_count, 10) || 0

    // Comeback: had history (≥1 active week), went quiet last week, back this week
    const isComeback = activeWeeks >= 1 && lastWeekMeals === 0 && activeCount >= 2

    const stageInfo = getIdentityStage(activeWeeks, isComeback)

    const LABELS = ['Fresh Start', 'Showing Up', 'Showing Up', 'Building Rhythm', 'Steady Momentum', 'Anchored Week']
    const MESSAGES = [
      'Every week is a new beginning. One small step counts.',
      "You're here. That's what matters most.",
      "You're here. That's what matters most.",
      "Three pillars this week. You're finding your flow.",
      "Four strong pillars. You're building something real.",
      'All five pillars. This is your identity in action.',
    ]

    res.json({
      categories,
      active_count:      activeCount,
      identity_label:    LABELS[activeCount],
      message:           MESSAGES[activeCount],
      identity_stage:    stageInfo.stage,
      stage_description: stageInfo.desc,
      active_weeks:      activeWeeks,
      is_comeback:       isComeback,
      comeback_message:  isComeback
        ? "You're rebuilding momentum. This is exactly how self-trust comes back."
        : null,
    })
  } catch (err) {
    next(err)
  }
})

export default router
