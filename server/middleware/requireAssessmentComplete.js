// Server-side enforcement of the Health History / assessment_complete gate.
// Previously this was 100% client-side (React Router redirects only), so any
// authenticated user with a valid Clerk token could hit data routes directly
// regardless of assessment_complete. Runs after clerkMiddleware() + orgContext
// (which resolves req.internalUser from the users table) on client-facing data
// routers only — never on healthAssessment.js/users.js (a client must still be
// able to complete the assessment and check their own status) or on staff
// routers (coaches/admins need full access regardless of their own assessment
// state, and to manage client data).
function requireAssessmentComplete(req, res, next) {
  const user = req.internalUser
  // Unauthenticated — let the route's own requireAuth() produce the 401.
  if (!user) return next()
  // Only clients are gated; staff roles (admin/coach/staff/account_owner) pass through.
  if (user.role !== 'client') return next()
  if (user.assessment_complete) return next()
  return res.status(403).json({
    error: 'Please complete your health assessment before continuing.',
    code:  'ASSESSMENT_INCOMPLETE',
  })
}

export default requireAssessmentComplete
