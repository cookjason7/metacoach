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

    const { rows: [row] } = await pool.query(`
      SELECT
        (
          SELECT COUNT(DISTINCT COALESCE(log_date, logged_at::date))
          FROM meals WHERE user_id=$1 AND COALESCE(log_date, logged_at::date) >= $2::date
        ) >= 3 AS nourishment,
        (
          (SELECT COUNT(*) FROM workout_logs WHERE user_id=$1 AND completed_at >= $2) > 0
          OR
          (SELECT COUNT(*) FROM daily_logs WHERE user_id=$1 AND steps IS NOT NULL AND logged_date >= $2::date) >= 3
        ) AS movement,
        (
          (SELECT COUNT(*) FROM form_submissions WHERE user_id=$1 AND submitted_at >= $2) > 0
          OR
          (SELECT COUNT(*) FROM habit_completions WHERE user_id=$1 AND completion_date >= $2::date) > 0
        ) AS reflection,
        (
          (SELECT COUNT(*) FROM client_messages WHERE sender_id=$1 AND sender_role='client' AND created_at >= $2) > 0
          OR
          (SELECT COUNT(*) FROM community_posts WHERE user_id=$1 AND created_at >= $2) > 0
          OR
          (SELECT COUNT(*) FROM post_comments WHERE user_id=$1 AND created_at >= $2) > 0
        ) AS connection,
        (
          (SELECT COUNT(*) FROM daily_logs WHERE user_id=$1 AND weight_lbs IS NOT NULL AND logged_date >= $2::date) > 0
          OR
          (SELECT COUNT(*) FROM progress_photos WHERE user_id=$1 AND taken_at >= $2) > 0
        ) AS progress
    `, [dbUserId, weekStart.toISOString()])

    const categories = [
      { key: 'nourishment', label: 'Nourishment', icon: '🥦', active: row.nourishment },
      { key: 'movement',    label: 'Movement',    icon: '🏃', active: row.movement    },
      { key: 'reflection',  label: 'Reflection',  icon: '📓', active: row.reflection  },
      { key: 'connection',  label: 'Connection',  icon: '💬', active: row.connection  },
      { key: 'progress',    label: 'Progress',    icon: '📊', active: row.progress    },
    ]

    const activeCount = categories.filter(c => c.active).length

    const LABELS = ['Fresh Start', 'Showing Up', 'Showing Up', 'Building Rhythm', 'Steady Momentum', 'Anchored Week']
    const MESSAGES = [
      'Every week is a new beginning. One small step counts.',
      "You're here. That's what matters most.",
      "You're here. That's what matters most.",
      'Three pillars this week. You\'re finding your flow.',
      'Four strong pillars. You\'re building something real.',
      'All five pillars. This is your identity in action.',
    ]

    res.json({
      categories,
      active_count:   activeCount,
      identity_label: LABELS[activeCount],
      message:        MESSAGES[activeCount],
    })
  } catch (err) {
    next(err)
  }
})

export default router
