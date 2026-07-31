// Server-side enforcement of the Health History gate. The React Router guard
// only stops navigation in the UI — any authenticated user with a valid Clerk
// token could otherwise call client data routes directly regardless of
// assessment_complete. Mounted after orgContext (needs req.internalUser).
//
// Coach/admin roles are exempt: staff need full access regardless of their
// own assessment state, and need to view/manage client data through these
// same routers.
function requireAssessmentComplete(req, res, next) {
  const user = req.internalUser
  if (!user) return next()

  if (user.role !== 'client') return next()

  if (!user.assessment_complete) {
    return res.status(403).json({ error: 'Please complete your Health History before continuing.' })
  }

  next()
}

export default requireAssessmentComplete
