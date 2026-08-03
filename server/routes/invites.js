import { Router } from 'express'
import { requireAuth, getAuth, clerkClient } from '@clerk/express'
import { pool, getOrCreateUser, claimInvite } from '../db.js'

// Best-effort fetch of the authenticated user's primary email from Clerk.
// Times out after 5 s and returns null so the route still responds.
async function fetchClerkEmail(clerkUserId) {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Clerk API timeout')), 5_000),
    )
    const u = await Promise.race([clerkClient.users.getUser(clerkUserId), timeout])
    return (
      u?.primaryEmailAddress?.emailAddress ??
      u?.emailAddresses?.[0]?.emailAddress ??
      null
    )
  } catch (err) {
    console.warn('[invites] fetchClerkEmail failed:', err.message)
    return null
  }
}

const router = Router()

/**
 * A non-null `accepted_at` does NOT by itself mean the invite was consumed by
 * someone else. `client_invites.accepted_at` has three writers, and only one of
 * them is this file's explicit accept route:
 *
 *   1. claimInvite() via POST /:token/accept below — the intended path.
 *   2. getOrCreateUser()'s auto-claim (server/db.js, both the new-user and the
 *      pending_access branches) — fires as a side effect of the invited person's
 *      FIRST authenticated request, which happens *before* this route's own
 *      claimInvite() call ever runs.
 *   3. server/routes/healthAssessment.js's auto-close on assessment submission.
 *
 * So if writer #2 lands and the request is then interrupted (Clerk lookup
 * timeout in fetchClerkEmail, navigation away, network drop), the invite is left
 * stamped accepted while its rightful owner never got through — and every later
 * visit to their own link 410'd forever, with no recovery path. That is the bug
 * this guard fixes: it is the consumption layer that has to tolerate a claim it
 * may have made itself, rather than the writers being made stricter.
 *
 * Only a claim held by a demonstrably DIFFERENT email is genuinely invalid.
 * Anything not positively attributable to another person (no accepted_by_user_id,
 * a deleted claimant row, a blank email) is treated as self-claimed and allowed
 * through — the accept route still runs its own email-match check before
 * applying anything, so a real mismatch is caught there with a clearer 403.
 */
async function isClaimedByDifferentEmail(invite) {
  if (!invite.accepted_by_user_id) return false
  const { rows } = await pool.query(
    'SELECT email FROM users WHERE id = $1',
    [invite.accepted_by_user_id],
  )
  const claimantEmail = (rows[0]?.email ?? '').trim().toLowerCase()
  if (!claimantEmail) return false
  return claimantEmail !== (invite.email ?? '').trim().toLowerCase()
}

