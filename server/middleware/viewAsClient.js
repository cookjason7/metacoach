import { getAuth } from '@clerk/express'
import { pool } from '../db.js'
import { isAdminRole, canAccessClient } from '../lib/accessControl.js'

const VIEW_AS_HEADER = 'x-view-as-client-id'
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Read-only "view as client" support for the client-facing routers. Mounted after
// orgContext (needs req.internalUser / req.orgId) and before the router itself.
//
// Staff (admin/coach/staff role) can send an X-View-As-Client-Id header to have the
// request served as if it came from that client — canAccessClient() enforces the same
// admin-sees-org / coach-sees-own-roster rule used everywhere else in coach-admin.
// req.effectiveClerkUserId / req.effectiveUserId are what route handlers should read
// instead of getAuth(req).userId, so a valid view-as swaps identity transparently.
//
// Any failure to validate (non-staff caller, header absent, target not accessible,
// lookup error) falls back to the requester's own identity — never to a wider grant.
async function resolveViewAs(req, res, next) {
  const { userId: requesterClerkId } = getAuth(req)
  req.effectiveClerkUserId = requesterClerkId
  req.effectiveUserId = req.internalUser?.id ?? null
  req.viewAsActive = false

  const header = req.get(VIEW_AS_HEADER)
  if (!header) return next()

  const requester = req.internalUser
  if (!requester) return next()

  const role = requester.role
  const isStaff = isAdminRole(role) || role === 'coach' || role === 'staff'
  if (!isStaff) return next()

  const targetClientId = parseInt(header, 10)
  if (!Number.isInteger(targetClientId)) return next()

  try {
    const ctx = { dbUserId: requester.id, role, orgId: req.orgId, email: requester.email }
    const allowed = await canAccessClient(ctx, targetClientId)
    if (!allowed) return next()

    const { rows } = await pool.query('SELECT clerk_user_id FROM users WHERE id = $1', [targetClientId])
    if (!rows.length) return next()

    req.effectiveClerkUserId = rows[0].clerk_user_id
    req.effectiveUserId = targetClientId
    req.viewAsActive = true
    next()
  } catch (err) {
    console.error('[resolveViewAs] failed to resolve view-as target:', err.message)
    next()
  }
}

// Paired with resolveViewAs on the same routers. View mode is read-only: once a
// view-as target has been honored, reject any mutation before it reaches the route.
function blockWritesInViewMode(req, res, next) {
  if (req.viewAsActive && WRITE_METHODS.has(req.method)) {
    return res.status(403).json({
      error: 'Read-only while viewing as a client. Exit view-as mode to make changes.',
    })
  }
  next()
}

export { resolveViewAs, blockWritesInViewMode }
