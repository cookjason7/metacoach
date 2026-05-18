import { Router } from 'express'
import { requireAuth, getAuth, clerkClient } from '@clerk/express'
import { pool, getOrCreateUser, isAdminEmail } from '../db.js'

const router = Router()

// Best-effort fetch of the authenticated user's primary email from Clerk.
// Returns null on any failure so the route still succeeds.
async function fetchClerkEmail(clerkUserId) {
  try {
    const u = await clerkClient.users.getUser(clerkUserId)
    return (
      u?.primaryEmailAddress?.emailAddress ??
      u?.emailAddresses?.[0]?.emailAddress ??
      null
    )
  } catch (err) {
    console.warn('[users/me] failed to fetch Clerk email:', err.message)
    return null
  }
}

// GET /api/users/me
router.get('/me', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    // Fetch Clerk email so getOrCreateUser can backfill + auto-promote admin
    const email = await fetchClerkEmail(userId)
    const dbUserId = await getOrCreateUser(userId, email)

    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, age, height_inches, starting_weight_lbs, goal_weight_lbs,
              activity_level, tried_before, why_joined, identity_anchors,
              onboarding_complete, assessment_complete,
              goal_calories, goal_protein, goal_carbs, goal_fat, goal_fiber, goal_water,
              gender, phone_number, paid, role, coaching_type
       FROM users WHERE id = $1`,
      [dbUserId],
    )

    // Self-heal: if the user accepted an AI invite but coaching_type wasn't updated
    // (e.g. invite accept failed silently on an older deploy), fix it now.
    if (rows[0] && rows[0].coaching_type !== 'ai') {
      const { rows: aiInvite } = await pool.query(
        `SELECT 1 FROM client_invites
         WHERE accepted_by_user_id = $1 AND coaching_type = 'ai'
         LIMIT 1`,
        [dbUserId],
      )
      if (aiInvite.length > 0) {
        await pool.query(`UPDATE users SET coaching_type = 'ai' WHERE id = $1`, [dbUserId])
        rows[0].coaching_type = 'ai'
        console.log(`[users/me] self-healed coaching_type → 'ai' for user id=${dbUserId}`)
      }
    }

    // Debug logging — confirms admin status at runtime
    console.log(
      `[users/me] email=${email ?? '?'} role=${rows[0]?.role} isAdmin=${rows[0]?.role === 'admin'} isAllowlistEmail=${isAdminEmail(email)}`,
    )

    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/users/me
router.patch('/me', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const {
      first_name, last_name, age, height_inches, starting_weight_lbs, goal_weight_lbs,
      activity_level, tried_before, why_joined,
      identity_anchors, onboarding_complete, gender, phone_number,
    } = req.body

    const { rows } = await pool.query(
      `UPDATE users SET
         first_name          = COALESCE($1,  first_name),
         last_name           = COALESCE($2,  last_name),
         age                 = COALESCE($3,  age),
         height_inches       = COALESCE($4,  height_inches),
         starting_weight_lbs = COALESCE($5,  starting_weight_lbs),
         goal_weight_lbs     = COALESCE($6,  goal_weight_lbs),
         activity_level      = COALESCE($7,  activity_level),
         tried_before        = COALESCE($8,  tried_before),
         why_joined          = COALESCE($9,  why_joined),
         identity_anchors    = COALESCE($10, identity_anchors),
         onboarding_complete = COALESCE($11, onboarding_complete),
         gender              = COALESCE($12, gender),
         phone_number        = COALESCE($13, phone_number)
       WHERE id = $14
       RETURNING *`,
      [
        first_name ?? null, last_name ?? null, age ?? null, height_inches ?? null,
        starting_weight_lbs ?? null, goal_weight_lbs ?? null,
        activity_level ?? null, tried_before ?? null, why_joined ?? null,
        identity_anchors ?? null, onboarding_complete ?? null,
        gender ?? null, phone_number ?? null,
        dbUserId,
      ],
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// POST /api/users/me/activate — marks the current user as paid
router.post('/me/activate', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    // Capture activation moment so start_date can default to it
    await pool.query(
      `UPDATE users
       SET paid = TRUE,
           paid_at = COALESCE(paid_at, NOW())
       WHERE id = $1`,
      [dbUserId],
    )
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
