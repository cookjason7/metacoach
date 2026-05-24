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
              gender, phone_number, paid, role, coaching_type, coaching_type_source,
              bloodwork_enabled, food_dislikes, food_allergies
       FROM users WHERE id = $1`,
      [dbUserId],
    )

    const originalCoachingType = rows[0]?.coaching_type
    let robustAiSelfHealRan = false
    const canAiSelfHeal = rows[0]
      && rows[0].coaching_type !== 'ai'
      && rows[0].coaching_type_source !== 'manual'

    // Self-heal: if the user accepted an AI invite but coaching_type wasn't updated
    // (e.g. invite accept failed silently on an older deploy), fix it now.
    if (canAiSelfHeal) {
      const { rows: aiInvite } = await pool.query(
        `SELECT 1 FROM client_invites
         WHERE accepted_by_user_id = $1 AND coaching_type = 'ai'
         LIMIT 1`,
        [dbUserId],
      )
      if (aiInvite.length > 0) {
        await pool.query(
          `UPDATE users SET coaching_type = 'ai', coaching_type_source = COALESCE(coaching_type_source, 'self_heal_ai') WHERE id = $1`,
          [dbUserId],
        )
        rows[0].coaching_type = 'ai'
        rows[0].coaching_type_source = rows[0].coaching_type_source ?? 'self_heal_ai'
        console.log(`[users/me] self-healed coaching_type → 'ai' for user id=${dbUserId}`)
      }
    }

    // Debug logging — confirms admin status at runtime
    if (rows[0] && rows[0].coaching_type !== 'ai' && rows[0].coaching_type_source !== 'manual') {
      const normalizedEmail = (email ?? rows[0].email ?? '').trim().toLowerCase()
      const { rows: aiInviteByEmail } = await pool.query(
        `SELECT id FROM client_invites
         WHERE coaching_type = 'ai'
           AND $1 != ''
           AND LOWER(email) = $1
         ORDER BY accepted_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [normalizedEmail],
      )
      if (aiInviteByEmail.length > 0) {
        await pool.query(
          `UPDATE users SET coaching_type = 'ai', coaching_type_source = COALESCE(coaching_type_source, 'self_heal_ai') WHERE id = $1`,
          [dbUserId],
        )
        rows[0].coaching_type = 'ai'
        rows[0].coaching_type_source = rows[0].coaching_type_source ?? 'self_heal_ai'
        robustAiSelfHealRan = true
      }
    }

    console.log(
      `[users/me] email=${email ?? rows[0]?.email ?? '?'} role=${rows[0]?.role} coaching_type=${rows[0]?.coaching_type} coaching_type_source=${rows[0]?.coaching_type_source ?? 'none'} selfHealRan=${originalCoachingType !== rows[0]?.coaching_type || robustAiSelfHealRan} isAdmin=${rows[0]?.role === 'admin'} isAllowlistEmail=${isAdminEmail(email)}`,
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
      food_dislikes, food_allergies,
    } = req.body

    // food_dislikes and food_allergies use explicit-flag pattern so an empty string
    // can clear the field (COALESCE can't distinguish "not sent" from "send null").
    const hasDislikes  = Object.hasOwn(req.body, 'food_dislikes')
    const hasAllergies = Object.hasOwn(req.body, 'food_allergies')

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
         phone_number        = COALESCE($13, phone_number),
         food_dislikes  = CASE WHEN $14 THEN $15 ELSE food_dislikes  END,
         food_allergies = CASE WHEN $16 THEN $17 ELSE food_allergies END
       WHERE id = $18
       RETURNING *`,
      [
        first_name || null, last_name || null, age ?? null, height_inches ?? null,
        starting_weight_lbs ?? null, goal_weight_lbs ?? null,
        activity_level ?? null, tried_before ?? null, why_joined ?? null,
        identity_anchors ?? null, onboarding_complete ?? null,
        gender ?? null, phone_number ?? null,
        hasDislikes,  food_dislikes  !== undefined ? (food_dislikes?.trim()  || null) : null,
        hasAllergies, food_allergies !== undefined ? (food_allergies?.trim() || null) : null,
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
