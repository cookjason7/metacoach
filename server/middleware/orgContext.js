import { getAuth } from '@clerk/express'
import { getOrCreateUserWithOrg, findUserByClerkId, isAdminEmail } from '../db.js'
import { fetchClerkEmail } from '../services/clerkEmail.js'

// Runs after clerkMiddleware() + blockDeactivatedClients on every mounted API
// router. Resolves the current user's org_id and attaches it to the request so
// downstream route handlers can read req.orgId / req.internalUser directly.
//
// Fails CLOSED. This is a tenant-isolation boundary: previously any failure
// (a thrown lookup, or a users row with org_id IS NULL — the column is nullable
// and was only backfilled once at migration time) silently fell back to
// org_id = 1, which is Life Warrior Coaching's own org. That handed a user with
// unresolvable org context a full read of the largest tenant's data. Now an
// unresolvable org is a 403 and req.orgId is left unset, so no downstream
// handler can bind a wrong-but-plausible org id.
//
// The only exception is the platform super admin (ADMIN_EMAILS): those accounts
// legitimately operate across orgs and are expected to sit in org 1, so they
// keep the org-1 default rather than being locked out of their own console.
//
// Distinct from that: a signup still awaiting an org (pending_access, org_id
// NULL) is passed through with req.orgId left unset — see the block at the
// bottom. That is an expected pre-assignment state, not a failed resolution,
// and it is still never defaulted to an org.
async function orgContext(req, res, next) {
  let internalUser
  try {
    const { userId } = getAuth(req)
    // Unauthenticated — leave org context unset and let the route's own
    // requireAuth() produce the 401. Not an org-resolution failure.
    if (!userId) return next()

    // Peek at the row first (read-only) to decide whether this request needs an
    // email. getOrCreateUser resolves a new signup's org from a pending
    // staff_invites/client_invites row matched on email, and skips resolution
    // entirely when called without one — so creating the row here email-less
    // stranded every new signup at org_id NULL, which then 403'd below on this
    // very middleware, including on /api/users/me. That left no route able to
    // backfill the email afterwards, making the lockout permanent.
    //
    // The Clerk round-trip is therefore done only when it can actually change
    // the outcome: no row yet, or a row still unassigned. An existing row that
    // already has an org takes the fast path and costs one indexed lookup,
    // and an unassigned row with a stored email reuses it rather than
    // re-querying Clerk.
    const existing = await findUserByClerkId(userId)
    const email = existing?.org_id != null
      ? null
      : (existing?.email ?? await fetchClerkEmail(userId))

    internalUser = await getOrCreateUserWithOrg(userId, email)
  } catch (err) {
    console.error('[orgContext] failed to resolve org_id:', err.message)
    return res.status(403).json({ error: 'Organization context could not be resolved.' })
  }

  req.internalUser = internalUser

  if (internalUser?.org_id != null) {
    req.orgId = internalUser.org_id
    return next()
  }

  if (isAdminEmail(internalUser?.email)) {
    req.orgId = 1
    return next()
  }

  // Legitimately unassigned, not a resolution failure: a signup with no matching
  // invite is held at pending_access with org_id NULL *by design* (getOrCreateUser
  // deliberately stopped defaulting these to org 1, which used to hide every other
  // tenant's self-signups inside LWC's org). Such a user has no org to bind yet.
  //
  // 403-ing them here broke the gate itself — the client learns to redirect to
  // /pending-access from GET /api/users/me, which sits behind this middleware, so
  // the response they needed in order to be told "waiting for approval" was the
  // one being refused. They saw a generic connection error with no way forward.
  //
  // req.orgId is deliberately left UNSET rather than defaulted to any org: an
  // org-scoped query binding undefined/NULL matches nothing, so this fails closed.
  // requireAssessmentComplete independently blocks these accounts (role 'client',
  // assessment_complete false) from every router except /api/users, whose three
  // routes are all self-scoped by the caller's own row.
  if (internalUser?.client_status === 'pending_access') {
    req.orgUnassigned = true
    return next()
  }

  console.error('[orgContext] no org_id resolved for user', internalUser?.id ?? '(unknown)')
  return res.status(403).json({ error: 'Organization context could not be resolved.' })
}

export default orgContext
