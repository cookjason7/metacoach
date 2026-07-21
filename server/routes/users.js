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
              bloodwork_enabled, food_dislikes, food_allergies,
              notif_master_enabled, notif_dm_enabled, notif_community_enabled
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
      // client_invites has no org_id column — scope via a join to the invite's
      // assigned coach/inviter org, same pattern as healthAssessment.js (bf7addf).
      // Prevents this self-heal from matching an AI invite meant for a different
      // org that happens to share this user's email. Super admin bypasses.
      const bypassOrgFilter = isAdminEmail(normalizedEmail)
      const orgFilter = bypassOrgFilter
        ? ''
        : ` AND COALESCE(invcoach.org_id, invstaff.org_id) = $2`
      const { rows: aiInviteByEmail } = await pool.query(
        `SELECT ci.id
         FROM client_invites ci
         LEFT JOIN users invcoach ON invcoach.id = ci.assigned_coach_id
         LEFT JOIN users invstaff ON invstaff.id = ci.invited_by
         WHERE ci.coaching_type = 'ai'
           AND $1 != ''
           AND LOWER(ci.email) = $1
           ${orgFilter}
         ORDER BY ci.accepted_at DESC NULLS LAST, ci.created_at DESC
         LIMIT 1`,
        bypassOrgFilter ? [normalizedEmail] : [normalizedEmail, req.orgId],
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
      notif_master_enabled, notif_dm_enabled, notif_community_enabled,
    } = req.body

    // food_dislikes and food_allergies use explicit-flag pattern so an empty string
    // can clear the field (COALESCE can't distinguish "not sent" from "send null").
    const hasDislikes  = Object.hasOwn(req.body, 'food_dislikes')
    const hasAllergies = Object.hasOwn(req.body, 'food_allergies')
    const hasNotifMaster    = Object.hasOwn(req.body, 'notif_master_enabled')
    const hasNotifDm        = Object.hasOwn(req.body, 'notif_dm_enabled')
    const hasNotifCommunity = Object.hasOwn(req.body, 'notif_community_enabled')

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
         food_dislikes           = CASE WHEN $14 THEN $15 ELSE food_dislikes  END,
         food_allergies          = CASE WHEN $16 THEN $17 ELSE food_allergies END,
         notif_master_enabled    = CASE WHEN $19 THEN $20 ELSE notif_master_enabled    END,
         notif_dm_enabled        = CASE WHEN $21 THEN $22 ELSE notif_dm_enabled        END,
         notif_community_enabled = CASE WHEN $23 THEN $24 ELSE notif_community_enabled END
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
        hasNotifMaster,    typeof notif_master_enabled    === 'boolean' ? notif_master_enabled    : null,
        hasNotifDm,        typeof notif_dm_enabled        === 'boolean' ? notif_dm_enabled        : null,
        hasNotifCommunity, typeof notif_community_enabled === 'boolean' ? notif_community_enabled : null,
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
