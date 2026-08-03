import { clerkClient } from '@clerk/express'

// Best-effort fetch of a Clerk user's primary email address.
//
// Returns null on any failure so callers can carry on without it rather than
// failing the whole request. Shared by the orgContext middleware and the
// /api/users/me route, which both need an email before getOrCreateUser can
// resolve a brand-new signup's org from a pending staff_invites/client_invites
// row — without one, org resolution is skipped entirely (see server/db.js).
//
// This is a network round-trip to Clerk, so only call it when the email is
// actually needed: an existing users row already carries its own copy.
export async function fetchClerkEmail(clerkUserId) {
  try {
    const u = await clerkClient.users.getUser(clerkUserId)
    return (
      u?.primaryEmailAddress?.emailAddress ??
      u?.emailAddresses?.[0]?.emailAddress ??
      null
    )
  } catch (err) {
    console.warn('[clerkEmail] failed to fetch Clerk email:', err.message)
    return null
  }
}