// GET /api/client-invites/:token — public, no auth required
// Returns invite details if the token is valid and still usable by its owner —
// see isClaimedByDifferentEmail for why "already accepted" is not the same as
// "accepted_at is set".
router.get('/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT token, email, first_name, last_name, coaching_type, expires_at, accepted_at, accepted_by_user_id
       FROM client_invites WHERE token = $1`,
      [req.params.token],
    )
    if (!rows.length) return res.status(404).json({ error: 'Invite not found. The link may be invalid.' })

    const invite = rows[0]
    const alreadyClaimed = !!invite.accepted_at
    if (alreadyClaimed && await isClaimedByDifferentEmail(invite)) {
      return res.status(410).json({ error: 'This invite has already been accepted.' })
    }
    // Expiry only bars an invite nobody has claimed yet. Once the invited person
    // has claimed it their account is already provisioned (claimInvite ran), so
    // lapsing afterwards must not lock them out of their own link a second time.
    if (!alreadyClaimed && invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return res.status(410).json({ error: 'This invite has expired. Please contact your coach.' })
    }

    res.json({
      first_name:    invite.first_name,
      last_name:     invite.last_name,
      email:         invite.email,
      coaching_type: invite.coaching_type,
    })
  } catch (err) { next(err) }
})

// POST /api/client-invites/:token/accept — requires Clerk auth
// Links the authenticated Clerk user to this invite, sets up their profile.
router.post('/:token/accept', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    const { rows: inviteRows } = await pool.query(
      `SELECT * FROM client_invites WHERE token = $1`,
      [req.params.token],
    )
    if (!inviteRows.length) return res.status(404).json({ error: 'Invite not found.' })

    const invite = inviteRows[0]
    // See isClaimedByDifferentEmail: accepted_at may well have been stamped by
    // this very user's own auto-claim moments ago, before this request ran.
    const alreadyClaimed = !!invite.accepted_at
    if (alreadyClaimed && await isClaimedByDifferentEmail(invite)) {
      return res.status(410).json({ error: 'This invite has already been accepted.' })
    }
    if (!alreadyClaimed && invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return res.status(410).json({ error: 'This invite has expired. Please contact your coach.' })
    }

    // Fetch user's Clerk email so we can both store it and check against invite.
    // New Clerk signups have no DB row yet — without this the row is inserted
    // with email = NULL, making the email-match check always fail.
    const clerkEmail = await fetchClerkEmail(userId)

    // Resolve DB user (creates row if first visit after signup, backfills email)
    const dbUserId = await getOrCreateUser(userId, clerkEmail)

    // Email must match — prevent invite hijacking.
    // Trust the Clerk-verified email; fall back to the DB email if Clerk lookup failed.
    const { rows: userRows } = await pool.query(
      'SELECT id, email, role, assessment_complete, client_status FROM users WHERE id = $1',
      [dbUserId],
    )
    const resolvedEmail = (clerkEmail ?? userRows[0]?.email ?? '').trim().toLowerCase()
    const inviteEmail   = invite.email.trim().toLowerCase()

    if (!resolvedEmail) {
      return res.status(400).json({
        error: 'Could not verify your email address. Please try again or contact support.',
      })
    }

    if (resolvedEmail !== inviteEmail) {
      return res.status(403).json({
        error: `This invite was sent to ${invite.email}. Please sign out and sign back in with that email address.`,
        invite_email: invite.email,
      })
    }

    // Never let an invite link reinstate a removed account. claimInvite() below
    // sets paid = TRUE and client_status = 'invited', so re-claiming would quietly
    // undo an admin's deactivate/delete. This mattered less while a claimed invite
    // always 410'd above; now that the owner can reach their own claimed link, an
    // explicit guard is required rather than relying on the assessment_complete
    // short-circuit below happening to cover it.
    const removedStatus = userRows[0]?.client_status
    if (removedStatus === 'deleted' || removedStatus === 'deactivated') {
      return res.status(403).json({
        error: 'This account is no longer active. Please contact your coach to be reinstated.',
      })
    }

    // Past this point the caller is provably the invited person (email matched),
    // so an already-claimed invite is theirs. If they have ALSO already finished
    // their health assessment they're a fully onboarded client revisiting an old
    // link — re-running claimInvite would reset assessment_complete to FALSE and
    // client_status back to 'invited', rewinding them into onboarding. Send them
    // in instead. Only reachable now that a self-claim no longer 410s above.
    if (alreadyClaimed && userRows[0]?.assessment_complete) {
      return res.json({ ok: true, redirect_to: '/dashboard' })
    }

    // Update user profile from invite data and mark the invite accepted.
    // Shared with the email-match auto-claim in getOrCreateUser() so both paths
    // leave the user in identical state. Safe to re-run for a self-claimed
    // invite: every column it writes is derived from the invite row, so a repeat
    // application is idempotent.
    await claimInvite(pool, invite, dbUserId)

    res.json({ ok: true, redirect_to: '/health-assessment' })
  } catch (err) { next(err) }
})

// ── Staff Invite routes ────────────────────────────────────────────────────────

// GET /api/staff-invites/:token — public, no auth required
router.get('/staff/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT token, email, first_name, last_name, role, expires_at, accepted_at
       FROM staff_invites WHERE token = $1`,
      [req.params.token],
    )
    if (!rows.length) return res.status(404).json({ error: 'Invite not found. The link may be invalid.' })

    const invite = rows[0]
    if (invite.accepted_at) {
      return res.status(410).json({ error: 'This invite has already been accepted.' })
    }
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return res.status(410).json({ error: 'This invite has expired. Please contact the admin.' })
    }

    res.json({
      first_name: invite.first_name,
      last_name:  invite.last_name,
      email:      invite.email,
      role:       invite.role,
    })
  } catch (err) { next(err) }
})

