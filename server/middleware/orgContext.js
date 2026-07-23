import { getAuth } from '@clerk/express'
import { getOrCreateUserWithOrg, isAdminEmail } from '../db.js'

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
async function orgContext(req, res, next) {
  let internalUser
  try {
    const { userId } = getAuth(req)
    // Unauthenticated — leave org context unset and let the route's own
    // requireAuth() produce the 401. Not an org-resolution failure.
    if (!userId) return next()

    internalUser = await getOrCreateUserWithOrg(userId)
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

  console.error('[orgContext] no org_id resolved for user', internalUser?.id ?? '(unknown)')
  return res.status(403).json({ error: 'Organization context could not be resolved.' })
}

export default orgContext
