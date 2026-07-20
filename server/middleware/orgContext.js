import { getAuth } from '@clerk/express'
import { getOrCreateUserWithOrg } from '../db.js'

// Runs after clerkMiddleware() + blockDeactivatedClients on every mounted API
// router. Resolves the current user's org_id and attaches it to the request so
// downstream route handlers can read req.orgId / req.internalUser directly.
// Never blocks the request — on any failure it falls back to org_id = 1
// (Life Warrior Coaching, the seeded single-tenant org) and calls next().
async function orgContext(req, res, next) {
  try {
    const { userId } = getAuth(req)
    if (!userId) return next()

    const internalUser = await getOrCreateUserWithOrg(userId)
    req.internalUser = internalUser
    req.orgId = internalUser?.org_id ?? 1
  } catch (err) {
    console.error('[orgContext] failed to resolve org_id:', err.message)
    req.orgId = 1
  }
  next()
}

export default orgContext