// POST /api/staff-invites/:token/accept — requires Clerk auth
router.post('/staff/:token/accept', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)

    const { rows: inviteRows } = await pool.query(
      `SELECT * FROM staff_invites WHERE token = $1`,
      [req.params.token],
    )
    if (!inviteRows.length) return res.status(404).json({ error: 'Invite not found.' })

    const invite = inviteRows[0]
    if (invite.accepted_at) {
      return res.status(410).json({ error: 'This invite has already been accepted.' })
    }
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
      return res.status(410).json({ error: 'This invite has expired. Please contact the admin.' })
    }

    const clerkEmail = await fetchClerkEmail(userId)
    const dbUserId   = await getOrCreateUser(userId, clerkEmail)

    const { rows: userRows } = await pool.query(
      'SELECT id, email FROM users WHERE id = $1',
      [dbUserId],
    )
    const resolvedEmail = (clerkEmail ?? userRows[0]?.email ?? '').trim().toLowerCase()
    const inviteEmail   = invite.email.trim().toLowerCase()

    if (!resolvedEmail) {
      return res.status(400).json({
        error: 'Could not verify your email address. Please try again or contact support.',
      })
    }
    if (resolvedEmail !== inviteEmail) {
      return res.status(403).json({
        error: `This invite was sent to ${invite.email}. Please sign out and sign back in with that email address.`,
        invite_email: invite.email,
      })
    }

    // Update user with staff profile — no onboarding/assessment required for staff.
    // org_id must always be carried from the invite here (not gated behind a
    // truthiness check) — a staff invite with no org_id left the new user's
    // org_id NULL forever, which then 403'd every request behind orgContext's
    // "Organization context could not be resolved" check until an admin
    // manually ran the client activate patch on them. COALESCE so a NULL
    // invite.org_id (a legacy invite created before staff/invite started
    // stamping it) never overwrites an already-resolved org_id with NULL.
    await pool.query(
      `UPDATE users
       SET first_name          = COALESCE(NULLIF(first_name, ''), $1),
           last_name           = COALESCE(NULLIF(last_name,  ''), $2),
           role                = $3,
           staff_status        = 'active',
           onboarding_complete = TRUE,
           assessment_complete = TRUE,
           paid                = TRUE,
           org_id              = COALESCE($5, org_id)
       WHERE id = $4`,
      [invite.first_name, invite.last_name, invite.role, dbUserId, invite.org_id],
    )

    await pool.query(
      `UPDATE staff_invites
       SET accepted_at = NOW(), accepted_by_user_id = $1
       WHERE id = $2`,
      [dbUserId, invite.id],
    )

    // Org owner invites (invite.org_id set, from organizations.js's
    // /:id/invite-owner) are the only path that creates the owning user for a
    // brand-new org — claim ownership here if the org doesn't already have
    // one. Never overwrites an existing owner_user_id.
    if (invite.org_id) {
      await pool.query(
        `UPDATE organizations SET owner_user_id = $1 WHERE id = $2 AND owner_user_id IS NULL`,
        [dbUserId, invite.org_id],
      )
    }

    res.json({ ok: true, redirect_to: '/admin/clients' })
  } catch (err) { next(err) }
})

export default router
