import { Router } from 'express'
import { requireAuth, getAuth, clerkClient } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

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

// GET /api/client-invites/:token — public, no auth required
// Returns invite details if token is valid and not yet accepted/expired.
router.get('/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT token, email, first_name, last_name, coaching_type, expires_at, accepted_at
       FROM client_invites WHERE token = $1`,
      [req.params.token],
    )
    if (!rows.length) return res.status(404).json({ error: 'Invite not found. The link may be invalid.' })

    const invite = rows[0]
    if (invite.accepted_at) {
      return res.status(410).json({ error: 'This invite has already been accepted.' })
    }
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
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
    if (invite.accepted_at) {
      return res.status(410).json({ error: 'This invite has already been accepted.' })
    }
    if (invite.expires_at && new Date() > new Date(invite.expires_at)) {
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
      'SELECT id, email, role FROM users WHERE id = $1',
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

    // Update user profile from invite data without overwriting existing values.
    // coaching_type comes from the invite row (supports both 'vip' and 'ai').
    // client_status = 'invited' — stays invited until Health Assessment is completed,
    // at which point healthAssessment.js flips it to 'active'.
    await pool.query(
      `UPDATE users
       SET first_name          = COALESCE(NULLIF(first_name, ''), $1),
           last_name           = COALESCE(NULLIF(last_name,  ''), $2),
           coaching_type       = COALESCE($3, 'vip'),
           coaching_type_source = 'invite',
           assigned_coach_id   = COALESCE(assigned_coach_id, $4),
           onboarding_complete = TRUE,
           assessment_complete = FALSE,
           client_status       = 'invited',
           paid                = TRUE
       WHERE id = $5`,
      [invite.first_name, invite.last_name, invite.coaching_type, invite.assigned_coach_id, dbUserId],
    )

    // Mark invite accepted
    await pool.query(
      `UPDATE client_invites
       SET accepted_at = NOW(), accepted_by_user_id = $1
       WHERE id = $2`,
      [dbUserId, invite.id],
    )

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

    // Update user with staff profile — no onboarding/assessment required for staff
    await pool.query(
      `UPDATE users
       SET first_name          = COALESCE(NULLIF(first_name, ''), $1),
           last_name           = COALESCE(NULLIF(last_name,  ''), $2),
           role                = $3,
           staff_status        = 'active',
           onboarding_complete = TRUE,
           assessment_complete = TRUE,
           paid                = TRUE
       WHERE id = $4`,
      [invite.first_name, invite.last_name, invite.role, dbUserId],
    )

    await pool.query(
      `UPDATE staff_invites
       SET accepted_at = NOW(), accepted_by_user_id = $1
       WHERE id = $2`,
      [dbUserId, invite.id],
    )

    res.json({ ok: true, redirect_to: '/admin/clients' })
  } catch (err) { next(err) }
})

export default router
